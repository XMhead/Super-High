<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { CalendarDays, Check, ClipboardPaste, Copy, Eye, EyeOff, Link, Maximize, NotebookPen, Plus, Search, Trash2, X, ZoomIn, ZoomOut } from 'lucide-vue-next'

import { renderMarkdown } from '@/lib/markdown'
import { backend, isTauri, onMemoCliRequest, type MemoCliRequest } from '@/lib/tauri'
import {
  findTerminalFilePathMatches,
  type TerminalFilePathMatch,
  type TerminalPathTarget,
} from '@/lib/terminalFileLinks'
import { useWorkspaceStore } from '@/stores/workspace'
import type { MemoRecord } from '@/types'

const store = useWorkspaceStore()
const DEFAULT_WIDTH = 1040
const DEFAULT_HEIGHT = 720
const MIN_WIDTH = 680
const MIN_HEIGHT = 360
const TOP_BOUNDARY = 76
const STATUS_BAR_HEIGHT = 22
const resizeEdges = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const

type ResizeEdge = typeof resizeEdges[number]
type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const notes = ref<MemoRecord[]>([])
const selectedId = ref('')
const query = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const selectedCategory = ref('')
const categories = ref<string[]>([])
const newCategory = ref('')
const loading = ref(false)
const creating = ref(false)
const deleting = ref(false)
const loaded = ref(false)
const error = ref('')
const saveStatus = ref<SaveStatus>('idle')
const previewMode = ref(false)
const copyStatus = ref<'idle' | 'copying' | 'copied' | 'error'>('idle')
const addingLinks = ref(false)
const dateMenuOpen = ref(false)
const dateControl = ref<HTMLElement | null>(null)
const windowRoot = ref<HTMLElement | null>(null)
const frame = reactive({ left: 0, top: 76, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
const previewLinks = ref<Array<{ match: TerminalFilePathMatch, target: TerminalPathTarget }>>([])
const previewImagePaths = ref<string[]>([])
const attachmentUrls = reactive<Record<string, string>>({})
const imagePreviewPath = ref('')
const imagePreviewUrl = ref('')
const imageStage = ref<HTMLElement | null>(null)
const imageScale = ref(1)
const imageNaturalSize = reactive({ width: 0, height: 0 })
let imagePan: { x: number, y: number, left: number, top: number } | null = null

const selectedMemo = computed(() => notes.value.find((note) => note.id === selectedId.value) ?? null)
const attachmentPaths = computed(() => selectedMemo.value?.attachments ?? [])
const copyLabel = computed(() => copyStatus.value === 'copied' ? '已复制正文' : copyStatus.value === 'error' ? '复制失败，请重试' : '复制正文')
const activeCliSession = computed(() => store.activeCliTerminalSession)
const canInsertMemo = computed(() => {
  const session = activeCliSession.value
  return !!session
})

async function memoTextForCli(note: MemoRecord) {
  const resolvedImages = await Promise.all(note.attachments.map(async (path) => {
    if (/^(?:[a-z]:[\\/]|[\\\\]{1,2})/i.test(path)) return path
    return (await backend.resolveTerminalPath(path).catch(() => null))?.path ?? path
  }))
  return [note.content, ...resolvedImages].filter(Boolean).join('\n')
}

async function copyCurrentMemo() {
  const note = selectedMemo.value
  if (!note || (!note.content && !note.attachments.length) || copyStatus.value === 'copying') return
  const { id, content } = note
  copyStatus.value = 'copying'
  try {
    const copied = await memoTextForCli(note)
    await navigator.clipboard.writeText(copied)
    if (selectedId.value === id && selectedMemo.value?.content === content) copyStatus.value = 'copied'
  } catch {
    if (selectedId.value === id && selectedMemo.value?.content === content) copyStatus.value = 'error'
  }
}

async function insertMemoIntoCli() {
  const note = selectedMemo.value
  const session = activeCliSession.value
  if (!note || !session || !canInsertMemo.value) return
  try {
    const text = await memoTextForCli(note)
    if (!text.trim()) return
    store.insertIntoTerminalDraft(session.id, text)
    store.setActiveTerminalSession(session.id)
    window.dispatchEvent(new Event('superhigh:focus-cli-input'))
    store.showActivityMessage('已插入备忘录内容到 CLI 输入框')
  } catch (caught) {
    error.value = `插入 CLI 输入框失败：${formatError(caught)}`
  }
}

watch(() => [selectedId.value, selectedMemo.value?.content, selectedMemo.value?.attachments], () => { copyStatus.value = 'idle' })
const hasDateFilter = computed(() => !!dateFrom.value || !!dateTo.value)
const quickDateFilters = [7, 14, 30] as const
const activeQuickDateFilter = computed(() => quickDateFilters.find((days) => {
  const today = dateInputValue(new Date())
  return dateFrom.value === dateInputValue(addDays(new Date(), -(days - 1))) && dateTo.value === today
}) ?? null)
const frameStyle = computed(() => ({
  left: `${frame.left}px`,
  top: `${frame.top}px`,
  width: `${frame.width}px`,
  height: `${frame.height}px`,
}))
const saveStatusText = computed(() => {
  if (saveStatus.value === 'dirty') return '等待保存'
  if (saveStatus.value === 'saving') return '正在保存...'
  if (saveStatus.value === 'saved') return '已保存'
  if (saveStatus.value === 'error') return '保存失败'
  return ''
})

let loadTimer: number | null = null
let saveTimer: number | null = null
let loadSequence = 0
let saveInFlight: Promise<boolean> | null = null
let needsSave = false
let activePointer: {
  mode: 'drag' | 'resize'
  startX: number
  startY: number
  left: number
  top: number
  width: number
  height: number
  edge?: ResizeEdge
} | null = null

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`
}

function displayTitle(note: MemoRecord) {
  return note.title.trim() || formatTimestamp(note.createdAt)
}

function displayDescription(note: MemoRecord) {
  return note.content
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*`~]/g, '')
    .replace(/(^|\s)_{1,2}(.+?)_{1,2}(?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function extractWebUrls(value: string): string[] {
  const urls = value.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
  return [...new Set(urls.map((url) => {
    let result = url.replace(/[.,;!?，。；！？]+$/, '')
    while ((result.endsWith(')') && result.split(')').length > result.split('(').length)
      || (result.endsWith(']') && result.split(']').length > result.split('[').length)
      || (result.endsWith('}') && result.split('}').length > result.split('{').length)) result = result.slice(0, -1)
    return result
  }))].filter((url) => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch { return false }
  })
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]`\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || '网页链接'
}

async function addWebLinks() {
  const note = selectedMemo.value
  if (!note || addingLinks.value) return
  addingLinks.value = true
  error.value = ''
  try {
    const clipboardText = await navigator.clipboard.readText()
    const urls = extractWebUrls(clipboardText)
    if (!urls.length) {
      error.value = '剪贴板中没有找到网页链接'
      return
    }
    const titled = await backend.fetchWebpageTitles(urls)
    const lines = titled.map(({ url, title }) => `[${escapeMarkdownLabel(title || url)}](${url})`)
    const textarea = windowRoot.value?.querySelector<HTMLTextAreaElement>('.memo-content-input')
    const cursor = textarea && textarea.selectionStart >= 0 ? textarea.selectionStart : note.content.length
    const before = note.content.slice(0, cursor).replace(/\s*$/, '')
    const after = note.content.slice(cursor).replace(/^\s*/, '')
    const prefix = before ? `${before}\n` : ''
    const suffix = after ? `\n${after}` : ''
    note.content = `${prefix}${lines.join('\n')}${suffix}`
    markDirty()
    await nextTick()
    const nextCursor = prefix.length + lines.join('\n').length
    const nextTextarea = windowRoot.value?.querySelector<HTMLTextAreaElement>('.memo-content-input')
    nextTextarea?.focus()
    nextTextarea?.setSelectionRange(nextCursor, nextCursor)
  } catch (caught) {
    error.value = `添加网页链接失败：${formatError(caught)}`
  } finally {
    addingLinks.value = false
  }
}

const WEB_URL_PATTERN = /^https?:\/\//i

// Link plain-text local paths that terminal matching resolved; Markdown links,
// inline code and code blocks keep their own rendering.
function linkResolvedPaths(root: DocumentFragment, workspaceRoot: string) {
  const indexByText = new Map<string, number>()
  previewLinks.value.forEach(({ match, target }, index) => {
    if (!WEB_URL_PATTERN.test(target.path) && !indexByText.has(match.text)) indexByText.set(match.text, index)
  })
  if (!indexByText.size) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('a, code, pre')) textNodes.push(node as Text)
  }
  for (const node of textNodes) {
    const text = node.data
    const matches = findTerminalFilePathMatches(text, workspaceRoot).filter((match) => indexByText.has(match.text))
    if (!matches.length) continue
    const fragment = document.createDocumentFragment()
    let offset = 0
    for (const match of matches) {
      if (match.start < offset) continue
      fragment.append(text.slice(offset, match.start))
      const anchor = document.createElement('a')
      anchor.href = '#'
      anchor.dataset.terminalLinkIndex = String(indexByText.get(match.text))
      anchor.textContent = match.text
      fragment.append(anchor)
      offset = match.end
    }
    fragment.append(text.slice(offset))
    node.replaceWith(fragment)
  }
}

const previewContent = computed(() => {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(selectedMemo.value?.content ?? '', { escapeRawHtml: true })
  const fragment = template.content
  fragment.querySelectorAll('img').forEach((image) => {
    const path = (image.getAttribute('src') ?? '').trim().replace(/^<|>$/g, '')
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'memo-image-preview-trigger'
    trigger.dataset.memoImageClickPath = path
    const replacement = document.createElement('img')
    replacement.dataset.memoImagePath = path
    replacement.alt = image.getAttribute('alt') || '备忘录图片'
    if (attachmentUrls[path]) replacement.src = attachmentUrls[path]
    trigger.append(replacement)
    image.replaceWith(trigger)
  })
  fragment.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? ''
    anchor.dataset.memoHref = href
    if (WEB_URL_PATTERN.test(href)) {
      anchor.target = '_blank'
      anchor.rel = 'noopener'
    }
  })
  linkResolvedPaths(fragment, store.workspace?.rootPath ?? '')
  return template.innerHTML
})

let previewLinkSequence = 0
watch([
  () => selectedMemo.value?.content ?? '',
  () => store.workspace?.rootPath ?? '',
  previewMode,
], async ([content, workspaceRoot, preview]) => {
  const sequence = ++previewLinkSequence
  if (!preview || !content) {
    previewLinks.value = []
    return
  }
  const matches = findTerminalFilePathMatches(content, workspaceRoot)
  const resolved = await Promise.all(matches.map(async (match) => {
    if (/^https?:\/\//i.test(match.path)) {
      return { match, target: { path: match.path, isFile: true } }
    }
    const target = await backend.resolveTerminalPath(match.path).catch(() => null)
    return target ? { match, target } : null
  }))
  if (sequence !== previewLinkSequence) return
  previewLinks.value = resolved.filter((link): link is { match: TerminalFilePathMatch, target: TerminalPathTarget } => !!link)
})

async function openPreviewLink(event: MouseEvent) {
  const image = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-memo-image-click-path]') : null
  if (image) {
    const path = image.dataset.memoImageClickPath
    if (path) await openMemoImage(path)
    return
  }
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null
  if (!anchor) return
  event.preventDefault()
  const href = anchor.dataset.memoHref ?? ''
  if (href.startsWith('#')) return
  if (WEB_URL_PATTERN.test(href)) {
    try {
      await backend.openUrl(href)
    } catch (caught) {
      store.showErrorMessage(`打开网页失败：${formatError(caught)}`)
    }
    return
  }
  const link = anchor.dataset.terminalLinkIndex !== undefined
    ? previewLinks.value[Number(anchor.dataset.terminalLinkIndex)]?.target
    : href ? await backend.resolveTerminalPath(href).catch(() => null) : null
  if (!link) {
    if (href) store.showErrorMessage(`未找到路径：${href}`)
    return
  }
  try {
    if (link.isFile) await store.openTerminalFileLink(link.path)
    else await store.openPath(link.path)
  } catch (caught) {
    store.showErrorMessage(`打开路径失败：${formatError(caught)}`)
  }
}

function dateBoundary(value: string, nextDay = false) {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString()
}

function addDays(date: Date, days: number) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function dateInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function applyQuickDateFilter(days: typeof quickDateFilters[number]) {
  const today = new Date()
  dateFrom.value = dateInputValue(addDays(today, -(days - 1)))
  dateTo.value = dateInputValue(today)
  dateMenuOpen.value = false
}

async function loadMemos(preferredId?: string) {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await backend.listMemos({
      text: query.value.trim() || undefined,
      createdFrom: dateBoundary(dateFrom.value),
      createdBefore: dateBoundary(dateTo.value, true),
      category: selectedCategory.value || undefined,
    })
    if (sequence !== loadSequence) return
    notes.value = result
    const nextId = preferredId || selectedId.value
    selectedId.value = result.some((note) => note.id === nextId) ? nextId : (result[0]?.id ?? '')
    loaded.value = true
    saveStatus.value = 'idle'
  } catch (caught) {
    if (sequence !== loadSequence) return
    error.value = formatError(caught)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function scheduleLoad() {
  if (!loaded.value) return
  if (loadTimer != null) window.clearTimeout(loadTimer)
  loadTimer = window.setTimeout(() => {
    loadTimer = null
    void flushSave().then((saved) => {
      if (saved) return loadMemos()
    })
  }, 220)
}

function markDirty() {
  needsSave = true
  saveStatus.value = 'dirty'
  if (saveTimer != null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, 400)
}

async function flushSave(): Promise<boolean> {
  if (saveTimer != null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saveInFlight) {
    const saved = await saveInFlight
    if (!saved || !needsSave) return saved
  }
  const note = selectedMemo.value
  if (!needsSave || !note) return true
  const snapshot = { title: note.title, content: note.content, category: note.category || '', attachments: [...note.attachments] }
  needsSave = false
  saveStatus.value = 'saving'
  error.value = ''
  saveInFlight = backend.updateMemo(note.id, snapshot.title, snapshot.content, snapshot.category, snapshot.attachments)
    .then((saved) => {
      if (note.title === snapshot.title && note.content === snapshot.content && (note.category || '') === snapshot.category && note.attachments.join('\0') === snapshot.attachments.join('\0')) {
        Object.assign(note, saved)
        saveStatus.value = 'saved'
      } else {
        note.updatedAt = saved.updatedAt
        needsSave = true
        saveStatus.value = 'dirty'
      }
      return true
    })
    .catch((caught) => {
      needsSave = true
      saveStatus.value = 'error'
      error.value = `保存失败：${formatError(caught)}`
      return false
    })
    .finally(() => {
      saveInFlight = null
    })
  const saved = await saveInFlight
  if (saved && needsSave) return flushSave()
  return saved
}

async function createMemo() {
  if (creating.value || !(await flushSave())) return
  creating.value = true
  error.value = ''
  query.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  dateMenuOpen.value = false
  try {
    const created = selectedCategory.value ? await backend.createMemo(selectedCategory.value) : await backend.createMemo()
    previewMode.value = false
    await loadMemos(created.id)
    await nextTick()
    windowRoot.value?.querySelector<HTMLTextAreaElement>('.memo-content-input')?.focus()
  } catch (caught) {
    error.value = `新增失败：${formatError(caught)}`
  } finally {
    creating.value = false
  }
}

async function loadCategories() {
  if (typeof backend.listMemoCategories !== 'function') return
  try { categories.value = await backend.listMemoCategories() } catch { /* keep the editor usable */ }
}

async function createCategory() {
  const value = newCategory.value.trim()
  if (!value || typeof backend.createMemoCategory !== 'function') return
  try {
    categories.value = await backend.createMemoCategory(value)
    newCategory.value = ''
    selectedCategory.value = value
    await loadMemos()
  } catch (caught) { error.value = `分类创建失败：${formatError(caught)}` }
}

async function setCategory(category: string) {
  if (selectedCategory.value === category) return
  if (!(await flushSave())) return
  selectedCategory.value = category
  await loadMemos()
}

async function attachClipboardImage(event: ClipboardEvent) {
  const note = selectedMemo.value
  const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith('image/'))
  if (!note || !item) return
  const blob = item.getAsFile()
  if (!blob) return
  event.preventDefault()
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('读取剪贴板图片失败'))
      reader.readAsDataURL(blob)
    })
    const root = store.workspace?.rootPath || (await backend.getAppStorageInfo()).dataDir
    const path = await backend.saveMemoImage(root, dataUrl, `memo-${note.id}`)
    note.attachments.push(path)
    markDirty()
  } catch (caught) { error.value = `图片附件保存失败：${formatError(caught)}` }
}

async function preparePreviewImages() {
  const contentImages = Array.from(windowRoot.value?.querySelectorAll<HTMLImageElement>('.memo-content-preview img[data-memo-image-path]') ?? [])
    .map((image) => image.dataset.memoImagePath ?? '')
    .filter((path) => path && !attachmentUrls[path])
  const paths = [...new Set([...attachmentPaths.value, ...contentImages])]
  previewImagePaths.value = paths
  await Promise.all(paths.map(async (path) => {
    try {
      const url = await backend.readImageAsDataUrl(path)
      attachmentUrls[path] = url
      windowRoot.value?.querySelectorAll<HTMLImageElement>('img[data-memo-image-path]').forEach((image) => {
        if (image.dataset.memoImagePath === path) image.src = url
      })
    } catch { /* keep path visible when the file is unavailable */ }
  }))
}

async function openMemoImage(path: string) {
  imagePreviewPath.value = path
  imagePreviewUrl.value = attachmentUrls[path] || await backend.readImageAsDataUrl(path).catch(() => '')
  imageScale.value = 1
  imageNaturalSize.width = 0
  imageNaturalSize.height = 0
}

function fitImage() {
  const stage = imageStage.value
  if (!stage || !imageNaturalSize.width || !imageNaturalSize.height) return
  imageScale.value = Math.min(1, (stage.clientWidth - 24) / imageNaturalSize.width, (stage.clientHeight - 24) / imageNaturalSize.height)
  stage.scrollTo(0, 0)
}

function onImageLoad(event: Event) {
  const image = event.target as HTMLImageElement
  imageNaturalSize.width = image.naturalWidth
  imageNaturalSize.height = image.naturalHeight
  fitImage()
}

function zoomImage(factor: number) {
  imageScale.value = Math.min(8, Math.max(0.05, imageScale.value * factor))
}

function onImageWheel(event: WheelEvent) {
  zoomImage(event.deltaY < 0 ? 1.2 : 1 / 1.2)
}

function startImagePan(event: PointerEvent) {
  const stage = imageStage.value
  if (!stage) return
  imagePan = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }
  stage.setPointerCapture(event.pointerId)
}

function moveImagePan(event: PointerEvent) {
  const stage = imageStage.value
  if (!stage || !imagePan) return
  stage.scrollLeft = imagePan.left - (event.clientX - imagePan.x)
  stage.scrollTop = imagePan.top - (event.clientY - imagePan.y)
}

async function selectMemo(id: string) {
  if (id === selectedId.value || !(await flushSave())) return
  selectedId.value = id
  saveStatus.value = 'idle'
}

async function deleteSelectedMemo() {
  const note = selectedMemo.value
  if (!note || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await backend.deleteMemo(note.id)
    const index = notes.value.findIndex((item) => item.id === note.id)
    notes.value.splice(index, 1)
    selectedId.value = notes.value[Math.min(index, notes.value.length - 1)]?.id ?? ''
    needsSave = false
    saveStatus.value = 'idle'
  } catch (caught) {
    error.value = `删除失败：${formatError(caught)}`
  } finally {
    deleting.value = false
  }
}

async function closeWindow() {
  if (!(await flushSave())) return
  store.setMemoWindowOpen(false)
}

function clearDateFilter() {
  dateFrom.value = ''
  dateTo.value = ''
  dateMenuOpen.value = false
}

function normalizeFrame() {
  const viewportWidth = Math.max(320, window.innerWidth)
  const viewportBottom = Math.max(TOP_BOUNDARY + 240, window.innerHeight - STATUS_BAR_HEIGHT)
  const availableHeight = viewportBottom - TOP_BOUNDARY
  const minWidth = Math.min(MIN_WIDTH, viewportWidth)
  const minHeight = Math.min(MIN_HEIGHT, availableHeight)
  frame.width = Math.min(viewportWidth, Math.max(minWidth, frame.width))
  frame.height = Math.min(availableHeight, Math.max(minHeight, frame.height))
  frame.left = Math.min(Math.max(0, frame.left), Math.max(0, viewportWidth - frame.width))
  frame.top = Math.min(Math.max(TOP_BOUNDARY, frame.top), Math.max(TOP_BOUNDARY, viewportBottom - frame.height))
}

function restoreFrame() {
  const saved = store.settings.memoWindowFrame
  frame.width = typeof saved?.width === 'number' && Number.isFinite(saved.width) ? saved.width : DEFAULT_WIDTH
  frame.height = typeof saved?.height === 'number' && Number.isFinite(saved.height) ? saved.height : DEFAULT_HEIGHT
  frame.left = typeof saved?.left === 'number' && Number.isFinite(saved.left)
    ? saved.left
    : Math.max(16, window.innerWidth - frame.width - 20)
  frame.top = typeof saved?.top === 'number' && Number.isFinite(saved.top) ? saved.top : 76
  normalizeFrame()
}

function persistFrame() {
  store.setMemoWindowFrame({ ...frame }, true)
}

function startPointer(mode: 'drag' | 'resize', event: PointerEvent, edge?: ResizeEdge) {
  event.preventDefault()
  activePointer = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    edge,
  }
  window.addEventListener('pointermove', movePointer)
  window.addEventListener('pointerup', stopPointer)
}

function movePointer(event: PointerEvent) {
  if (!activePointer) return
  const deltaX = event.clientX - activePointer.startX
  const deltaY = event.clientY - activePointer.startY
  if (activePointer.mode === 'drag') {
    frame.left = activePointer.left + deltaX
    frame.top = activePointer.top + deltaY
    normalizeFrame()
    return
  }
  const edge = activePointer.edge ?? 'se'
  let nextLeft = activePointer.left
  let nextTop = activePointer.top
  let nextWidth = activePointer.width
  let nextHeight = activePointer.height
  if (edge.includes('e')) nextWidth = activePointer.width + deltaX
  if (edge.includes('s')) nextHeight = activePointer.height + deltaY
  if (edge.includes('w')) {
    nextWidth = activePointer.width - deltaX
    nextLeft = activePointer.left + deltaX
  }
  if (edge.includes('n')) {
    nextHeight = activePointer.height - deltaY
    nextTop = activePointer.top + deltaY
  }
  frame.left = nextLeft
  frame.top = nextTop
  frame.width = nextWidth
  frame.height = nextHeight
  normalizeFrame()
}

function stopPointer() {
  if (!activePointer) return
  activePointer = null
  window.removeEventListener('pointermove', movePointer)
  window.removeEventListener('pointerup', stopPointer)
  persistFrame()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!dateMenuOpen.value || dateControl.value?.contains(event.target as Node)) return
  dateMenuOpen.value = false
}

function formatError(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

function cliState() {
  return {
    open: store.memoWindowOpen,
    selectedId: selectedId.value || null,
    mode: previewMode.value ? 'preview' : 'edit',
    frame: { ...frame },
    filter: { query: query.value, from: dateFrom.value, to: dateTo.value, category: selectedCategory.value },
    image: imagePreviewPath.value ? { path: imagePreviewPath.value, scale: imageScale.value * 100 } : null,
  }
}

async function selectCliMemo(id: string) {
  query.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  selectedCategory.value = ''
  await loadMemos(id)
  if (error.value) throw new Error(error.value)
  if (selectedId.value !== id) throw new Error(`备忘录不存在：${id}`)
}

async function runMemoCli(request: MemoCliRequest): Promise<unknown> {
  if (!(await flushSave())) throw new Error(error.value || '备忘录保存失败')
  const op = request.operation.slice('memo.'.length)
  const options = request.options
  if (op === 'status') return cliState()
  if (op === 'close') {
    await closeWindow()
    return cliState()
  }
  const uiOperations = ['open', 'select', 'mode', 'filter', 'frame', 'copy', 'paste', 'insert', 'image-open', 'image-close', 'image-fit', 'image-zoom', 'image-pan']
  if (!uiOperations.includes(op)) {
    let dataRequest = request
    if (op === 'list' && options.days) {
      const { days, ...boundaries } = options
      dataRequest = { ...request, options: {
        ...boundaries,
        from: dateBoundary(dateInputValue(addDays(new Date(), -(Number(days) - 1))))!,
        before: dateBoundary(dateInputValue(new Date()), true)!,
      } }
    }
    const result = await backend.memoCliData(dataRequest)
    const reads = ['list', 'get', 'text', 'category-list', 'attachment-list']
    if (!reads.includes(op)) {
      if (op === 'category-rename' && selectedCategory.value === options.name) selectedCategory.value = options['new-name']!.trim()
      if (op === 'category-delete' && selectedCategory.value === options.name) selectedCategory.value = ''
      await loadCategories()
      if (op === 'create') {
        previewMode.value = false
        await selectCliMemo((result as MemoRecord).id)
      } else {
        await loadMemos()
      }
      if (error.value) throw new Error(error.value)
    }
    return result
  }
  if (!store.workspace) throw new Error('请先打开工作区')
  if (op === 'open' || op === 'select') {
    store.setMemoWindowOpen(true)
    await nextTick()
    if (options.id) await selectCliMemo(options.id)
    else await loadMemos()
    previewMode.value = options.mode === 'preview'
  } else if (op === 'mode') {
    previewMode.value = options.mode === 'preview'
  } else if (op === 'filter') {
    for (const key of ['from', 'to'] as const) {
      const value = options[key]
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || dateInputValue(new Date(`${value}T12:00:00`)) !== value)) throw new Error(`--${key} 日期无效`)
    }
    if (options.from && options.to && options.from > options.to) throw new Error('起始日期不能晚于结束日期')
    query.value = options.query ?? ''
    selectedCategory.value = options.category ?? ''
    dateFrom.value = options.from ?? ''
    dateTo.value = options.to ?? ''
    if (options.days) {
      dateFrom.value = dateInputValue(addDays(new Date(), -(Number(options.days) - 1)))
      dateTo.value = dateInputValue(new Date())
    }
    await loadMemos()
  } else if (op === 'frame') {
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      if (options[key] !== undefined) frame[key] = Number(options[key])
    }
    normalizeFrame()
    persistFrame()
  } else if (op.startsWith('image-') && op !== 'image-open') {
    if (!imagePreviewPath.value) throw new Error('尚未打开图片预览')
    if (op === 'image-close') imagePreviewPath.value = ''
    if (op === 'image-fit') fitImage()
    if (op === 'image-zoom') imageScale.value = Math.min(8, Math.max(0.05, Number(options.scale) / 100))
    if (op === 'image-pan') imageStage.value?.scrollTo(Number(options.left ?? 0), Number(options.top ?? 0))
  } else {
    await selectCliMemo(options.id!)
    if (op === 'copy') {
      await copyCurrentMemo()
      if (copyStatus.value !== 'copied') throw new Error(copyLabel.value)
    } else if (op === 'insert') {
      if (!canInsertMemo.value) throw new Error('没有可插入的活动 CLI 会话')
      await insertMemoIntoCli()
    } else if (op === 'paste') {
      previewMode.value = false
      const note = selectedMemo.value!
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
          const root = store.workspace.rootPath
          note.attachments.push(await backend.saveMemoImage(root, dataUrl, `memo-${note.id}`))
        } else if (item.types.includes('text/plain')) {
          note.content += await (await item.getType('text/plain')).text()
        }
      }
      markDirty()
      if (!(await flushSave())) throw new Error(error.value)
    } else if (op === 'image-open') {
      if (!selectedMemo.value?.attachments.includes(options.path!)) throw new Error('该图片不是当前备忘录的附件')
      store.setMemoWindowOpen(true)
      await openMemoImage(options.path!)
      if (!imagePreviewUrl.value) throw new Error('图片读取失败')
      await nextTick()
      const image = windowRoot.value?.querySelector<HTMLImageElement>('.memo-image-stage img')
      if (image && !image.complete) await image.decode()
      if (image && image.naturalWidth) onImageLoad({ target: image } as unknown as Event)
    }
  }
  if (error.value) throw new Error(error.value)
  await nextTick()
  return cliState()
}

let memoCliCleanup: (() => void) | null = null
let memoCliQueue = Promise.resolve()
let memoMounted = false

watch([query, dateFrom, dateTo, selectedCategory], scheduleLoad)
watch([() => selectedMemo.value?.attachments, previewMode], () => { void nextTick(preparePreviewImages) }, { deep: true })
watch(() => store.memoWindowOpen, (open) => {
  if (!open) {
    dateMenuOpen.value = false
    void flushSave()
    return
  }
  previewMode.value = false
  restoreFrame()
  void loadMemos()
  void loadCategories()
})

onMounted(() => {
  memoMounted = true
  if (isTauri()) void onMemoCliRequest((event) => {
    memoCliQueue = memoCliQueue.then(async () => {
      try {
        const result = await runMemoCli(event.request)
        await backend.memoCliComplete(event.id, result)
      } catch (caught) {
        await backend.memoCliComplete(event.id, null, formatError(caught))
      }
    }).catch((caught) => { error.value = formatError(caught) })
  }).then((cleanup) => {
    if (memoMounted) {
      memoCliCleanup = cleanup
      void backend.memoCliReady(true)
    }
    else cleanup()
  })
  restoreFrame()
  window.addEventListener('resize', normalizeFrame)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  if (store.memoWindowOpen) void loadMemos()
  void loadCategories()
})

onBeforeUnmount(() => {
  memoMounted = false
  memoCliCleanup?.()
  if (isTauri()) void backend.memoCliReady(false)
  if (loadTimer != null) window.clearTimeout(loadTimer)
  if (saveTimer != null) window.clearTimeout(saveTimer)
  void flushSave()
  stopPointer()
  window.removeEventListener('resize', normalizeFrame)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})
</script>

<template>
  <section ref="windowRoot" class="memo-window" aria-label="备忘录" :style="frameStyle">
    <header class="memo-titlebar" @pointerdown="startPointer('drag', $event)">
      <span class="memo-window-title"><NotebookPen :size="14" />备忘录</span>
      <div class="memo-titlebar-actions" @pointerdown.stop>
        <button type="button" title="关闭备忘录" @click="closeWindow">
          <X :size="15" />
        </button>
      </div>
    </header>

    <div class="memo-body">
      <aside class="memo-categories" aria-label="备忘录分类">
        <div class="memo-category-list">
          <button type="button" :class="{ active: !selectedCategory }" @click="setCategory('')"><span>全部</span></button>
          <button v-for="category in categories" :key="category" type="button" :title="category" :class="{ active: selectedCategory === category }" @click="setCategory(category)"><span>{{ category }}</span></button>
        </div>
        <div class="memo-category-create">
          <input v-model="newCategory" class="memo-category-input" type="text" placeholder="新分类" aria-label="新分类" @keydown.enter.prevent="createCategory" />
          <button class="memo-category-add" type="button" title="创建分类" :disabled="!newCategory.trim()" @click="createCategory"><Plus :size="16" /></button>
        </div>
      </aside>

      <main class="memo-editor">
        <template v-if="selectedMemo">
          <div class="memo-editor-heading">
            <input
              v-model="selectedMemo.title"
              class="memo-title-input"
              type="text"
              placeholder="标题（可选）"
              aria-label="备忘录标题"
              @input="markDirty"
              @blur="flushSave"
            />
          </div>
          <div class="memo-editor-actions" aria-label="备忘录操作">
            <button
              class="memo-preview-button"
              :class="{ active: previewMode }"
              type="button"
              :title="previewMode ? '返回编辑模式' : '预览正文，网页链接可点击打开'"
              @click="previewMode = !previewMode"
            >
              <EyeOff v-if="previewMode" :size="13" />
              <Eye v-else :size="13" />
              <span>{{ previewMode ? '编辑' : '预览' }}</span>
            </button>
            <button
              class="memo-add-links-button"
              type="button"
              title="从剪贴板添加网页链接"
              aria-label="从剪贴板添加网页链接"
              :disabled="addingLinks"
              @click="addWebLinks"
            >
              <Link :size="14" />
            </button>
            <button
              class="memo-copy-button"
              type="button"
              :title="copyLabel"
              :aria-label="copyLabel"
              :disabled="(!selectedMemo.content && !selectedMemo.attachments.length) || copyStatus === 'copying'"
              @click="copyCurrentMemo"
            >
              <Check v-if="copyStatus === 'copied'" :size="14" />
              <Copy v-else :size="14" />
            </button>
            <button
              class="memo-insert-button"
              type="button"
              title="插入到 CLI 输入框"
              aria-label="插入到 CLI 输入框"
              :disabled="!canInsertMemo || (!selectedMemo.content && !selectedMemo.attachments.length)"
              @click="insertMemoIntoCli"
            >
              <ClipboardPaste :size="14" />
            </button>
            <select v-model="selectedMemo.category" class="memo-category-select" aria-label="备忘录分类" @change="markDirty" @blur="flushSave">
              <option value="">未分类</option>
              <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
            </select>
            <button type="button" title="删除备忘录" :disabled="deleting" @click="deleteSelectedMemo">
              <Trash2 :size="14" />
            </button>
          </div>
          <textarea
            v-if="!previewMode"
            v-model="selectedMemo.content"
            class="memo-content-input"
            aria-label="备忘录正文"
            placeholder="直接输入备忘内容"
            spellcheck="false"
            @input="markDirty"
            @paste="attachClipboardImage"
            @blur="flushSave"
          />
          <div v-if="attachmentPaths.length" class="memo-attachments" aria-label="图片附件">
            <button v-for="path in attachmentPaths" :key="path" type="button" class="memo-attachment" :title="`预览 ${path}`" @click="openMemoImage(path)">
              <img v-if="attachmentUrls[path]" :src="attachmentUrls[path]" alt="图片附件" />
              <span v-else>读取图片…</span>
            </button>
          </div>
          <div v-if="previewMode" class="memo-content-preview markdown-body" @click="openPreviewLink" v-html="previewContent" />
          <div class="memo-metadata">
            <span class="memo-created-at">创建 {{ formatTimestamp(selectedMemo.createdAt) }}</span>
            <span v-if="copyStatus === 'copied' || copyStatus === 'error'" role="status" :class="{ 'is-error': copyStatus === 'error' }">{{ copyLabel }}</span>
            <span v-if="saveStatusText" :class="`is-${saveStatus}`">{{ saveStatusText }}</span>
          </div>
        </template>
        <div v-else class="memo-editor-empty">
          <NotebookPen :size="24" />
          <span>{{ loading ? '正在读取...' : '选择或新增一条备忘录' }}</span>
        </div>
      </main>

      <aside class="memo-list" aria-label="备忘录列表">
        <div class="memo-toolbar">
          <label class="memo-search">
            <Search :size="13" />
            <input v-model="query" type="search" placeholder="搜索标题、正文或时间" />
            <button v-if="query" type="button" title="清空搜索" @click="query = ''"><X :size="12" /></button>
          </label>
          <div class="memo-toolbar-row">
            <div ref="dateControl" class="memo-date-control">
              <button
                class="memo-date-button"
                :class="{ active: hasDateFilter || dateMenuOpen }"
                type="button"
                title="按创建日期筛选"
                @click="dateMenuOpen = !dateMenuOpen"
              >
                <CalendarDays :size="14" />
                <span>{{ hasDateFilter ? `${dateFrom || '起始'} - ${dateTo || '今天'}` : '日期' }}</span>
              </button>
              <div v-if="dateMenuOpen" class="memo-date-menu">
                <div class="memo-date-quick-filters" aria-label="快速日期筛选">
                  <button
                    v-for="days in quickDateFilters"
                    :key="days"
                    type="button"
                    :class="{ active: activeQuickDateFilter === days }"
                    @click="applyQuickDateFilter(days)"
                  >近{{ days }}天</button>
                </div>
                <label><span>从</span><input v-model="dateFrom" type="date" :max="dateTo || undefined" /></label>
                <label><span>到</span><input v-model="dateTo" type="date" :min="dateFrom || undefined" /></label>
                <button type="button" title="清除日期筛选" :disabled="!hasDateFilter" @click="clearDateFilter">
                  <X :size="13" /><span>清除</span>
                </button>
              </div>
            </div>
            <button class="memo-add-button" type="button" title="新增备忘录" :disabled="creating" @click="createMemo">
              <Plus :size="14" /><span>{{ creating ? '新增中...' : '新增' }}</span>
            </button>
          </div>
        </div>
        <div class="memo-list-items">
          <div v-if="loading && !notes.length" class="memo-empty">正在读取...</div>
          <button
            v-for="note in notes"
            :key="note.id"
            class="memo-list-item"
            :class="{ active: note.id === selectedId }"
            type="button"
            :title="displayTitle(note)"
            @click="selectMemo(note.id)"
          >
            <span class="memo-list-title">{{ displayTitle(note) }}</span>
            <span v-if="displayDescription(note)" class="memo-list-description">{{ displayDescription(note) }}</span>
          </button>
          <div v-if="!loading && !notes.length" class="memo-empty">
            {{ query || hasDateFilter ? '没有匹配的备忘录' : '还没有备忘录' }}
          </div>
        </div>
      </aside>
    </div>

    <div v-if="error" class="memo-error" role="status">{{ error }}</div>
    <div v-if="imagePreviewPath" class="memo-image-modal" role="dialog" aria-modal="true">
      <div class="memo-image-toolbar">
        <span>图片附件</span>
        <button type="button" title="缩小" @click="zoomImage(1 / 1.2)"><ZoomOut :size="16" /></button>
        <button type="button" title="适合窗口" @click="fitImage"><Maximize :size="16" /></button>
        <button type="button" title="放大" @click="zoomImage(1.2)"><ZoomIn :size="16" /></button>
        <span>{{ Math.round(imageScale * 100) }}%</span>
        <button type="button" title="关闭图片预览" @click="imagePreviewPath = ''"><X :size="16" /></button>
      </div>
      <div ref="imageStage" class="memo-image-stage" @wheel.prevent="onImageWheel" @pointerdown="startImagePan" @pointermove="moveImagePan" @pointerup="imagePan = null" @pointercancel="imagePan = null">
        <img v-if="imagePreviewUrl" :src="imagePreviewUrl" :alt="imagePreviewPath" :style="{ width: `${imageNaturalSize.width * imageScale}px`, height: `${imageNaturalSize.height * imageScale}px` }" @load="onImageLoad" draggable="false" />
      </div>
    </div>
    <div v-for="edge in resizeEdges" :key="edge" class="memo-resize" :class="`is-${edge}`" @pointerdown="startPointer('resize', $event, edge)" />
  </section>
</template>

<style scoped>
.memo-window { position: fixed; z-index: 1210; container: memo-window / inline-size; display: grid; grid-template-rows: 38px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-primary); background: var(--color-bg-primary); box-shadow: none; }
.memo-titlebar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 0 5px 0 10px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); cursor: move; user-select: none; }
.memo-window-title { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; font-weight: var(--sh-weight-heading); white-space: nowrap; }
.memo-titlebar-actions { display: flex; align-items: center; gap: 2px; }
.memo-titlebar button, .memo-editor-actions button, .memo-search button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 1px solid transparent; border-radius: 4px; color: var(--color-text-secondary); background: transparent; cursor: pointer; }
.memo-titlebar button:hover, .memo-editor-actions button:hover, .memo-search button:hover { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-toolbar { position: relative; z-index: 2; display: grid; gap: 6px; flex: 0 0 auto; min-width: 0; padding: 6px; border-bottom: 1px solid var(--color-border); overflow: visible; }
.memo-toolbar-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.memo-search { display: flex; align-items: center; gap: 5px; min-width: 0; height: 32px; padding: 0 4px 0 7px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-muted); background: var(--color-bg-primary); }
.memo-search:focus-within { border-color: var(--color-accent-blue); }
.memo-search input { min-width: 0; flex: 1; border: 0; outline: 0; color: var(--color-text-primary); background: transparent; font: inherit; font-size: 14px; }
.memo-search input::-webkit-search-cancel-button { display: none; }
.memo-search button { width: 20px; height: 20px; }
.memo-date-control { position: relative; flex: 1 1 auto; min-width: 0; }
.memo-date-control .memo-date-button { width: 100%; justify-content: flex-start; }
.memo-date-button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.memo-date-button, .memo-add-button, .memo-date-menu button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); background: var(--color-bg-primary); cursor: pointer; font-size: 14px; white-space: nowrap; }
.memo-date-button.active, .memo-date-button:hover, .memo-add-button:hover { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-add-button { color: var(--color-text-primary); border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.memo-category-input { width: 100%; flex: 1; min-width: 0; height: 32px; padding: 0 6px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-primary); background: var(--color-bg-primary); font: inherit; font-size: 14px; }
.memo-category-add { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: 0 0 auto; padding: 0; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); background: var(--color-bg-primary); cursor: pointer; }
.memo-date-menu { position: absolute; top: calc(100% + 5px); right: 0; z-index: 3; display: grid; gap: 7px; width: 280px; padding: 8px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-bg-secondary); box-shadow: none; }
.memo-date-quick-filters { display: flex; gap: 4px; overflow-x: auto; }
.memo-date-quick-filters button { flex: 1 0 auto; height: 32px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); background: var(--color-bg-primary); cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
.memo-date-quick-filters button:hover, .memo-date-quick-filters button.active { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-date-menu label { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: 14px; }
.memo-date-menu input { min-width: 0; height: 32px; padding: 0 6px; border: 1px solid var(--color-border); border-radius: 3px; outline: 0; color: var(--color-text-primary); color-scheme: dark; background: var(--color-bg-primary); font: inherit; }
.memo-date-menu input:focus { border-color: var(--color-accent-blue); }
.memo-date-menu button { justify-self: end; }
.memo-body { display: grid; grid-template-columns: 160px minmax(0, 1fr) 280px; min-width: 0; min-height: 0; overflow: hidden; }
.memo-categories { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 6px; border-right: 1px solid var(--color-border); background: var(--surface-panel); }
.memo-category-list { display: flex; flex-direction: column; flex: 1; gap: 2px; min-height: 0; overflow-y: auto; }
.memo-category-list button { position: relative; display: grid; place-items: center; flex: 0 0 auto; width: 100%; min-height: 40px; height: auto; padding: 8px; border: 1px solid transparent; border-radius: 3px; overflow: hidden; color: var(--color-text-secondary); text-align: center; background: transparent; cursor: pointer; font: inherit; font-size: 16px; line-height: 1.4; overflow-wrap: anywhere; white-space: normal; }
.memo-category-list button > span { width: 100%; min-width: 0; }
.memo-category-list button:hover { border-color: var(--color-border); color: var(--color-text-primary); background: var(--color-bg-secondary); }
.memo-category-list button.active { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-category-list button.active::before { content: ''; position: absolute; inset: -1px auto -1px -1px; width: 3px; background: var(--color-accent-blue); pointer-events: none; }
.memo-category-create { display: flex; align-items: center; flex: 0 0 auto; gap: 4px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--color-border); }
.memo-list { position: relative; z-index: 2; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--color-border); background: var(--surface-panel); }
.memo-list-items { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.memo-list-item { display: flex; flex-direction: column; justify-content: center; gap: 4px; width: 100%; min-width: 0; min-height: 44px; padding: 9px 10px; border: 1px solid transparent; border-radius: 4px; overflow: hidden; color: var(--color-text-secondary); text-align: left; text-overflow: ellipsis; white-space: nowrap; background: transparent; cursor: pointer; font-size: 14px; }
.memo-list-title { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--sh-weight-emphasis); line-height: 1.5; }
.memo-list-description { display: -webkit-box; width: 100%; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--color-text-secondary); font-size: 13px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.memo-list-item + .memo-list-item { margin-top: 4px; }
.memo-list-item:hover { border-color: var(--color-border); color: var(--color-text-primary); background: var(--color-bg-secondary); }
.memo-list-item.active { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-empty { padding: 18px 8px; color: var(--color-text-muted); font-size: 14px; text-align: center; }
.memo-editor { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 8px; padding: 10px; background: var(--color-bg-primary); }
.memo-editor-heading { display: flex; align-items: center; gap: 5px; min-width: 0; }
.memo-editor-actions { display: flex; align-items: center; flex: 0 0 auto; gap: 4px; min-width: 0; overflow-x: auto; }
.memo-editor-actions button { flex-shrink: 0; }
.memo-copy-button:disabled { opacity: 0.45; cursor: default; }
.memo-title-input { width: 100%; min-width: 0; height: 38px; flex: 1; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 4px; outline: 0; color: var(--color-text-primary); background: var(--color-bg-secondary); font: inherit; font-size: 18px; font-weight: var(--sh-weight-emphasis); }
.memo-category-select { max-width: 120px; min-width: 84px; height: 32px; flex: 0 0 auto; margin-left: auto; padding: 0 5px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); background: var(--color-bg-secondary); font: inherit; font-size: 13px; }
.memo-title-input:focus { border-color: var(--color-accent-blue); }
.memo-metadata { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; min-height: 22px; flex: 0 0 auto; color: var(--color-text-muted); font-size: 12px; white-space: nowrap; }
.memo-metadata span { overflow: hidden; text-overflow: ellipsis; }
.memo-created-at { color: #fff; }
.memo-metadata .is-error { color: var(--color-accent-red); }
.memo-content-input { width: 100%; flex: 1; min-width: 0; min-height: 0; resize: none; padding: 12px; border: 1px solid var(--color-border); border-radius: 4px; outline: 0; color: var(--color-text-primary); background: var(--color-bg-secondary); font-family: var(--font-content); font-weight: var(--font-content-weight); font-size: 16px; line-height: 1.7; }
.memo-content-input:focus { border-color: var(--color-accent-blue); }
.memo-attachments { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 7px; min-height: 0; max-height: 150px; overflow: auto; padding: 7px; border: 1px solid var(--color-border); border-top: 0; background: var(--color-bg-secondary); }
.memo-attachment { display: grid; place-items: center; width: 110px; height: 80px; padding: 4px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); background: var(--color-bg-primary); cursor: zoom-in; }
.memo-attachment:hover { border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.memo-attachment img { width: 100%; height: 70px; object-fit: contain; }
.memo-attachment span { display: flex; align-items: center; justify-content: center; color: var(--color-text-muted); font-size: 13px; }
.memo-attachment code { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.memo-editor-actions .memo-preview-button { width: auto; height: 32px; padding: 0 7px; gap: 4px; font-size: 14px; white-space: nowrap; }
.memo-preview-button.active { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-content-preview { width: 100%; flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 12px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-primary); background: var(--color-bg-secondary); font-family: var(--font-content); font-weight: var(--font-content-weight); font-size: 16px; line-height: 1.7; word-break: break-word; }
.memo-content-preview a { color: var(--color-accent-blue); text-decoration: underline; }
.memo-content-preview a:hover { color: var(--color-accent-blue); }
.memo-image-preview-trigger { display: block; max-width: 100%; padding: 0; margin: 6px 0; border: 0; background: transparent; cursor: zoom-in; }
.memo-image-preview-trigger img { display: block; max-width: 100%; max-height: 240px; object-fit: contain; border: 1px solid var(--color-border); }
.memo-image-modal { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--color-bg-primary); }
.memo-image-toolbar { display: flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 8px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); font-size: 14px; }
.memo-image-toolbar span:first-child { margin-right: auto; }
.memo-image-toolbar button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-primary); background: var(--color-bg-primary); cursor: pointer; }
.memo-image-toolbar button:hover { background: var(--surface-accent-blue-soft); }
.memo-image-stage { display: flex; flex: 1; align-items: safe center; justify-content: safe center; min-width: 0; min-height: 0; overflow: auto; cursor: grab; touch-action: none; }
.memo-image-stage:active { cursor: grabbing; }
.memo-image-stage img { display: block; max-width: none; max-height: none; flex: none; object-fit: contain; image-rendering: auto; }
.memo-editor-empty { display: flex; flex: 1; align-items: center; justify-content: center; gap: 7px; color: var(--color-text-muted); font-size: 14px; }
.memo-error { position: absolute; right: 290px; bottom: 8px; left: 170px; z-index: 2; max-height: 48px; overflow: auto; padding: 6px 8px; border: 1px solid var(--surface-accent-red-border); border-radius: 4px; color: var(--color-accent-red); background: var(--surface-accent-red-soft); font-size: 13px; }
.memo-resize { position: absolute; z-index: 4; }
.memo-resize.is-n, .memo-resize.is-s { left: 12px; width: calc(100% - 24px); height: 8px; cursor: ns-resize; }
.memo-resize.is-n { top: 0; }.memo-resize.is-s { bottom: 0; }
.memo-resize.is-e, .memo-resize.is-w { top: 12px; width: 8px; height: calc(100% - 24px); cursor: ew-resize; }
.memo-resize.is-e { right: 0; }.memo-resize.is-w { left: 0; }
.memo-resize.is-ne, .memo-resize.is-nw, .memo-resize.is-se, .memo-resize.is-sw { width: 18px; height: 18px; }
.memo-resize.is-ne { top: 0; right: 0; cursor: nesw-resize; }.memo-resize.is-nw { top: 0; left: 0; cursor: nwse-resize; }
.memo-resize.is-se { right: 0; bottom: 0; cursor: nwse-resize; }.memo-resize.is-sw { bottom: 0; left: 0; cursor: nesw-resize; }
button:disabled { opacity: 0.45; cursor: default; }

@container memo-window (max-width: 860px) {
  .memo-body { grid-template-columns: 130px minmax(0, 1fr) 220px; }
  .memo-error { right: 230px; left: 140px; }
}
</style>
