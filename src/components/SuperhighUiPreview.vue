<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import { compileSuperhighUi, superhighUiStatePath, type UiArrayInfo, type UiChildList, type UiNode } from '@/lib/superhighUi'
import { SUPERHIGH_UI_FIELD_COMPONENTS } from '@/lib/superhighUiComponents'
import { parseDataFile, resolveUiNodeProps, uiText, walkUiTree, type SuperhighUiScope } from '@/lib/superhighUiData'
import { moveSuperhighUiArrayItem } from '@/lib/superhighUiEdit'
import { backend, onWorkspaceFilesChanged } from '@/lib/tauri'
import { fileNameFromPath, normalizePath } from '@/lib/path'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EditorTab } from '@/types'
import { defaultFieldValue, SUPERHIGH_UI_CONTEXT, SuperhighUiNode, type SuperhighUiActionInput, type SuperhighUiDragSource } from './SuperhighUiNode'
import ImagePreviewDialog from './ImagePreviewDialog.vue'

const props = defineProps<{ tab: EditorTab }>()
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
// 悬停只影响 Bind 的即时读取，不进入状态文件或提交值。
const previews = reactive<Record<string, unknown>>({})
function previewValue(name: string, value: unknown) { if (name) previews[name] = value }
function clearPreview(name: string) { delete previews[name] }
let actions: StoredAction[] = []
let statePath = ''
let writeTimer = 0
let reloadTimer = 0
const notice = ref('')
let noticeTimer = 0

function flash(message: string) {
  notice.value = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice.value = '' }, 2400)
}

async function loadState(path: string) {
  let parsed: { values?: Record<string, unknown>; actions?: StoredAction[] } = {}
  try {
    parsed = JSON.parse(await backend.readFile(path))
  } catch {
    parsed = {}
  }
  if (path !== statePath) return
  for (const key of Object.keys(values)) delete values[key]
  Object.assign(values, parsed.values && typeof parsed.values === 'object' ? parsed.values : {})
  actions = Array.isArray(parsed.actions) ? parsed.actions.slice(-MAX_ACTIONS) : []
}

async function writeState() {
  window.clearTimeout(writeTimer)
  writeTimer = 0
  if (!statePath) return
  const payload = {
    schema: STATE_SCHEMA,
    source: fileNameFromPath(props.tab.path),
    updatedAt: new Date().toISOString(),
    values: { ...values },
    actions,
  }
  try {
    await backend.writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`)
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
  for (const name of Object.keys(previews)) clearPreview(name)
  flushState()
  statePath = superhighUiStatePath(path)
  void loadState(statePath)
}, { immediate: true })

function setValue(name: string, value: unknown) {
  if (!name) return
  values[name] = value
  window.clearTimeout(writeTimer)
  writeTimer = window.setTimeout(() => void writeState(), 400)
}

function emitAction(input: SuperhighUiActionInput) {
  const id = (actions.at(-1)?.id ?? 0) + 1
  actions = [...actions, { id, at: new Date().toISOString(), ...input }].slice(-MAX_ACTIONS)
  void writeState()
  const lines = [input.label || (input.type === 'click' ? input.action : '提交')]
  walkUiTree(doc.value.root, (field) => {
    if (!SUPERHIGH_UI_FIELD_COMPONENTS.has(field.type)) return
    const p = resolveUiNodeProps(field, scope).props
    const name = uiText(p.name)
    if (!name || (input.values && !(name in input.values))) return
    const value = input.values ? input.values[name] : (name in values ? values[name] : defaultFieldValue({ ...field, props: p }))
    const choices = (field.type === 'SortList' ? p.items : p.options)
    const options = Array.isArray(choices) ? choices : []
    const display = (item: unknown) => {
      const match = options.find((option) => {
        const optionValue = option && typeof option === 'object' ? ('value' in option ? (option as Record<string, unknown>).value : (option as Record<string, unknown>).label) : option
        return JSON.stringify(optionValue) === JSON.stringify(item)
      })
      if (match && typeof match === 'object') return uiText((match as Record<string, unknown>).label ?? item)
      if (typeof item === 'boolean') return item ? '是' : '否'
      return uiText(match ?? item)
    }
    const formatted = Array.isArray(value) ? value.map(display).join('、') : display(value)
    lines.push(`${uiText(p.label) || name}：${formatted}`)
  })
  void store.insertUiDraft(props.tab.path, lines.join('\n')).then((result) => {
    const messages = {
      inserted: '已填入原会话草稿', unbound: '已记录选择，未绑定原会话',
      ended: '原会话已结束，未填入草稿', unavailable: '无法核对原会话，未填入草稿',
      duplicate: '该选择已填入草稿', pending: '正在核对原会话',
    }
    flash(messages[result])
  })
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
    const source = normalizePath(props.tab.path)
    const base = source.startsWith('//') ? `file:${source}` : `file:///${source.replace(/^\//, '')}`
    const normalized = href.replace(/\\/g, '/')
    const url = new URL(/^[a-z]:\//i.test(normalized) ? `file:///${normalized}` : normalized, base)
    if (url.protocol !== 'file:') return
    const path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1')
    await store.openFile(url.hostname ? `//${url.hostname}${path}` : path)
  } catch (error) {
    flash(`打开链接失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

watch(() => props.tab.path, () => { previewImage.value = null })

// ---- 动态值：Bind 读字段，Data 读数据文件 ----
const fieldDefaults = computed(() => {
  const defaults = new Map<string, unknown>()
  walkUiTree(doc.value.root, (node) => {
    const name = uiText(node.props.name)
    if (SUPERHIGH_UI_FIELD_COMPONENTS.has(node.type) && name && !defaults.has(name)) defaults.set(name, defaultFieldValue(node))
  })
  return defaults
})

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
    if (event.kind === 'rescan') {
      imageRescan.value++
      reloadData()
    }
    for (const changed of event.changedPaths ?? []) {
      const key = dataKey(changed)
      if (imageDependencies.has(key)) imageRevisions.set(key, (imageRevisions.get(key) ?? 0) + 1)
      const entry = dataFiles.get(dataKey(changed))
      if (entry && event.kind !== 'rescan') void loadData(entry.path)
    }
  }).then((unlisten) => {
    if (unmounted) unlisten()
    else stopFilesChanged = unlisten
  }).catch(() => undefined)
})

const scope: SuperhighUiScope = {
  field: (name) => (name in previews ? previews[name] : name in values ? values[name] : fieldDefaults.value.get(name)),
  data: (src) => dataFiles.get(dataKey(resolveLocalPath(src)))?.value,
}

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
  store.updateTabContent(props.tab.id, next)
  await store.saveTab(props.tab.id)
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
    if (target) void applyDrop(source, target, renderedContent)
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

provide(SUPERHIGH_UI_CONTEXT, { values, setValue, previewValue, clearPreview, emitAction, beginDrag, resolveImage, resolveMedia, resolvePlayableMedia, openResource, imageRevision, dragEnabled, scope })

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

<style>
.shui-root {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-family: var(--font-ui);
  font-weight: var(--font-ui-weight);
  font-size: 13px;
}

.shui-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  container-type: inline-size;
}

.shui-scroll.has-page { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.shui-page { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
.shui-page-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.shui-page-footer { flex: 0 1 auto; min-height: 0; max-height: 50%; overflow: auto; padding: 12px; border-top: 1px solid var(--color-border); background: var(--color-bg-primary); }

.shui-empty {
  color: var(--color-text-muted);
  font-size: 12px;
}

.shui-empty code,
.shui-text-code,
.shui-code pre {
  font-family: var(--font-mono);
  font-weight: var(--font-mono-weight);
}

/* ---- 布局 ---- */
.shui-list { display: flex; flex-direction: column; min-width: 0; }
.shui-list.gap-s { gap: 6px; }
.shui-list.gap-m { gap: 10px; }
.shui-list.gap-l { gap: 16px; }
.shui-row { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
.shui-row.align-center { justify-content: center; }
.shui-row.align-end { justify-content: flex-end; }
.shui-row.align-between { justify-content: space-between; }
.shui-row > .shui-item { min-width: 0; }
.shui-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fill, minmax(max(120px, calc((100% - (var(--shui-columns) - 1) * 8px) / var(--shui-columns))), 1fr));
}

.shui-item { position: relative; min-width: 0; }
.shui-grip {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: grab;
  opacity: 0;
  box-shadow: none;
}
.shui-item:hover:not(:has(.shui-item:hover)) > .shui-grip,
.shui-grip:focus-visible { opacity: 1; }
.shui-grip:hover { color: var(--color-text-primary); background: var(--color-bg-hover); }

.shui-root.is-dragging { cursor: grabbing; user-select: none; }
.shui-root.is-dragging .shui-list[data-shui-array]:empty {
  min-height: 24px;
  border: 1px dashed var(--color-border);
  border-radius: 4px;
}
.shui-drag-ghost {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 1000;
  max-height: 120px;
  overflow: hidden;
  opacity: 0.8;
  pointer-events: none;
  border: 1px solid var(--color-accent-blue);
  border-radius: 4px;
  background: var(--color-bg-primary);
}
.shui-drop-indicator {
  position: fixed;
  z-index: 1001;
  pointer-events: none;
  background: var(--color-accent-blue);
  border-radius: 1px;
}
.shui-drop-indicator.is-cli {
  display: grid;
  place-items: start center;
  padding-top: 12px;
  background: color-mix(in srgb, var(--color-accent-blue) 10%, transparent);
  border: 1px solid var(--color-accent-blue);
  border-radius: 4px;
}
.shui-drop-indicator.is-cli span {
  padding: 4px 8px;
  border-radius: 3px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 12px;
}

.shui-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-left-width: 3px;
  border-radius: 6px;
  background: var(--color-bg-secondary);
}
.shui-card.shui-tone-neutral { border-left-color: var(--color-border); }
.shui-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  margin: 0 18px 8px 0;
}
.shui-card-title { font-weight: var(--sh-weight-strong); }
.shui-card-subtitle { margin-left: auto; color: var(--color-text-muted); font-size: 12px; }

.shui-section { border-top: 1px solid var(--color-border); padding-top: 6px; }
.shui-section-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--color-text-primary);
  font: inherit;
  font-weight: var(--sh-weight-strong);
  text-align: left;
  cursor: pointer;
}
.shui-section-chevron { color: var(--color-text-muted); transition: transform 0.12s; }
.shui-section.is-open .shui-section-chevron { transform: rotate(90deg); }
.shui-section > .shui-list { margin-top: 6px; }

.shui-tabs-bar {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
}
.shui-tab {
  flex: none;
  padding: 5px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--color-text-secondary);
  font: inherit;
  cursor: pointer;
}
.shui-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent-blue); }
.shui-tab.is-previewing { color: var(--color-accent-blue); border-bottom-color: var(--color-accent-blue); background: var(--color-bg-hover); }
.shui-tabs-panel { padding-top: 8px; }

.shui-divider { height: 1px; background: var(--color-border); }
.shui-divider.has-label {
  display: flex;
  align-items: center;
  gap: 8px;
  height: auto;
  background: none;
  color: var(--color-text-muted);
  font-size: 12px;
}
.shui-divider.has-label::before,
.shui-divider.has-label::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }

/* ---- 内容 ---- */
.shui-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.shui-text-body { font-family: var(--font-content); font-weight: var(--font-content-weight); }
.shui-text-title { font-size: 16px; font-weight: var(--sh-weight-heading); }
.shui-text-subtitle { font-size: 14px; font-weight: var(--sh-weight-strong); }
.shui-text-strong { font-weight: var(--sh-weight-strong); }
.shui-text-muted { color: var(--color-text-muted); font-size: 12px; }
.shui-text-code { font-size: 12px; color: var(--color-text-secondary); }
.shui-markdown { min-width: 0; }
.shui-text.shui-markdown { white-space: normal; }
.shui-markdown > :first-child { margin-top: 0; }
.shui-markdown > :last-child { margin-bottom: 0; }
.shui-text.shui-markdown > p { font-size: inherit; font-weight: inherit; }
.shui-code-markdown { padding: 8px; }

.shui-tone-neutral { --shui-tone: var(--color-text-secondary); }
.shui-tone-info { --shui-tone: var(--color-accent-blue); }
.shui-tone-ok { --shui-tone: var(--color-accent-green); }
.shui-tone-warn { --shui-tone: var(--color-accent-yellow); }
.shui-tone-error { --shui-tone: var(--color-accent-red); }
.shui-card[class*='shui-tone-']:not(.shui-tone-neutral) { border-left-color: var(--shui-tone); }

.shui-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--shui-tone) 45%, transparent);
  border-radius: 3px;
  background: color-mix(in srgb, var(--shui-tone) 12%, transparent);
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.shui-callout {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--shui-tone) 40%, transparent);
  border-left: 3px solid var(--shui-tone);
  border-radius: 4px;
  background: color-mix(in srgb, var(--shui-tone) 8%, transparent);
  white-space: pre-wrap;
}

.shui-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
}
.shui-stat-label { color: var(--color-text-muted); font-size: 12px; }
.shui-stat-value { font-size: 18px; font-weight: var(--sh-weight-heading); font-variant-numeric: tabular-nums; }
.shui-stat-delta { font-size: 12px; color: var(--color-text-secondary); }
.shui-stat-delta::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 1px;
  background: var(--shui-tone);
  vertical-align: 1px;
}

.shui-kv {
  display: grid;
  grid-template-columns: minmax(72px, max-content) minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
}
.shui-kv dt { color: var(--color-text-muted); }
.shui-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

.shui-table-wrap { max-width: 100%; overflow-x: auto; border: 1px solid var(--color-border); border-radius: 4px; }
.shui-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.shui-table th,
.shui-table td { padding: 4px 8px; border-bottom: 1px solid var(--color-border); text-align: left; vertical-align: top; }
.shui-table tbody tr:last-child td { border-bottom: 0; }
.shui-table tbody tr:hover { background: var(--color-bg-hover); }
.shui-table th { position: sticky; top: 0; background: var(--color-bg-secondary); white-space: nowrap; }
.shui-table th button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-text-secondary);
  font: inherit;
  font-weight: var(--sh-weight-strong);
  cursor: pointer;
}
.shui-table td.is-number { text-align: right; font-variant-numeric: tabular-nums; }
.shui-sort-mark { margin-left: 3px; color: var(--color-accent-blue); }
.shui-table-view { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.shui-table-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.shui-table-tools .shui-input { width: auto; height: 24px; padding: 0 6px; font-size: 12px; }
.shui-table-search { flex: 1 1 160px; }
.shui-table-filter { flex: 0 1 auto; max-width: 180px; }
.shui-table-count { margin-left: auto; color: var(--color-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.shui-table td.shui-table-empty { padding: 10px 8px; color: var(--color-text-muted); text-align: center; }
.shui-table-pager { display: flex; align-items: center; justify-content: flex-end; gap: 6px; color: var(--color-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.shui-table-pager .shui-button { height: 22px; padding: 0 8px; font-size: 12px; }
.shui-button:disabled { opacity: 0.45; cursor: default; }
.shui-button:disabled:hover { background: var(--color-bg-secondary); }

.shui-bullets { margin: 0; padding-left: 20px; line-height: 1.6; }

.shui-steps { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.shui-steps li { display: flex; gap: 8px; align-items: flex-start; }
.shui-step-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  color: var(--color-text-muted);
  font-size: 11px;
}
.shui-steps .is-done .shui-step-mark { border-color: var(--color-accent-green); color: var(--color-accent-green); }
.shui-steps .is-active .shui-step-mark { border-color: var(--color-accent-blue); color: var(--color-accent-blue); }
.shui-steps .is-error .shui-step-mark { border-color: var(--color-accent-red); color: var(--color-accent-red); }
.shui-steps .is-pending .shui-step-title { color: var(--color-text-secondary); }
.shui-step-detail { color: var(--color-text-muted); font-size: 12px; }

.shui-progress-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; font-size: 12px; color: var(--color-text-secondary); }
.shui-progress-track { height: 6px; border-radius: 3px; background: var(--color-bg-tertiary, var(--color-bg-hover)); overflow: hidden; }
.shui-progress-track > div { height: 100%; border-radius: 3px; background: var(--shui-tone); }

.shui-chart { position: relative; min-width: 0; }
.shui-chart svg { display: block; max-width: 100%; overflow: visible; }
.shui-chart-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 4px; color: var(--color-text-secondary); font-size: 12px; }
.shui-chart-legend span { display: inline-flex; align-items: center; gap: 4px; }
.shui-chart-legend i,
.shui-chart-tooltip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.shui-chart-grid line { stroke: var(--color-border); stroke-width: 1; }
.shui-chart-grid text,
.shui-chart-label { fill: var(--color-text-muted); font-size: 10px; font-family: var(--font-ui); }
.shui-chart-crosshair { stroke: var(--color-text-muted); stroke-width: 1; stroke-dasharray: 2 2; }
.shui-chart-point { stroke: var(--color-bg-primary); stroke-width: 2; }
.shui-chart-tooltip {
  position: absolute;
  top: 0;
  z-index: 3;
  min-width: 140px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  font-size: 12px;
  pointer-events: none;
}
.shui-chart-tooltip div { display: flex; align-items: center; gap: 6px; }
.shui-chart-tooltip b { margin-left: auto; font-weight: var(--sh-weight-strong); font-variant-numeric: tabular-nums; }
.shui-chart-tooltip .shui-chart-total { margin-top: 2px; padding-top: 2px; border-top: 1px solid var(--color-border); color: var(--color-text-secondary); }

.shui-code { border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-secondary); min-width: 0; }
.shui-code-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 2px 8px; border-bottom: 1px solid var(--color-border); color: var(--color-text-muted); font-size: 11px; }
.shui-code pre { margin: 0; padding: 8px; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.shui-icon-button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
}
.shui-icon-button:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }

.shui-image { display: block; max-width: 100%; border-radius: 4px; }
.shui-scroll img { cursor: zoom-in; }
.shui-image-pending { height: 96px; }
.shui-resource-link { display: block; max-width: 100%; padding: 2px 0; border: 0; background: none; color: var(--color-accent-blue); font: inherit; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.shui-resource-link:hover { text-decoration: underline; }
.shui-media { display: block; width: 100%; max-height: 420px; }
.shui-model { width: 100%; height: 320px; min-width: 0; touch-action: none; }
.shui-model canvas { display: block; width: 100%; height: 100%; }

.shui-pending {
  min-height: 20px;
  padding: 2px 6px;
  border: 1px dashed var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 11px;
  animation: shui-pulse 1.2s ease-in-out infinite;
}
@keyframes shui-pulse { 50% { opacity: 0.45; } }

.shui-issue { margin-top: 2px; color: var(--color-accent-yellow); font-size: 11px; }
.shui-unknown {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--color-accent-yellow);
  border-radius: 4px;
  font-size: 12px;
}

/* ---- 输入 ---- */
.shui-button {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font: inherit;
  cursor: pointer;
  box-shadow: none;
}
.shui-button:hover { background: var(--color-bg-hover); }
.shui-button.shui-variant-primary { border-color: var(--color-accent-blue); background: var(--color-accent-blue); color: var(--color-bg-primary); }
.shui-button.shui-variant-primary:hover { background: color-mix(in srgb, var(--color-accent-blue) 85%, var(--color-bg-primary)); }
.shui-button.shui-variant-ghost { border-color: transparent; background: none; color: var(--color-text-secondary); }
.shui-button.shui-variant-ghost:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.shui-button.shui-variant-danger { border-color: color-mix(in srgb, var(--color-accent-red) 55%, transparent); color: var(--color-accent-red); }

.shui-form { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.shui-form-actions { display: flex; justify-content: flex-end; }

.shui-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.shui-field-inline { flex-direction: row; align-items: center; gap: 6px; cursor: pointer; }
.shui-field-label { color: var(--color-text-secondary); font-size: 12px; }
.shui-input {
  width: 100%;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-input-bg, var(--color-bg-secondary));
  color: var(--color-text-primary);
  font: inherit;
}
textarea.shui-input { resize: vertical; font-family: var(--font-content); }
.shui-checkbox { accent-color: var(--color-accent-blue); }
.shui-slider { display: flex; align-items: center; gap: 8px; }
.shui-slider input { flex: 1; min-width: 0; accent-color: var(--color-accent-blue); }
.shui-slider output { min-width: 32px; text-align: right; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
.shui-choice { display: flex; flex-wrap: wrap; gap: 4px; }
.shui-choice button {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font: inherit;
  cursor: pointer;
}
.shui-choice button.active { border-color: var(--color-accent-blue); background: color-mix(in srgb, var(--color-accent-blue) 16%, transparent); color: var(--color-text-primary); }
.shui-choice button.is-previewing { border-color: var(--color-accent-blue); color: var(--color-accent-blue); background: var(--color-bg-hover); }

.shui-sortlist { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.shui-sortlist li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary);
}
.shui-sortlist li.is-dragging { border-color: var(--color-accent-blue); }
.shui-sortlist-handle { display: grid; place-items: center; color: var(--color-text-muted); cursor: grab; touch-action: none; }
.shui-sortlist-index { min-width: 14px; color: var(--color-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }

/* ---- 状态栏 ---- */
.shui-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
  padding: 0 10px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 12px;
}
.shui-status-streaming::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 1px;
  background: var(--color-accent-blue);
  animation: shui-pulse 1s ease-in-out infinite;
}
.shui-status-problems { padding: 0; border: 0; background: none; color: var(--color-accent-yellow); font: inherit; cursor: pointer; }
.shui-status-refresh { padding: 0; border: 0; background: none; color: var(--color-text-secondary); font: inherit; cursor: pointer; }
.shui-status-refresh:hover { color: var(--color-text-primary); }
.shui-status-notice { margin-left: auto; color: var(--color-text-secondary); }
.shui-problems {
  max-height: 120px;
  overflow: auto;
  margin: 0;
  padding: 4px 10px 6px 24px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 12px;
}

@container (max-width: 380px) {
  .shui-row { flex-direction: column; align-items: stretch; }
  .shui-kv { grid-template-columns: minmax(0, 1fr); }
  .shui-kv dd { margin-bottom: 4px; }
}
</style>
