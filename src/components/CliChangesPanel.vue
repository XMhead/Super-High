<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, ExternalLink, FileDiff, RefreshCw } from 'lucide-vue-next'
import { backend, isTauri, onTerminalOutput, onWorkspaceFilesChanged } from '@/lib/tauri'
import { highlightCode } from '@/lib/codeHighlight'
import { inferLanguage } from '@/lib/path'
import type { SessionChanges, SessionFileChange, SessionFileDiff } from '@/types'

const props = defineProps<{
  sessionId: string
  cwd: string
  running: boolean
}>()

const emit = defineEmits<{
  (event: 'open-file', path: string, lineNumber?: number): void
}>()

const EXPANDED_KEY = 'superhigh.cliChanges.expanded'
const HEIGHT_KEY = 'superhigh.cliChanges.height'
const MIN_HEIGHT = 140
const RENDER_REGION_MIN = 280

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function writeStorage(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}

const available = isTauri()
const changes = ref<SessionChanges | null>(null)
const loading = ref(false)
const expanded = ref(readStorage(EXPANDED_KEY) === '1')
const bodyHeight = ref(Math.max(MIN_HEIGHT, Number(readStorage(HEIGHT_KEY)) || 300))
const showFolded = ref(false)
const showPreSession = ref(false)
const selectedBySession = ref<Record<string, string | undefined>>({})
const diff = ref<SessionFileDiff | null>(null)
const diffLoading = ref(false)
const highlighted = ref<string[]>([])
const panel = ref<HTMLElement | null>(null)
let lastFingerprint = ''

const files = computed(() => changes.value?.files ?? [])
const sessionFiles = computed(() => files.value.filter((file) => !file.preSession))
const mainFiles = computed(() => sessionFiles.value.filter((file) => file.kind === 'source'))
const foldedFiles = computed(() => sessionFiles.value.filter((file) => file.kind !== 'source'))
const preSessionFiles = computed(() => files.value.filter((file) => file.preSession))
const totals = computed(() => sessionFiles.value.reduce(
  (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
  { additions: 0, deletions: 0 },
))
const selectedPath = computed(() => {
  const chosen = selectedBySession.value[props.sessionId]
  if (chosen && files.value.some((file) => file.path === chosen)) return chosen
  // Earlier edits are only shown when picked explicitly, like Claude Code's "(show)".
  return (mainFiles.value[0] ?? foldedFiles.value[0])?.path ?? null
})
const selectedFile = computed(() => files.value.find((file) => file.path === selectedPath.value) ?? null)
const language = computed(() => selectedPath.value ? inferLanguage(selectedPath.value) : 'plaintext')

const summaryLabel = computed(() => {
  if (!changes.value) return loading.value ? '正在统计改动…' : ''
  if (!changes.value.available) return changes.value.reason ?? '无法统计改动'
  const count = sessionFiles.value.length
  return count ? `${count} 个文件已更改` : '本会话暂无改动'
})
const baselineNote = computed(() => {
  if (!changes.value?.available) return ''
  if (changes.value.baseline === 'head') return '会话启动时未记录基线，改动按 Git HEAD 统计'
  if (changes.value.mode === 'plain') return '非 Git 目录：按会话启动时的文件快照统计'
  return ''
})

type ListRow =
  | { type: 'file'; file: SessionFileChange }
  | { type: 'toggle'; key: 'folded' | 'pre'; label: string; open: boolean }

const listRows = computed<ListRow[]>(() => {
  const rows: ListRow[] = mainFiles.value.map((file) => ({ type: 'file', file }))
  if (foldedFiles.value.length) {
    rows.push({ type: 'toggle', key: 'folded', label: `${foldedFiles.value.length} 个测试/生成文件`, open: showFolded.value })
    if (showFolded.value) rows.push(...foldedFiles.value.map((file) => ({ type: 'file' as const, file })))
  }
  if (preSessionFiles.value.length) {
    rows.push({ type: 'toggle', key: 'pre', label: `${preSessionFiles.value.length} 个文件在本会话前已修改`, open: showPreSession.value })
    if (showPreSession.value) rows.push(...preSessionFiles.value.map((file) => ({ type: 'file' as const, file })))
  }
  return rows
})

/** Line to reveal for a diff row; deleted lines map to the nearest following new line. */
function rowLine(index: number): number | undefined {
  const rows = diff.value?.rows ?? []
  for (let i = index; i < rows.length; i += 1) {
    if (rows[i].kind === 'gap') break
    if (rows[i].newLine) return rows[i].newLine
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i].kind === 'gap') break
    if (rows[i].newLine) return rows[i].newLine
  }
  return undefined
}

function toggleGroup(key: 'folded' | 'pre') {
  if (key === 'folded') showFolded.value = !showFolded.value
  else showPreSession.value = !showPreSession.value
}

function fileName(path: string) {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(index + 1) : path
}
function fileDir(path: string) {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(0, index + 1) : ''
}
function statusLetter(file: SessionFileChange) {
  return file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'
}
function countsKnown(file: SessionFileChange) {
  return file.additions != null && file.deletions != null
}

let refreshing = false
let refreshQueued = false
async function refresh() {
  if (!available || !props.sessionId || !props.cwd) return
  if (refreshing) {
    refreshQueued = true
    return
  }
  refreshing = true
  loading.value = true
  const sessionId = props.sessionId
  try {
    const next = await backend.getSessionChanges(sessionId, props.cwd)
    if (sessionId !== props.sessionId) return
    changes.value = next
    const fingerprint = JSON.stringify(next.files.map((file) => [file.path, file.status, file.additions, file.deletions]))
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint
      if (expanded.value) void loadDiff()
    }
  } catch (error) {
    if (sessionId === props.sessionId) {
      changes.value = { available: false, reason: String(error), mode: '', root: '', baseline: '', capturedAtMs: null, files: [], truncated: false }
    }
  } finally {
    refreshing = false
    loading.value = false
    if (refreshQueued) {
      refreshQueued = false
      void refresh()
    }
  }
}

let diffToken = 0
async function loadDiff() {
  const path = selectedPath.value
  const token = ++diffToken
  if (!available || !path || !expanded.value) {
    diff.value = null
    highlighted.value = []
    return
  }
  diffLoading.value = true
  try {
    const next = await backend.getSessionFileDiff(props.sessionId, props.cwd, path)
    if (token !== diffToken) return
    diff.value = next
    highlighted.value = next.rows.map((row) => escapeHtml(row.text))
    void highlightRows(next, token)
  } catch (error) {
    if (token === diffToken) {
      diff.value = { file: null, rows: [], truncated: false, tooLarge: false, unavailableBase: false }
      highlighted.value = []
    }
  } finally {
    if (token === diffToken) diffLoading.value = false
  }
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const highlightCache = new Map<string, string>()
async function highlightRows(next: SessionFileDiff, token: number) {
  const lang = language.value
  if (lang === 'plaintext') return
  const output: string[] = []
  for (const row of next.rows) {
    const key = `${lang}\u0000${row.text}`
    let html = highlightCache.get(key)
    if (html === undefined) {
      try { html = await highlightCode(row.text, lang) } catch { html = escapeHtml(row.text) }
      if (highlightCache.size > 5000) highlightCache.clear()
      highlightCache.set(key, html)
    }
    output.push(html)
  }
  if (token === diffToken) highlighted.value = output
}

function toggleExpanded() {
  expanded.value = !expanded.value
  writeStorage(EXPANDED_KEY, expanded.value ? '1' : '0')
  if (expanded.value) {
    void refresh()
    void loadDiff()
  }
}

function selectFile(file: SessionFileChange) {
  selectedBySession.value = { ...selectedBySession.value, [props.sessionId]: file.path }
  if (!expanded.value) toggleExpanded()
}

function openFile(file: SessionFileChange | null, lineNumber?: number) {
  if (!file || file.status === 'deleted') return
  emit('open-file', file.absolutePath, lineNumber)
}

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && expanded.value) {
    event.stopPropagation()
    toggleExpanded()
  }
}

function maxBodyHeight() {
  const element = panel.value
  const body = element?.closest('.terminal-body') as HTMLElement | null
  const region = element?.closest('.cli-conversation-region') as HTMLElement | null
  const current = element?.querySelector('.cli-changes-body') as HTMLElement | null
  if (!body || !region || !current) return 600
  const others = region.offsetHeight - current.offsetHeight
  return Math.max(MIN_HEIGHT, body.clientHeight - RENDER_REGION_MIN - others)
}

function startResize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement
  const startY = event.clientY
  const startHeight = bodyHeight.value
  const max = maxBodyHeight()
  handle.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    bodyHeight.value = Math.round(Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - moveEvent.clientY)))
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    writeStorage(HEIGHT_KEY, String(bodyHeight.value))
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

function normalize(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function relatedToRoot(path: string) {
  const roots = [changes.value?.root, props.cwd].filter((root): root is string => !!root).map(normalize)
  const target = normalize(path)
  return roots.some((root) => target === root || target.startsWith(`${root}/`) || root.startsWith(`${target}/`))
}

let workspaceTimer: number | null = null
let outputTimer: number | null = null
let pollTimer: number | null = null
const unlisteners: Array<() => void> = []

function scheduleRefresh(kind: 'workspace' | 'output') {
  if (kind === 'workspace') {
    if (workspaceTimer != null) window.clearTimeout(workspaceTimer)
    workspaceTimer = window.setTimeout(() => { workspaceTimer = null; void refresh() }, 400)
  } else if (outputTimer == null) {
    // CLI spinners print continuously; refresh at most every 2s while output flows.
    outputTimer = window.setTimeout(() => { outputTimer = null; void refresh() }, 2000)
  }
}

function syncPolling() {
  if (pollTimer != null) window.clearInterval(pollTimer)
  pollTimer = null
  if (available && props.running) pollTimer = window.setInterval(() => void refresh(), 5000)
}

watch(() => [props.sessionId, props.cwd], () => {
  changes.value = null
  diff.value = null
  lastFingerprint = ''
  void refresh()
})
watch(() => props.running, syncPolling)
watch(selectedPath, () => void loadDiff())

onMounted(async () => {
  if (!available) return
  void refresh()
  syncPolling()
  // Event subscriptions only speed up refreshes; polling still covers a failed listen.
  try {
    unlisteners.push(await onWorkspaceFilesChanged((event) => {
      if (relatedToRoot(event.rootPath) || event.changedPaths.some(relatedToRoot)) scheduleRefresh('workspace')
    }))
    unlisteners.push(await onTerminalOutput((event) => {
      if (event.sessionId === props.sessionId) scheduleRefresh('output')
    }))
  } catch { /* listeners unavailable */ }
  await nextTick()
  if (expanded.value) bodyHeight.value = Math.min(bodyHeight.value, maxBodyHeight())
})

onBeforeUnmount(() => {
  unlisteners.splice(0).forEach((unlisten) => unlisten())
  if (workspaceTimer != null) window.clearTimeout(workspaceTimer)
  if (outputTimer != null) window.clearTimeout(outputTimer)
  if (pollTimer != null) window.clearInterval(pollTimer)
})
</script>

<template>
  <section
    v-if="available"
    ref="panel"
    class="cli-changes-panel"
    :class="{ expanded }"
    data-testid="cli-changes-panel"
    @keydown="onPanelKeydown"
  >
    <div
      v-if="expanded"
      class="cli-changes-resize"
      title="拖动调整高度"
      @pointerdown.prevent="startResize"
    />
    <div class="cli-changes-bar">
      <button
        type="button"
        class="cli-changes-toggle"
        :aria-expanded="expanded"
        :title="expanded ? '收起改动面板（Esc）' : '展开改动面板'"
        data-testid="cli-changes-toggle"
        @click="toggleExpanded"
      >
        <ChevronDown v-if="expanded" :size="13" />
        <ChevronRight v-else :size="13" />
        <FileDiff :size="13" class="cli-changes-icon" />
        <span class="cli-changes-summary" data-testid="cli-changes-summary">{{ summaryLabel }}</span>
        <template v-if="sessionFiles.length">
          <span class="cli-changes-add">+{{ totals.additions }}</span>
          <span class="cli-changes-del">-{{ totals.deletions }}</span>
        </template>
        <span v-if="!sessionFiles.length && preSessionFiles.length" class="cli-changes-muted">
          · {{ preSessionFiles.length }} 个会话前改动
        </span>
      </button>
      <div v-if="!expanded && sessionFiles.length" class="cli-changes-chips">
        <button
          v-for="file in sessionFiles"
          :key="file.path"
          type="button"
          class="cli-changes-chip"
          :class="file.status"
          :title="`${file.path}  +${file.additions ?? '?'} -${file.deletions ?? '?'}`"
          @click="selectFile(file)"
        >{{ fileName(file.path) }}</button>
      </div>
      <button
        type="button"
        class="cli-changes-icon-button"
        :class="{ spinning: loading }"
        title="刷新改动"
        aria-label="刷新改动"
        @click="refresh"
      >
        <RefreshCw :size="12" />
      </button>
    </div>

    <div v-if="expanded" class="cli-changes-body" :style="{ height: `${bodyHeight}px` }">
      <div v-if="!files.length" class="cli-changes-empty">
        {{ changes?.available === false ? summaryLabel : (loading && !changes ? '正在统计改动…' : '本会话暂无改动') }}
        <small v-if="baselineNote">{{ baselineNote }}</small>
      </div>
      <template v-else>
        <div class="cli-changes-list" role="listbox" aria-label="改动文件" data-testid="cli-changes-list">
          <template v-for="row in listRows" :key="row.type === 'file' ? `f:${row.file.path}` : `t:${row.key}`">
            <button
              v-if="row.type === 'file'"
              type="button"
              class="cli-changes-file"
              :class="{ active: row.file.path === selectedPath, pre: row.file.preSession }"
              role="option"
              :aria-selected="row.file.path === selectedPath"
              :title="row.file.path"
              data-testid="cli-changes-file"
              @click="selectFile(row.file)"
              @dblclick="openFile(row.file)"
            >
              <span class="cli-changes-status" :class="row.file.status">{{ statusLetter(row.file) }}</span>
              <span class="cli-changes-path">
                <span class="cli-changes-name">{{ fileName(row.file.path) }}</span>
                <span class="cli-changes-dir">{{ fileDir(row.file.path) }}</span>
              </span>
              <span v-if="countsKnown(row.file)" class="cli-changes-counts">
                <span class="cli-changes-add">+{{ row.file.additions }}</span>
                <span class="cli-changes-del">-{{ row.file.deletions }}</span>
              </span>
              <span v-else class="cli-changes-muted">{{ row.file.binary ? '二进制' : '已更改' }}</span>
            </button>
            <button
              v-else
              type="button"
              class="cli-changes-group"
              :aria-expanded="row.open"
              @click="toggleGroup(row.key)"
            >
              <ChevronDown v-if="row.open" :size="12" />
              <ChevronRight v-else :size="12" />
              <span>{{ row.label }}</span>
            </button>
          </template>
          <div v-if="baselineNote" class="cli-changes-note">{{ baselineNote }}</div>
          <div v-if="changes?.truncated" class="cli-changes-note">文件较多，仅显示部分改动</div>
        </div>

        <div class="cli-changes-diff" data-testid="cli-changes-diff">
          <div v-if="selectedFile" class="cli-changes-diff-header">
            <span class="cli-changes-diff-path" :title="selectedFile.absolutePath">{{ selectedFile.path }}</span>
            <span v-if="selectedFile.preSession" class="cli-changes-muted">会话前改动 · 对比 HEAD</span>
            <span v-if="countsKnown(selectedFile)" class="cli-changes-counts">
              <span class="cli-changes-add">+{{ selectedFile.additions }}</span>
              <span class="cli-changes-del">-{{ selectedFile.deletions }}</span>
            </span>
            <button
              type="button"
              class="cli-changes-icon-button"
              title="在编辑器中打开"
              aria-label="在编辑器中打开"
              :disabled="selectedFile.status === 'deleted'"
              @click="openFile(selectedFile)"
            >
              <ExternalLink :size="12" />
            </button>
          </div>
          <div class="cli-changes-diff-scroll">
            <div v-if="!selectedFile" class="cli-changes-empty">本会话暂无改动</div>
            <div v-else-if="diff?.unavailableBase" class="cli-changes-empty">会话启动时未保存该文件内容（文件较大），无法显示差异</div>
            <div v-else-if="diff?.file?.binary" class="cli-changes-empty">二进制文件，不显示差异</div>
            <div v-else-if="diff?.tooLarge" class="cli-changes-empty">文件过大，不显示差异</div>
            <div v-else-if="diff && !diff.file" class="cli-changes-empty">该文件已无改动</div>
            <div v-else-if="!diff && diffLoading" class="cli-changes-empty">正在加载差异…</div>
            <div v-else-if="diff" class="cli-changes-rows">
              <template v-for="(row, index) in diff.rows" :key="index">
                <div v-if="row.kind === 'gap'" class="cli-diff-gap" aria-hidden="true" />
                <div
                  v-else
                  class="cli-diff-row"
                  :class="row.kind"
                  :title="selectedFile?.status === 'deleted' ? undefined : '点击跳转到该行'"
                  data-testid="cli-changes-row"
                  @click="openFile(selectedFile, rowLine(index))"
                >
                  <span class="cli-diff-line">{{ row.kind === 'del' ? row.oldLine : row.newLine }}</span>
                  <span class="cli-diff-sign">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : '' }}</span>
                  <span class="cli-diff-code hljs" v-html="highlighted[index] ?? ''" />
                </div>
              </template>
              <div v-if="diff.truncated" class="cli-changes-note">差异过长，仅显示前一部分</div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
