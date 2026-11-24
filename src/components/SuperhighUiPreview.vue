<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import { compileSuperhighUi, superhighUiStatePath, type UiArrayInfo, type UiChildList, type UiNode } from '@/lib/superhighUi'
import { parseDataFile, resolveUiNodeProps, uiText, walkUiTree } from '@/lib/superhighUiData'
import { createUiScope, formatUiDraft, indexUiFields } from '@/lib/superhighUiFields'
import { moveSuperhighUiArrayItem } from '@/lib/superhighUiEdit'
import { backend, onWorkspaceFilesChanged } from '@/lib/tauri'
import { fileNameFromPath, normalizePath } from '@/lib/path'
import { fileLinkArguments, parseLinkTarget } from '@/lib/linkTargets'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EditorTab } from '@/types'
import type { UiDraftResult } from '@/lib/superhighUiDraft'
import { SUPERHIGH_UI_CONTEXT, SuperhighUiNode, type SuperhighUiActionInput, type SuperhighUiDragSource } from './SuperhighUiNode'
import ImagePreviewDialog from './ImagePreviewDialog.vue'

const props = defineProps<{
  tab: EditorTab
  submitDraft?: (path: string, text: string) => Promise<UiDraftResult>
  saveSource?: (content: string, previous: string) => Promise<void>
}>()
const store = useWorkspaceStore()

const STATE_SCHEMA = 'superhigh.ui-state.v1'
const MAX_ACTIONS = 50
// 外部写入（Agent 追加语句）后保持“生成中”的时长，期间不允许拖动写回
const SETTLE_MS = 1200
const imageRevisions = reactive(new Map<string, number>())
const imageDependencies = new Set<string>()

function resetImageDependencies() {
  imageDependencies.clear()
  imageRevisions.clear()
}
const imageRescan = ref(0)

interface StoredAction extends SuperhighUiActionInput {
  id: number
  at: string
}

const doc = computed(() => compileSuperhighUi(props.tab.content))

const arrays = computed(() => {
  const map = new Map<number, UiArrayInfo>()
  const visit = (node: UiNode | null) => {
    if (!node) return
    for (const childList of Object.values(node.children) as UiChildList[]) {
      if (childList.array) map.set(childList.array.span.start, childList.array)
      for (const child of childList.items) if (child.kind === 'node') visit(child.node)
    }
    for (const value of Object.values(node.props)) visitValue(value)
  }
  const visitValue = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visitValue)
    else if (value && typeof value === 'object' && (value as UiNode).uiNode) visit(value as UiNode)
  }
  visit(doc.value.root)
  return map
})

// ---- 生成中判定 ----
const settling = ref(false)
let settleTimer = 0
let ownContent: string | null = null
watch(() => props.tab.content, (content) => {
  if (content === ownContent) return
  ownContent = null
  resetImageDependencies()
  imageRescan.value++
  settling.value = true
  window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => { settling.value = false }, SETTLE_MS)
  scheduleStateReload()
})
const streaming = computed(() => doc.value.streaming || settling.value)
const dragEnabled = computed(() => !streaming.value)

// ---- 状态文件 ----
const values = reactive<Record<string, unknown>>({})
let actions: StoredAction[] = []
let statePath = ''
let writeTimer = 0
let reloadTimer = 0
let stateRevision = 0
let stateLoadRequest = 0
let stateWrites = Promise.resolve()
const notice = ref('')
let noticeTimer = 0

function flash(message: string) {
  notice.value = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice.value = '' }, 2400)
}

async function loadState(path: string) {
  const revision = stateRevision
  const request = ++stateLoadRequest
  let parsed: { values?: Record<string, unknown>; actions?: StoredAction[] } = {}
  try {
    await stateWrites.catch(() => undefined)
    parsed = JSON.parse(await backend.readFile(path))
  } catch {
    parsed = {}
  }
  if (unmounted || path !== statePath || request !== stateLoadRequest || revision !== stateRevision || writeTimer) return
  for (const key of Object.keys(values)) delete values[key]
  Object.assign(values, parsed.values && typeof parsed.values === 'object' ? parsed.values : {})
  actions = Array.isArray(parsed.actions) ? parsed.actions.slice(-MAX_ACTIONS) : []
}

async function writeState() {
  window.clearTimeout(writeTimer)
  writeTimer = 0
  if (!statePath) return
  const path = statePath
  const payload = {
    schema: STATE_SCHEMA,
    source: fileNameFromPath(path.replace(/\.state\.json$/, '')),
    updatedAt: new Date().toISOString(),
    values: { ...values },
    actions,
  }
  const content = `${JSON.stringify(payload, null, 2)}\n`
  const write = stateWrites.catch(() => undefined).then(() => backend.writeFile(path, content))
  stateWrites = write
  try {
    await write
  } catch (error) {
    flash(`状态写入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function flushState() {
  if (writeTimer) void writeState()
}

function scheduleStateReload() {
  // Agent 重写界面时可能一并重置状态文件，等写入平静后重新读取
  window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => {
    if (!writeTimer && statePath) void loadState(statePath)
  }, SETTLE_MS)
}

watch(() => props.tab.path, (path) => {
  resetImageDependencies()
  flushState()
  statePath = superhighUiStatePath(path)
  void loadState(statePath)
}, { immediate: true })

function setValue(name: string, value: unknown) {
  if (!name) return
  values[name] = value
  stateRevision++
  window.clearTimeout(writeTimer)
  writeTimer = window.setTimeout(() => void writeState(), 400)
}

function emitAction(input: SuperhighUiActionInput) {
  const id = (actions.at(-1)?.id ?? 0) + 1
  actions = [...actions, { id, at: new Date().toISOString(), ...input }].slice(-MAX_ACTIONS)
  stateRevision++
  void writeState()
  const draft = formatUiDraft(doc.value.root, scope, values, input.label || (input.type === 'click' ? input.action : '提交'), input.values)
  void (props.submitDraft ? props.submitDraft(props.tab.path, draft) : store.insertUiDraft(props.tab.path, draft)).then((result) => {
    const messages = {
      inserted: '已填入原会话草稿', unbound: '已记录选择，未绑定原会话',
      ended: '原会话已结束，未填入草稿', unavailable: '无法核对原会话，未填入草稿',
      duplicate: '该选择已填入草稿', pending: '正在核对原会话',
    }
    flash(messages[result])
  }).catch(error => flash(`回传失败：${String(error)}`))
}

function resolveLocalPath(src: string) {
  const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(src)
  const base = normalizePath(props.tab.path).replace(/\/[^/]*$/, '')
  const joined = absolute ? normalizePath(src) : `${base}/${normalizePath(src)}`
  // 折叠 ./ 与 ../，与文件变化事件里的绝对路径保持一致
  const segments: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '.') continue
    if (segment === '..' && segments.length > 1) segments.pop()
    else if (segment !== '..') segments.push(segment)
  }
  return segments.join('/')
}

function imageRevision(src: string) {
  if (/^(?:https?:|data:)/i.test(src)) return ''
  const key = dataKey(resolveLocalPath(src))
  imageDependencies.add(key)
  return `${key}:${imageRescan.value}:${imageRevisions.get(key) ?? 0}`
}

async function resolveMedia(src: string) {
  if (/^(?:https?:|data:)/i.test(src)) return src
  return backend.readMediaAsDataUrl(resolveLocalPath(src))
}

async function resolvePlayableMedia(src: string) {
  if (/^(?:https?:|data:)/i.test(src)) return src
  return (await backend.readMediaPreview(resolveLocalPath(src))).url
}

async function resolveImage(src: string) {
  if (/^(?:https?:|data:)/i.test(src)) return src
  return backend.readImageAsDataUrl(resolveLocalPath(src))
}

const previewImage = ref<{ src: string; alt: string } | null>(null)

// .shui 直接渲染在主 WebView 内，必须在异步打开文件前取消导航。
async function handleContentClick(event: MouseEvent) {
  if (event.defaultPrevented) return
  const target = event.target instanceof Element ? event.target : null
  const image = target?.closest('img')
  const anchor = target?.closest('a[href]')
  if (!image && !anchor) return
  event.preventDefault()
  event.stopPropagation()
  if (event.button !== 0) return
  if (image) {
    previewImage.value = { src: image.currentSrc || image.src, alt: image.alt || '图片预览' }
    return
  }
  const href = anchor?.getAttribute('href')?.trim()
  if (!href) return
  await openResource(href)
}

async function openResource(href: string) {
  try {
    if (/^https?:\/\//i.test(href)) {
      await backend.openUrl(href)
      return
    }
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      const heading = [...root.value!.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id === id)
      heading?.scrollIntoView?.({ block: 'center' })
      return
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return
    const directory = normalizePath(props.tab.path).replace(/\/[^/]*$/, '')
    const target = parseLinkTarget(href, directory)
    if (target?.kind !== 'file') return
    if (target.lineNumber || target.anchor) await store.openTerminalFileLink(...fileLinkArguments(target))
    else await store.openFile(target.path)
  } catch (error) {
    flash(`打开链接失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

watch(() => props.tab.path, () => { previewImage.value = null })

// ---- 动态值：Bind 读字段，Data 读数据文件 ----
const fields = computed(() => indexUiFields(doc.value.root))

const dataSources = computed(() => {
  const sources = new Map<string, string>()
  walkUiTree(doc.value.root, (node) => {
    const src = uiText(node.props.src)
    if (node.type !== 'Data' || !src) return
    const path = resolveLocalPath(src)
    sources.set(dataKey(path), path)
  })
  return sources
})

interface DataEntry {
  path: string
  value?: unknown
  error?: string
}

const dataFiles = reactive(new Map<string, DataEntry>())
const dataRequests = new Map<string, symbol>()
let unmounted = false
const dataKey = (path: string) => normalizePath(path).toLowerCase()

async function loadData(path: string) {
  const key = dataKey(path)
  const request = Symbol()
  dataRequests.set(key, request)
  const current = () => !unmounted && dataFiles.has(key) && dataRequests.get(key) === request
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = parseDataFile(path, await backend.readFile(path))
      if (current()) dataFiles.set(key, { path, value })
      return
    } catch (error) {
      if (!current()) return
      // Agents may still be replacing or writing this data file.
      if (attempt === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 100))
        if (!current()) return
        continue
      }
      dataFiles.set(key, { path, value: dataFiles.get(key)?.value, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

watch(dataSources, (wanted) => {
  for (const key of [...dataFiles.keys()]) if (!wanted.has(key)) {
    dataFiles.delete(key)
    dataRequests.delete(key)
  }
  for (const [key, path] of wanted) {
    if (dataFiles.has(key)) continue
    dataFiles.set(key, { path })
    void loadData(path)
  }
}, { immediate: true })

function reloadData() {
  for (const entry of dataFiles.values()) void loadData(entry.path)
}

let stopFilesChanged: (() => void) | null = null
onMounted(() => {
  void onWorkspaceFilesChanged((event) => {
    if (event.rootPath && store.workspace && dataKey(event.rootPath) !== dataKey(store.workspace.rootPath)) return
    const affected = (path: string) => event.kind === 'rescan' || (event.changedPaths ?? []).some(changed => {
      const changedKey = dataKey(changed).replace(/\/+$/, '')
      return dataKey(path) === changedKey || dataKey(path).startsWith(`${changedKey}/`)
    })
    if (affected(statePath) && !writeTimer) void loadState(statePath)
    if (event.kind === 'rescan') {
      imageRescan.value++
      reloadData()
    }
    if (event.kind !== 'rescan') {
      for (const key of imageDependencies) if (affected(key)) imageRevisions.set(key, (imageRevisions.get(key) ?? 0) + 1)
      for (const entry of dataFiles.values()) if (affected(entry.path)) void loadData(entry.path)
    }
  }).then((unlisten) => {
    if (unmounted) unlisten()
    else stopFilesChanged = unlisten
  }).catch(() => undefined)
})

const scope = createUiScope(() => fields.value, values, src => dataFiles.get(dataKey(resolveLocalPath(src)))?.value)
const watchOwner = `iui:${crypto.randomUUID()}`
let watchRoot = ''
watch(() => {
  const root = normalizePath(store.workspace?.rootPath ?? '').replace(/\/+$/, '')
  const paths = new Set([props.tab.path, superhighUiStatePath(props.tab.path), ...dataSources.value.values()])
  walkUiTree(doc.value.root, node => {
    if (!['Image', 'Video', 'Audio', 'Model3D'].includes(node.type)) return
    const src = uiText(resolveUiNodeProps(node, scope).props.src)
    if (src && !/^(?:https?:|data:)/i.test(src)) paths.add(resolveLocalPath(src))
  })
  return { root, paths: [...paths].filter(path => dataKey(path).startsWith(`${dataKey(root)}/`)).map(path => normalizePath(path).slice(root.length + 1)).sort() }
}, ({ root, paths }) => {
  if (!root) return
  watchRoot = root
  void store.setEditorFileWatch(watchOwner, root, paths.map(path => ({ path, kind: 'file' }))).catch(error => flash(`界面文件监听失败：${String(error)}`))
}, { immediate: true })

// ---- 拖动：预览内重排写回源码，拖到 CLI 面板插入组件引用 ----
const root = ref<HTMLElement | null>(null)
const dragging = ref(false)
const indicator = ref<{ left: number; top: number; width: number; height: number; cli?: boolean } | null>(null)
let cancelDrag: (() => void) | null = null

interface DropTarget {
  kind: 'array' | 'cli'
  array?: UiArrayInfo
  index?: number
}

function lineAt(offset: number) {
  return props.tab.content.slice(0, offset).split('\n').length
}

function componentReference(source: SuperhighUiDragSource) {
  const content = props.tab.content
  const child = source.child
  if (child.kind === 'text') return { label: '文字', text: child.text }
  if (child.kind === 'pending') return { label: `语句 ${child.ref}（尚未定义）`, text: child.ref }
  const statement = child.node.statementId ? doc.value.statements.get(child.node.statementId) : null
  if (statement) {
    return { label: `语句 ${statement.id}（第 ${statement.line} 行）`, text: content.slice(statement.span.start, statement.span.end) }
  }
  return { label: `第 ${lineAt(child.node.span.start)} 行 ${child.node.type}`, text: content.slice(child.node.span.start, child.node.span.end) }
}

function findTarget(x: number, y: number, source: SuperhighUiDragSource): { target: DropTarget; box: NonNullable<typeof indicator.value> } | null {
  const element = document.elementFromPoint(x, y)
  if (!element) return null
  const host = root.value
  if (host?.contains(element)) {
    if (!dragEnabled.value || !source.array) return null
    const listEl = element.closest<HTMLElement>('[data-shui-array]')
    if (!listEl || !host.contains(listEl) || source.element.contains(listEl)) return null
    const array = arrays.value.get(Number(listEl.dataset.shuiArray))
    if (!array) return null
    const items = [...listEl.children].filter((item): item is HTMLElement => item instanceof HTMLElement && item.classList.contains('shui-item'))
    const style = getComputedStyle(listEl)
    const vertical = style.display !== 'grid' && !style.flexDirection.startsWith('row')
    let index = items.findIndex((item) => {
      const rect = item.getBoundingClientRect()
      if (vertical) return y < rect.top + rect.height / 2
      return y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)
    })
    if (index < 0) index = items.length
    const listRect = listEl.getBoundingClientRect()
    let box
    if (!items.length) {
      box = { left: listRect.left, top: listRect.top, width: listRect.width, height: Math.max(2, listRect.height) }
    } else {
      const anchor = items[Math.min(index, items.length - 1)].getBoundingClientRect()
      const after = index >= items.length
      box = vertical
        ? { left: anchor.left, top: (after ? anchor.bottom + 2 : anchor.top - 3), width: anchor.width, height: 2 }
        : { left: (after ? anchor.right + 2 : anchor.left - 3), top: anchor.top, width: 2, height: anchor.height }
    }
    return { target: { kind: 'array', array, index }, box }
  }
  const cli = element.closest<HTMLElement>('.cli-terminal-panel')
  if (!cli) return null
  const rect = cli.getBoundingClientRect()
  return { target: { kind: 'cli' }, box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, cli: true } }
}

async function applyDrop(source: SuperhighUiDragSource, target: DropTarget, renderedContent: string) {
  if (target.kind === 'cli') {
    const reference = componentReference(source)
    window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', {
      detail: { source: `查看界面组件 ${props.tab.path} ${reference.label}`, text: reference.text },
    }))
    return
  }
  if (!source.array || !target.array || target.index === undefined) return
  if (props.tab.content !== renderedContent) {
    flash('文件已变化，请重新拖动')
    return
  }
  const next = moveSuperhighUiArrayItem(renderedContent, { array: source.array, index: source.index }, { array: target.array, index: target.index })
  if (next === null) return
  ownContent = next
  if (props.saveSource) await props.saveSource(next, renderedContent)
  else {
    store.updateTabContent(props.tab.id, next)
    await store.saveTab(props.tab.id)
  }
}

function beginDrag(event: PointerEvent, source: SuperhighUiDragSource) {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  cancelDrag?.()
  const startX = event.clientX
  const startY = event.clientY
  const renderedContent = props.tab.content
  let ghost: HTMLElement | null = null
  let current: DropTarget | null = null

  const cleanup = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cleanup)
    window.removeEventListener('keydown', key, true)
    ghost?.remove()
    ghost = null
    dragging.value = false
    indicator.value = null
    cancelDrag = null
  }
  const move = (moveEvent: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return
      const rect = source.element.getBoundingClientRect()
      ghost = source.element.cloneNode(true) as HTMLElement
      ghost.classList.add('shui-drag-ghost')
      ghost.style.width = `${Math.min(rect.width, 280)}px`
      document.body.appendChild(ghost)
      dragging.value = true
    }
    ghost.style.transform = `translate(${moveEvent.clientX + 10}px, ${moveEvent.clientY + 10}px)`
    const found = findTarget(moveEvent.clientX, moveEvent.clientY, source)
    current = found?.target ?? null
    indicator.value = found?.box ?? null
  }
  const up = () => {
    const target = ghost ? current : null
    cleanup()
    if (target) void applyDrop(source, target, renderedContent).catch(error => { ownContent = null; flash(String(error)) })
  }
  const key = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== 'Escape') return
    keyEvent.preventDefault()
    keyEvent.stopPropagation()
    cleanup()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cleanup)
  window.addEventListener('keydown', key, true)
  cancelDrag = cleanup
}

provide(SUPERHIGH_UI_CONTEXT, { values, setValue, emitAction, beginDrag, resolveImage, resolveMedia, resolvePlayableMedia, openResource, imageRevision, dragEnabled, scope })

const problems = computed(() => [
  ...doc.value.diagnostics.map((item) => `第 ${item.line} 行：${item.message}`),
  ...(doc.value.unusedStatements.length ? [`未被引用、不会显示：${doc.value.unusedStatements.join('、')}`] : []),
  ...[...dataFiles.values()].filter((entry) => entry.error).map((entry) => `数据文件读取失败：${entry.path}：${entry.error}`),
])
const problemsOpen = ref(false)

onBeforeUnmount(() => {
  unmounted = true
  dataRequests.clear()
  stopFilesChanged?.()
  if (watchRoot) void store.setEditorFileWatch(watchOwner, watchRoot, []).catch(() => undefined)
  cancelDrag?.()
  flushState()
  window.clearTimeout(settleTimer)
  window.clearTimeout(reloadTimer)
  window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div ref="root" class="shui-root" :class="{ 'is-dragging': dragging, 'is-streaming': streaming }">
    <div class="shui-scroll" :class="{ 'has-page': doc.root?.type === 'Page' }" @click="handleContentClick" @auxclick="handleContentClick">
      <SuperhighUiNode v-if="doc.root" :node="doc.root" />
      <div v-else-if="!doc.diagnostics.length" class="shui-empty">
        写入 <code>root = Stack([...])</code> 后在这里显示界面
      </div>
    </div>
    <div v-if="streaming || problems.length || notice || dataFiles.size" class="shui-status">
      <span v-if="streaming" class="shui-status-streaming">生成中</span>
      <button v-if="problems.length" type="button" class="shui-status-problems" :aria-expanded="problemsOpen" @click="problemsOpen = !problemsOpen">
        {{ problems.length }} 个问题
      </button>
      <button v-if="dataFiles.size" type="button" class="shui-status-refresh" :title="[...dataFiles.values()].map((entry) => entry.path).join('\n')" @click="reloadData">
        刷新数据（{{ dataFiles.size }}）
      </button>
      <span v-if="notice" class="shui-status-notice">{{ notice }}</span>
    </div>
    <ul v-if="problemsOpen && problems.length" class="shui-problems">
      <li v-for="(problem, index) in problems" :key="index">{{ problem }}</li>
    </ul>
    <Teleport to="body">
      <div
        v-if="indicator"
        class="shui-drop-indicator"
        :class="{ 'is-cli': indicator.cli }"
        :style="{ left: `${indicator.left}px`, top: `${indicator.top}px`, width: `${indicator.width}px`, height: `${indicator.height}px` }"
      >
        <span v-if="indicator.cli">插入到 CLI 输入框</span>
      </div>
    </Teleport>
    <ImagePreviewDialog v-if="previewImage" :src="previewImage.src" :alt="previewImage.alt" @close="previewImage = null" />
  </div>
</template>

<style src="../superhigh-ui.css"></style>
