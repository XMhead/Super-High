<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type FontWeight } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FolderGit2, Play, RefreshCw, Square } from 'lucide-vue-next'

import { buildTerminalTheme, getTheme } from '@/lib/theme'
import { backend, onTerminalExit, onTerminalOutput } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { GitHubRepoSummary, GitReplayOrder, GitReplayStatus } from '@/types'

type ReplaySelection = { kind: 'workspace' } | { kind: 'repo', nameWithOwner: string }
type ReplayPhase = 'idle' | 'preparing' | 'running' | 'ended'
type PendingEvent = { sessionId: string, chunk?: string, exited?: boolean }

const props = defineProps<{ active: boolean, workspaceIsRepo: boolean }>()
const REPO_REFRESH_INTERVAL_MS = 5 * 60_000

const ORDER_OPTIONS: { label: string, value: GitReplayOrder }[] = [
  { label: '从最早', value: 'asc' },
  { label: '从最新', value: 'desc' },
  { label: '随机', value: 'random' },
]
const SPEED_OPTIONS = [
  { label: '快速', value: 10 },
  { label: '中速', value: 30 },
  { label: '慢速', value: 60 },
]

const store = useWorkspaceStore()
const rootPath = computed(() => store.workspace?.rootPath ?? '')
const repos = ref<GitHubRepoSummary[]>([])
const reposLoading = ref(false)
const reposError = ref('')
const query = ref('')
const login = ref<string | null>(null)
const replayStatus = ref<GitReplayStatus | null>(null)
const selection = ref<ReplaySelection | null>(null)
const workspaceIsRepo = computed(() => props.workspaceIsRepo)
const order = ref<GitReplayOrder>('asc')
const speed = ref(30)
const onlyMine = ref(false)
const phase = ref<ReplayPhase>('idle')
const runError = ref('')
const targetLabel = ref('')
const host = ref<HTMLDivElement | null>(null)

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let sessionId: string | null = null
let pendingEvents: PendingEvent[] | null = null
let runToken = 0
let disposed = false
let refreshing: Promise<void> | null = null
let lastRefreshAt = 0
const unlisteners: Array<() => void> = []

const workspaceName = computed(() => store.workspace?.displayName || store.workspace?.name || '当前项目')
const filteredRepos = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return repos.value
  return repos.value.filter((repo) => (
    repo.nameWithOwner.toLowerCase().includes(text)
    || (repo.description ?? '').toLowerCase().includes(text)
  ))
})
const selectionTitle = computed(() => {
  const current = selection.value
  if (!current) return '选择仓库'
  return current.kind === 'workspace' ? workspaceName.value : current.nameWithOwner
})
const canStart = computed(() => (
  !!selection.value
  && !!replayStatus.value?.installed
  && phase.value !== 'preparing'
  && (selection.value.kind !== 'workspace' || workspaceIsRepo.value)
))
const overlayText = computed(() => {
  if (replayStatus.value && !replayStatus.value.installed) {
    return `未检测到 gitlogue。在终端运行 ${replayStatus.value.installCommand} 安装后点击刷新。`
  }
  if (runError.value) return runError.value
  if (phase.value === 'preparing') return targetLabel.value || '正在准备仓库…'
  if (phase.value === 'idle') return '在左侧选择仓库开始回放'
  return ''
})
const phaseLabel = computed(() => {
  if (phase.value === 'preparing') return '准备中'
  if (phase.value === 'running') return targetLabel.value
  if (phase.value === 'ended') return '已结束'
  return ''
})

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function repoName(nameWithOwner: string) {
  return nameWithOwner.split('/').pop() || nameWithOwner
}

function formatPushedAt(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

async function loadRepos() {
  reposLoading.value = true
  reposError.value = ''
  try {
    const next = await backend.githubRepoList()
    if (!disposed) repos.value = next
  } catch (error) {
    if (!disposed) reposError.value = errorMessage(error)
  } finally {
    reposLoading.value = false
  }
}

async function loadStatus() {
  try {
    replayStatus.value = await backend.gitReplayStatus()
  } catch (error) {
    runError.value = errorMessage(error)
  }
  try {
    const account = await backend.githubAccountStatus()
    login.value = account.authenticated ? account.login : null
  } catch {
    login.value = null
  }
}

function refreshAll() {
  if (refreshing) return refreshing
  refreshing = Promise.all([loadStatus(), loadRepos()]).then(() => {
    lastRefreshAt = Date.now()
  }).finally(() => { refreshing = null })
  return refreshing
}

function monoFontFamily() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
}

function monoFontWeight(): FontWeight {
  const weight = Number(getComputedStyle(document.documentElement).getPropertyValue('--font-mono-weight'))
  return weight > 0 ? weight : 'normal'
}

function fitAndResize() {
  if (!terminal || !fitAddon || !host.value?.clientWidth) return
  fitAddon.fit()
  if (sessionId) void backend.resizeTerminal(sessionId, terminal.cols, terminal.rows).catch(() => {})
}

async function ensureTerminal() {
  if (terminal || !host.value) return
  const family = monoFontFamily()
  if (family && document.fonts) {
    await document.fonts.load(`${monoFontWeight()} 13px ${family}`).catch(() => [])
  }
  if (disposed || terminal || !host.value) return
  fitAddon = new FitAddon()
  terminal = new Terminal({
    cursorBlink: false,
    fontFamily: family,
    fontWeight: monoFontWeight(),
    fontSize: 13,
    scrollback: 0,
    allowTransparency: getTheme(store.currentThemeId).surfaceOpacity != null,
    theme: buildTerminalTheme(store.currentThemeId),
  })
  terminal.loadAddon(fitAddon)
  terminal.open(host.value)
  // gitlogue reads keys (space, n/p, Esc, q) from stdin.
  terminal.onData((data) => {
    if (sessionId) void backend.writeTerminalInput(sessionId, data).catch(() => {})
  })
  resizeObserver = new ResizeObserver(() => fitAndResize())
  resizeObserver.observe(host.value)
  fitAndResize()
}

function handleExit(id: string) {
  if (id !== sessionId) return
  sessionId = null
  phase.value = 'ended'
}

async function stopReplay() {
  runToken += 1
  pendingEvents = null
  const id = sessionId
  sessionId = null
  if (phase.value === 'preparing' || phase.value === 'running') phase.value = 'ended'
  if (id) await backend.closeTerminal(id, true).catch(() => {})
}

async function startReplay() {
  const current = selection.value
  if (!current || !replayStatus.value?.installed) return
  await stopReplay()
  const token = ++runToken
  runError.value = ''
  phase.value = 'preparing'
  targetLabel.value = current.kind === 'repo' ? `正在同步 ${current.nameWithOwner}…首次克隆可能需要一些时间` : '正在读取当前项目…'
  try {
    await ensureTerminal()
    const target = await backend.gitReplayPrepare(
      current.kind === 'repo' ? current.nameWithOwner : null,
      rootPath.value || null,
    )
    if (token !== runToken || disposed) return
    targetLabel.value = target.nameWithOwner ?? workspaceName.value
    terminal?.reset()
    pendingEvents = []
    const session = await backend.gitReplayStart(store.workspace?.id ?? null, target.repoPath, {
      order: order.value,
      speed: speed.value,
      author: onlyMine.value ? login.value : null,
    })
    const buffered = pendingEvents ?? []
    pendingEvents = null
    if (token !== runToken || disposed) {
      await backend.closeTerminal(session.id, true).catch(() => {})
      return
    }
    sessionId = session.id
    phase.value = 'running'
    for (const event of buffered) {
      if (event.sessionId !== session.id) continue
      if (event.chunk) terminal?.write(event.chunk)
      if (event.exited) handleExit(session.id)
    }
    fitAndResize()
    terminal?.focus()
  } catch (error) {
    if (token !== runToken) return
    pendingEvents = null
    phase.value = 'idle'
    runError.value = errorMessage(error)
  }
}

function selectWorkspace() {
  if (!workspaceIsRepo.value) return
  selection.value = { kind: 'workspace' }
  void startReplay()
}

function selectRepo(repo: GitHubRepoSummary) {
  if (repo.isEmpty) return
  selection.value = { kind: 'repo', nameWithOwner: repo.nameWithOwner }
  void startReplay()
}

function isSelectedRepo(repo: GitHubRepoSummary) {
  return selection.value?.kind === 'repo' && selection.value.nameWithOwner === repo.nameWithOwner
}

onMounted(() => {
  void refreshAll()
  void ensureTerminal()
  const keep = (promise: Promise<() => void>) => {
    void promise.then((unlisten) => {
      if (disposed) unlisten()
      else unlisteners.push(unlisten)
    })
  }
  keep(onTerminalOutput((event) => {
    if (pendingEvents) pendingEvents.push({ sessionId: event.sessionId, chunk: event.chunk })
    else if (event.sessionId === sessionId) terminal?.write(event.chunk)
  }))
  keep(onTerminalExit((event) => {
    if (pendingEvents) pendingEvents.push({ sessionId: event.sessionId, exited: true })
    else handleExit(event.sessionId)
  }))
})

// 隐藏时只停止回放进程，保留列表、筛选和终端；重新进入无需联网或重建 xterm。
watch(() => props.active, async (active) => {
  if (!active) {
    await stopReplay()
    return
  }
  if (Date.now() - lastRefreshAt >= REPO_REFRESH_INTERVAL_MS) void refreshAll()
  await nextTick()
  if (!disposed && props.active) fitAndResize()
})

watch(workspaceIsRepo, (isRepo) => {
  if (isRepo && !selection.value) selection.value = { kind: 'workspace' }
}, { immediate: true })

watch(() => store.currentThemeId, (themeId) => {
  if (terminal) terminal.options.theme = buildTerminalTheme(themeId)
})

watch(rootPath, () => {
  void stopReplay()
  phase.value = 'idle'
  selection.value = null
  if (workspaceIsRepo.value) selection.value = { kind: 'workspace' }
})

onBeforeUnmount(() => {
  disposed = true
  void stopReplay()
  for (const unlisten of unlisteners.splice(0)) unlisten()
  resizeObserver?.disconnect()
  terminal?.dispose()
  terminal = null
})
</script>

<template>
  <div class="replay-body">
    <aside class="replay-list">
      <div class="replay-search">
        <input v-model="query" type="search" placeholder="筛选仓库" aria-label="筛选仓库">
        <button type="button" class="replay-icon-button" title="刷新仓库列表" :disabled="reposLoading" @click="refreshAll">
          <RefreshCw :size="14" :class="{ spinning: reposLoading }" />
        </button>
      </div>
      <template v-if="rootPath">
        <div class="replay-section">当前项目</div>
        <button
          type="button"
          class="replay-row"
          :class="{ active: selection?.kind === 'workspace' }"
          :disabled="!workspaceIsRepo"
          :title="rootPath"
          @click="selectWorkspace"
        >
          <FolderGit2 :size="14" class="replay-row-icon" />
          <span class="replay-row-main">
            <span class="replay-row-title">{{ workspaceName }}</span>
            <span class="replay-row-sub">{{ workspaceIsRepo ? '本地仓库，包含未推送的提交' : '不是 Git 仓库，无法回放' }}</span>
          </span>
        </button>
      </template>
      <div class="replay-section">GitHub{{ login ? ` · ${login}` : '' }}</div>
      <div v-if="reposError" class="replay-empty">{{ reposError }}</div>
      <div v-if="reposLoading && !repos.length" class="replay-empty">正在读取 GitHub 仓库…</div>
      <div v-else-if="!filteredRepos.length && !reposError" class="replay-empty">{{ repos.length ? '没有匹配的仓库' : '账号下没有仓库' }}</div>
      <button
        v-for="repo in filteredRepos"
        :key="repo.nameWithOwner"
        type="button"
        class="replay-row"
        :class="{ active: isSelectedRepo(repo) }"
        :disabled="repo.isEmpty"
        :title="repo.isEmpty ? '空仓库，没有可回放的提交' : repo.nameWithOwner"
        @click="selectRepo(repo)"
      >
        <span class="replay-row-main">
          <span class="replay-row-title">
            {{ repoName(repo.nameWithOwner) }}
            <span v-if="repo.isPrivate" class="replay-tag">私有</span>
            <span v-if="repo.isFork" class="replay-tag">Fork</span>
            <span v-if="repo.isArchived" class="replay-tag">归档</span>
          </span>
          <span class="replay-row-sub">{{ repo.description || formatPushedAt(repo.pushedAt) || repo.nameWithOwner }}</span>
        </span>
      </button>
    </aside>

    <main class="replay-main">
      <header class="replay-toolbar">
        <span class="replay-title" :title="selectionTitle">{{ selectionTitle }}</span>
        <select v-model="order" aria-label="回放顺序">
          <option v-for="option in ORDER_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <select v-model.number="speed" aria-label="打字速度">
          <option v-for="option in SPEED_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <label class="replay-check" :title="login ? `只回放作者匹配 ${login} 的提交` : '需要先登录 GitHub'">
          <input v-model="onlyMine" type="checkbox" :disabled="!login">
          仅我的提交
        </label>
        <span class="replay-phase" :title="phaseLabel">{{ phaseLabel }}</span>
        <button
          v-if="phase === 'running' || phase === 'preparing'"
          type="button"
          class="replay-button"
          @click="stopReplay"
        >
          <Square :size="12" />停止
        </button>
        <button v-else type="button" class="replay-button primary" :disabled="!canStart" @click="startReplay">
          <Play :size="12" />{{ phase === 'ended' ? '重新回放' : '开始回放' }}
        </button>
      </header>
      <div class="replay-stage">
        <div ref="host" class="replay-terminal" />
        <div v-if="overlayText" class="replay-overlay">{{ overlayText }}</div>
      </div>
      <footer v-if="phase === 'running'" class="replay-hint">
        空格 暂停 · n / p 下一个 / 上一个提交 · Esc 菜单 · q 退出
      </footer>
    </main>
  </div>
</template>

<style scoped>
.replay-body {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.replay-list {
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--color-border);
  background: var(--surface-panel-soft);
}

.replay-search {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-soft);
}

.replay-search input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
}

.replay-section {
  padding: 8px 10px 4px;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: var(--sh-weight-emphasis);
}

.replay-empty {
  padding: 10px 12px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.replay-row {
  display: flex;
  align-items: flex-start;
  width: 100%;
  gap: 8px;
  padding: 6px 10px;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.replay-row:hover:not(:disabled) { background: var(--color-bg-hover); }
.replay-row.active { background: var(--surface-accent-blue-soft); }
.replay-row:disabled { opacity: 0.5; cursor: default; }

.replay-row-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--color-accent-blue);
}

.replay-row-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.replay-row-title {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  font-size: 12px;
  white-space: nowrap;
}

.replay-row-sub {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay-tag {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 14px;
}

.replay-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.replay-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-strong);
  white-space: nowrap;
  scrollbar-width: thin;
}

.replay-title {
  overflow: hidden;
  max-width: 260px;
  font-size: 12px;
  font-weight: var(--sh-weight-emphasis);
  text-overflow: ellipsis;
}

.replay-toolbar select {
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
}

.replay-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.replay-phase {
  flex: 1;
  min-width: 40px;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 11px;
  text-align: right;
  text-overflow: ellipsis;
}

.replay-button,
.replay-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: 0 0 auto;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.replay-icon-button {
  width: 26px;
  padding: 0;
  color: var(--color-text-secondary);
}

.replay-button.primary {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
}

.replay-button:hover:not(:disabled),
.replay-icon-button:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.replay-button:disabled,
.replay-icon-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.replay-stage {
  position: relative;
  flex: 1;
  min-height: 0;
}

.replay-terminal {
  position: absolute;
  inset: 6px 0 0 8px;
}

.replay-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  word-break: break-word;
}

.replay-hint {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spinning {
  animation: replay-spin 900ms linear infinite;
}

@keyframes replay-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 860px) {
  .replay-body {
    grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
  }
}
</style>
