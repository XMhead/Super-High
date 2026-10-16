<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { backend, onAgentTurnChanges } from '@/lib/tauri'
import { escapeCode, highlightCode } from '@/lib/codeHighlight'
import { fileNameFromPath, inferLanguage } from '@/lib/path'
import { fileIconComponents, fileIconTone } from '@/lib/fileIcons'
import { scrollSpeedMultiplier } from '@/lib/scrollSpeed'
import { useWorkspaceStore } from '@/stores/workspace'
import type { AgentFileChange, AgentFileDiff, AgentTurnChanges } from '@/types'

const store = useWorkspaceStore()
const emit = defineEmits<{ (event: 'mode-change', changes: boolean): void }>()
const changes = ref<AgentTurnChanges | null>(null)
const diffs = ref<Record<string, AgentFileDiff>>({})
const selectedPath = ref<string | null>(null)
const closedPaths = ref<string[]>([])
const viewerOpen = ref(false)
const listOpen = ref(false)
const loading = ref(false)
const highlighted = ref<Record<string, string[]>>({})
const anchorElement = ref<HTMLElement | null>(null)
const rowsElement = ref<HTMLElement | null>(null)
const tabsElement = ref<HTMLElement | null>(null)
const sessionId = computed(() => store.activeCliTerminalSession?.id ?? '')
const scope = computed(() => JSON.stringify([sessionId.value, store.workspace?.rootPath, store.activeCliTerminalSession?.cwd]))
const files = computed(() => changes.value?.files ?? [])
const visibleFiles = computed(() => files.value.filter(file => !closedPaths.value.includes(file.path)))
// 下方差异区按标签切换，只显示当前文件；未选时默认第一个。
const activeFile = computed(() => visibleFiles.value.find(file => file.path === selectedPath.value) ?? visibleFiles.value[0] ?? null)
const showSummary = computed(() => !!sessionId.value && !!changes.value && (!changes.value.available || files.value.length > 0))
let requestToken = 0
let scopeToken = 0
let disposed = false
let unlisten: (() => void) | undefined
let pendingKind: 'add' | 'del' | undefined

function setMode(open: boolean) {
  viewerOpen.value = open
  emit('mode-change', open)
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!listOpen.value && !viewerOpen.value)) return
  event.stopPropagation()
  if (listOpen.value) listOpen.value = false
  else closeViewer()
}
function onOutsidePointer(event: PointerEvent) {
  if (listOpen.value && event.target instanceof Node && !anchorElement.value?.contains(event.target)) listOpen.value = false
}
function closeViewer() {
  setMode(false)
  listOpen.value = false
}
function apply(next: AgentTurnChanges) {
  if (disposed || next.sessionId !== sessionId.value) return
  if (changes.value && next.revision < changes.value.revision) return
  const changed = !changes.value || next.turnId !== changes.value.turnId || next.revision !== changes.value.revision
  const newTurn = !!changes.value && next.turnId !== changes.value.turnId
  changes.value = next
  if (!changed) return
  requestToken += 1
  diffs.value = {}
  highlighted.value = {}
  loading.value = false
  closedPaths.value = newTurn ? [] : closedPaths.value.filter(path => files.value.some(file => file.path === path))
  if (newTurn || !files.value.some(file => file.path === selectedPath.value)) selectedPath.value = null
  if (viewerOpen.value && files.value.length) void loadDiffs()
}
async function refresh(token: number) {
  const id = sessionId.value
  if (!id) return
  try {
    const next = await backend.getAgentTurnChanges(id)
    if (token === scopeToken) apply(next)
  } catch (error) {
    if (token !== scopeToken || changes.value) return
    apply({ sessionId: id, providerKind: store.activeCliTerminalSession?.providerKind ?? '', nativeSessionId: null, turnId: null, revision: 0, available: false, reason: String(error), completed: false, files: [], additions: 0, deletions: 0 })
  }
}
async function loadDiffs() {
  const current = changes.value
  const token = ++requestToken
  diffs.value = {}
  highlighted.value = {}
  if (!current?.available || !current.files.length || !viewerOpen.value) { loading.value = false; return }
  loading.value = true
  const results = await Promise.all(current.files.map(async (file): Promise<AgentFileDiff> => {
    try {
      return await backend.getAgentTurnFileDiff(current.sessionId, current.turnId, file.path)
    } catch (error) {
      return { sessionId: current.sessionId, turnId: current.turnId, revision: current.revision, available: false, reason: String(error), file, rows: [] }
    }
  }))
  if (token !== requestToken || disposed) return
  const next: Record<string, AgentFileDiff> = {}
  const plain: Record<string, string[]> = {}
  current.files.forEach((file, index) => {
    const value = results[index]
    if (value.sessionId !== sessionId.value || value.turnId !== changes.value?.turnId || value.revision !== changes.value?.revision) return
    next[file.path] = value
    plain[file.path] = value.rows.map(row => escapeCode(row.text))
  })
  diffs.value = next
  highlighted.value = plain
  loading.value = false
  for (const [path, value] of Object.entries(next)) void colorRows(value, token, path)
  await nextTick()
  if (token !== requestToken || disposed) return
  revealSelection()
}
function revealSelection() {
  const root = rowsElement.value
  if (!root) return
  root.scrollTop = 0
  if (pendingKind) root.querySelector<HTMLElement>(`[data-kind="${pendingKind}"]`)?.scrollIntoView?.({ block: 'center' })
  pendingKind = undefined
  tabsElement.value?.querySelector<HTMLElement>('.editor-tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}
function handleTabsWheel(event: WheelEvent) {
  const tabs = tabsElement.value
  if (!tabs || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || tabs.scrollWidth <= tabs.clientWidth) return
  event.preventDefault()
  tabs.scrollLeft += event.deltaY * scrollSpeedMultiplier(store.settings.scrollSpeedPercent)
}
function onTabKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const key = event.key.toLowerCase()
  const direction = key === 'arrowleft' || key === 'a' ? -1 : key === 'arrowright' || key === 'd' ? 1 : 0
  if (!direction || !(event.target instanceof Element) || !event.target.closest('.editor-tab-main')) return
  const index = visibleFiles.value.findIndex(file => file.path === activeFile.value?.path)
  if (index < 0) return
  event.preventDefault()
  selectFile(visibleFiles.value[(index + direction + visibleFiles.value.length) % visibleFiles.value.length])
  void nextTick(() => tabsElement.value?.querySelector<HTMLButtonElement>('.editor-tab.active .editor-tab-main')?.focus())
}
function closeFileTab(file: AgentFileChange) {
  const index = visibleFiles.value.findIndex(value => value.path === file.path)
  const wasActive = activeFile.value?.path === file.path
  closedPaths.value = [...closedPaths.value, file.path]
  if (!visibleFiles.value.length) { closeViewer(); return }
  if (wasActive) selectFile(visibleFiles.value[Math.min(index, visibleFiles.value.length - 1)])
}
async function colorRows(next: AgentFileDiff, token: number, path: string) {
  const language = inferLanguage(path)
  const html = await Promise.all(next.rows.map(async row => {
    try { return await highlightCode(row.text, language) } catch { return escapeCode(row.text) }
  }))
  if (!disposed && token === requestToken && next.revision === changes.value?.revision && next.turnId === changes.value?.turnId) highlighted.value = { ...highlighted.value, [path]: html }
}
function selectFile(file: AgentFileChange, kind?: 'add' | 'del') {
  closedPaths.value = closedPaths.value.filter(path => path !== file.path)
  selectedPath.value = file.path
  pendingKind = kind
  listOpen.value = false
  if (viewerOpen.value && !loading.value && Object.keys(diffs.value).length) {
    void nextTick(revealSelection)
    return
  }
  setMode(true)
  void loadDiffs()
}
function openFirst(kind: 'add' | 'del') {
  const file = files.value.find(file => kind === 'add' ? file.additions > 0 : file.deletions > 0)
  if (file) selectFile(file, kind)
}
function fileLabel(file: AgentFileChange) {
  return file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path
}
watch(scope, () => {
  scopeToken += 1
  requestToken += 1
  changes.value = null
  diffs.value = {}
  highlighted.value = {}
  selectedPath.value = null
  closedPaths.value = []
  pendingKind = undefined
  loading.value = false
  closeViewer()
  void refresh(scopeToken)
}, { immediate: true })
onMounted(async () => {
  document.addEventListener('pointerdown', onOutsidePointer)
  try {
    const cleanup = await onAgentTurnChanges(apply)
    if (disposed) cleanup()
    else { unlisten = cleanup; void refresh(scopeToken) }
  } catch { /* Native event bridge may be unavailable in browser previews. */ }
})
onBeforeUnmount(() => { disposed = true; requestToken += 1; scopeToken += 1; unlisten?.(); document.removeEventListener('pointerdown', onOutsidePointer) })
</script>

<template>
  <div class="previewchanges" @keydown="onKeydown">
    <section v-if="viewerOpen" class="previewchanges-viewer" data-testid="previewchanges-viewer" aria-label="本轮工具变更">
      <header class="previewchanges-header">
        <span class="previewchanges-title">
          <template v-if="changes?.available && files.length">{{ files.length }} 个文件变更 <span class="previewchanges-add">+{{ changes.additions }}</span> <span class="previewchanges-del">-{{ changes.deletions }}</span></template>
          <template v-else>本轮工具变更</template>
        </span>
        <button aria-label="返回文件预览" title="返回文件预览" @click="closeViewer"><X :size="14" /></button>
      </header>
      <div v-if="changes?.available && files.length" class="tabs-strip">
        <div ref="tabsElement" class="editor-tabs-list" role="tablist" aria-label="本轮改动文件" @wheel="handleTabsWheel" @keydown="onTabKeydown">
          <div v-for="file in visibleFiles" :key="file.path" class="editor-tab" :class="{ active: file.path === activeFile?.path }">
            <button class="editor-tab-main" role="tab" :aria-selected="file.path === activeFile?.path" :title="`${fileLabel(file)} (+${file.additions} -${file.deletions})`" @click="selectFile(file)">
              <span class="tree-kind-icon" :class="fileIconTone(file.path)" aria-hidden="true">
                <component :is="fileIconComponents[fileIconTone(file.path)]" :size="15" :stroke-width="1.9" />
              </span>
              <span class="tab-name">{{ fileNameFromPath(file.path) }}</span>
            </button>
            <button class="tab-close" type="button" title="关闭" :aria-label="`关闭 ${fileNameFromPath(file.path)} 变更标签`" @click.stop="closeFileTab(file)">×</button>
          </div>
        </div>
      </div>
      <div ref="rowsElement" class="previewchanges-scroll">
        <div v-if="!changes?.available" class="previewchanges-empty">{{ changes?.reason ?? '暂无工具变更' }}</div>
        <div v-else-if="!files.length" class="previewchanges-empty">本轮暂无改动</div>
        <div v-else-if="loading" class="previewchanges-empty">正在加载差异…</div>
        <section v-else-if="activeFile" :key="activeFile.path" class="previewchanges-file-section" :data-path="activeFile.path" role="tabpanel">
          <div v-if="!diffs[activeFile.path]" class="previewchanges-empty">无法显示差异</div>
          <div v-else-if="!diffs[activeFile.path].available" class="previewchanges-empty">{{ diffs[activeFile.path].reason ?? '无法显示差异' }}</div>
          <div v-else-if="!diffs[activeFile.path].rows.length" class="previewchanges-empty">该文件暂无文本差异</div>
          <div v-else class="previewchanges-rows">
            <template v-for="(row, index) in diffs[activeFile.path].rows" :key="index">
              <div v-if="row.kind === 'gap'" class="previewchanges-gap">{{ row.text || '…' }}</div>
              <div v-else class="previewchanges-row" :class="row.kind" :data-kind="row.kind">
                <span class="previewchanges-line">{{ row.kind === 'del' ? row.oldLine : row.newLine }}</span><span class="previewchanges-mark">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ' }}</span><span class="previewchanges-code hljs" v-html="highlighted[activeFile.path]?.[index] ?? escapeCode(row.text)" />
              </div>
            </template>
          </div>
        </section>
      </div>
    </section>
    <div v-if="showSummary" ref="anchorElement" class="previewchanges-anchor" data-testid="previewchanges-summary" @focusout="event => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) listOpen = false }">
      <div v-if="listOpen && changes?.available" class="previewchanges-list" role="listbox" aria-label="本轮改动文件">
        <div v-for="file in files" :key="file.path" class="previewchanges-file">
          <button class="previewchanges-path" :title="file.path" @click="selectFile(file)">{{ fileLabel(file) }}</button>
          <button class="previewchanges-add" :aria-label="`${file.path} 新增行`" @click="selectFile(file, 'add')">+{{ file.additions }}</button>
          <button class="previewchanges-del" :aria-label="`${file.path} 删除行`" @click="selectFile(file, 'del')">-{{ file.deletions }}</button>
        </div>
      </div>
      <div class="previewchanges-summary">
        <template v-if="changes?.available">
          <button :aria-expanded="listOpen" @click="listOpen = !listOpen">{{ files.length }} 个文件</button>
          <button class="previewchanges-add" title="定位首个新增片段" @click="openFirst('add')">+{{ changes.additions }}</button>
          <button class="previewchanges-del" title="定位首个删除片段" @click="openFirst('del')">-{{ changes.deletions }}</button>
        </template>
        <span v-else class="previewchanges-unavailable" :title="changes?.reason ?? '暂无工具变更'">{{ changes?.reason ?? '暂无工具变更' }}</span>
      </div>
    </div>
  </div>
</template>
