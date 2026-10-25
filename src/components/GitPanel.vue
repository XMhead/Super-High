<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ChevronDown, ChevronRight, GitBranch, RefreshCw, Tag } from 'lucide-vue-next'

import { changelogForGroup, groupCommitsByVersion, type GitVersionGroup } from '@/lib/gitHistory'
import { renderMarkdown } from '@/lib/markdown'
import { parseChangelog, type ReleaseEntry } from '@/lib/releaseNotes'
import { backend } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { GitCommit, GitCommitDetail, GitCommitFile, GitFileDiff, GitStatus, GitStatusFile } from '@/types'

import GitDiffViewer from './GitDiffViewer.vue'
import GitFileRow from './GitFileRow.vue'
import GitReplayView from './GitReplayView.vue'

type GitTab = 'changes' | 'history' | 'replay'
type HistoryRow =
  | { kind: 'group', key: string, group: GitVersionGroup, last: boolean }
  | { kind: 'commit', key: string, commit: GitCommit, nested: boolean }

const PAGE_SIZE = 80
const DIFF_CACHE_LIMIT = 40
const DETAIL_CACHE_LIMIT = 80
const LOADING_DELAY_MS = 150
const TRAILER_LINE = /^(?:Co-Authored-By|Signed-off-by|Reviewed-by|Change-Id):.*$/gim

const store = useWorkspaceStore()
const rootPath = computed(() => store.workspace?.rootPath ?? '')
const activeTab = ref<GitTab>('changes')
// 大对象整体替换，不做深层响应。
const status = shallowRef<GitStatus | null>(null)
const commits = shallowRef<GitCommit[]>([])
const commitDetail = shallowRef<GitCommitDetail | null>(null)
const changelog = shallowRef<ReleaseEntry[] | null>(null)
const selectedStatusPath = ref('')
const selectedCommitHash = ref('')
const selectedCommitFilePath = ref('')
const selectedVersionKey = ref('')
const expandedGroups = shallowRef(new Set<string>())
const diff = shallowRef<{ key: string, value: GitFileDiff } | null>(null)
// 最近一次可渲染的文本差异：读取下一份时继续显示，避免差异编辑器卸载重建和闪烁。
const lastTextDiff = shallowRef<GitFileDiff | null>(null)
const loadingStatus = ref(false)
const loadingHistory = ref(false)
const loadingDetail = ref(false)
const loadingDiff = ref(false)
const showLoading = ref(false)
const historyHasMore = ref(false)
const statusError = ref('')
const historyError = ref('')
const detailError = ref('')
const diffError = ref('')
const detailCache = new Map<string, GitCommitDetail>()
const diffCache = new Map<string, GitFileDiff>()
let diffRequest = 0
let detailRequest = 0
let loadingTimer: number | null = null
let activatedOnce = false
let disposed = false

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value!)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatRelativeTime(timestamp: number) {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`
  return formatDay(timestamp)
}

function formatDay(timestamp: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('zh-CN', sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatDateTime(timestamp: number) {
  if (!timestamp) return ''
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false })
}

function commitTitle(commit: GitCommit) {
  return `${commit.subject}\n${commit.shortHash} · ${commit.author} · ${formatDateTime(commit.timestamp)}`
}

// 待发布分组用更新日志中已写好的下一版本号标注。
function groupLabel(group: GitVersionGroup) {
  if (group.version) return `v${group.version}`
  const next = changelog.value ? changelogForGroup(group, versionGroups.value, changelog.value)[0] : undefined
  return next ? `v${next.version} 待发布` : '待发布'
}

function groupRangeLabel(group: GitVersionGroup) {
  const newest = group.commits[0]?.timestamp ?? 0
  const oldest = group.commits[group.commits.length - 1]?.timestamp ?? 0
  const newestDay = formatDay(newest)
  const oldestDay = formatDay(oldest)
  const more = group === versionGroups.value[versionGroups.value.length - 1] && historyHasMore.value ? '+' : ''
  return `${group.commits.length}${more} 个提交 · ${oldestDay === newestDay ? newestDay : `${oldestDay} ~ ${newestDay}`}`
}

function lineTotals(files: Array<{ additions: number | null, deletions: number | null }>) {
  return files.reduce((sum, file) => ({ add: sum.add + (file.additions ?? 0), del: sum.del + (file.deletions ?? 0) }), { add: 0, del: 0 })
}

const branchLabel = computed(() => {
  if (status.value?.branch) return status.value.branch
  if (status.value) return '分离头指针'
  return 'Git'
})
const syncLabel = computed(() => {
  const current = status.value
  if (!current?.upstream) return ''
  const parts: string[] = []
  if (current.ahead) parts.push(`↑${current.ahead}`)
  if (current.behind) parts.push(`↓${current.behind}`)
  return parts.join(' ')
})
const statusTotals = computed(() => lineTotals(status.value?.files ?? []))
const selectedStatusFile = computed(() => (
  status.value?.files.find((file) => file.path === selectedStatusPath.value) ?? null
))
// 标题信息直接取列表中的提交，切换时立即更新；文件列表等详情读取完成后再替换。
const selectedCommit = computed(() => (
  commits.value.find((commit) => commit.hash === selectedCommitHash.value)
  ?? (commitDetail.value?.commit.hash === selectedCommitHash.value ? commitDetail.value.commit : null)
))
const detailStale = computed(() => !!commitDetail.value && commitDetail.value.commit.hash !== selectedCommitHash.value)
const commitBody = computed(() => commitDetail.value && !detailStale.value
  ? commitDetail.value.body.replace(TRAILER_LINE, '').trim()
  : '')
const commitTotals = computed(() => lineTotals(commitDetail.value?.files ?? []))
const selectedCommitFile = computed(() => (
  commitDetail.value?.files.find((file) => file.path === selectedCommitFilePath.value) ?? null
))
const versionGroups = computed(() => groupCommitsByVersion(commits.value))
const historyRows = computed<HistoryRow[]>(() => {
  const groups = versionGroups.value
  if (!groups.length) return commits.value.map((commit) => ({ kind: 'commit', key: commit.hash, commit, nested: false }))
  const rows: HistoryRow[] = []
  groups.forEach((group, index) => {
    rows.push({ kind: 'group', key: `group:${group.key}`, group, last: index === groups.length - 1 })
    if (!expandedGroups.value.has(group.key)) return
    for (const commit of group.commits) rows.push({ kind: 'commit', key: commit.hash, commit, nested: true })
  })
  return rows
})
const selectedGroup = computed(() => versionGroups.value.find((group) => group.key === selectedVersionKey.value) ?? null)
const selectedGroupNotes = computed(() => (
  selectedGroup.value && changelog.value ? changelogForGroup(selectedGroup.value, versionGroups.value, changelog.value) : []
))
const renderedGroupNotes = computed(() => selectedGroupNotes.value.map((entry) => ({ ...entry, html: renderMarkdown(entry.notes) })))
const historyMode = computed(() => {
  if (activeTab.value !== 'history') return 'none'
  if (selectedGroup.value && !selectedCommitHash.value) return 'version'
  return 'commit'
})
// 列表 + 差异两栏；查看提交时插入中间的提交详情栏。
const bodyLayout = computed(() => {
  if (historyMode.value === 'commit' && selectedCommit.value) return 'commit'
  if (historyMode.value === 'version') return 'version'
  return 'two'
})
const expectedDiffKey = computed(() => {
  if (activeTab.value === 'changes') return selectedStatusPath.value ? `working:${selectedStatusPath.value}` : ''
  if (historyMode.value === 'commit' && selectedCommitHash.value && selectedCommitFilePath.value) {
    return `${selectedCommitHash.value}:${selectedCommitFilePath.value}`
  }
  return ''
})
const currentDiff = computed(() => diff.value?.key === expectedDiffKey.value ? diff.value.value : null)
const busy = computed(() => loadingDiff.value || loadingDetail.value)
// 差异区只显示一条状态：错误、空状态或不可预览原因；为空时显示差异编辑器。
const detailMessage = computed(() => {
  if (activeTab.value === 'changes') {
    if (statusError.value) return statusError.value
    if (!status.value) return loadingStatus.value ? '正在读取 Git 状态…' : ''
    if (!status.value.files.length) return '工作区没有未提交的变更'
    if (!selectedStatusPath.value) return '选择文件查看差异'
  } else {
    if (detailError.value) return detailError.value
    if (!selectedCommitHash.value) return loadingHistory.value ? '正在读取提交历史…' : '选择一条提交查看差异'
    if (!busy.value && commitDetail.value && !detailStale.value && !commitDetail.value.files.length) return '该提交没有文件变更'
    if (!busy.value && !detailStale.value && commitDetail.value && !selectedCommitFilePath.value) return '选择文件查看差异'
  }
  if (diffError.value) return diffError.value
  const value = currentDiff.value
  if (!value) return busy.value && lastTextDiff.value ? '' : '正在读取差异…'
  if (value.tooLarge) return '文件超过 2 MB，已跳过差异预览'
  if (value.binary) return '二进制文件，无法预览差异'
  return ''
})
const renameNote = computed(() => {
  const file = activeTab.value === 'changes' ? selectedStatusFile.value : selectedCommitFile.value
  return file?.oldPath ? `重命名自 ${file.oldPath}` : ''
})

watch(busy, (value) => {
  if (loadingTimer != null) window.clearTimeout(loadingTimer)
  loadingTimer = null
  if (!value) {
    showLoading.value = false
    return
  }
  // 缓存命中或很快返回时不显示读取状态，避免闪烁。
  loadingTimer = window.setTimeout(() => {
    loadingTimer = null
    showLoading.value = busy.value
  }, LOADING_DELAY_MS)
})

async function loadDiff(key: string, fetch: () => Promise<GitFileDiff>) {
  const root = rootPath.value
  const request = ++diffRequest
  diffError.value = ''
  const cached = diffCache.get(key)
  if (cached) {
    remember(diffCache, key, cached, DIFF_CACHE_LIMIT)
    applyDiff(key, cached)
    loadingDiff.value = false
    return
  }
  loadingDiff.value = true
  try {
    const result = await fetch()
    if (disposed || request !== diffRequest || rootPath.value !== root) return
    remember(diffCache, key, result, DIFF_CACHE_LIMIT)
    applyDiff(key, result)
  } catch (error) {
    if (request !== diffRequest || rootPath.value !== root) return
    diffError.value = errorMessage(error)
  } finally {
    if (request === diffRequest) loadingDiff.value = false
  }
}

function applyDiff(key: string, value: GitFileDiff) {
  diff.value = { key, value }
  if (!value.binary && !value.tooLarge) lastTextDiff.value = value
}

function loadWorkingDiff() {
  const root = rootPath.value
  const file = selectedStatusFile.value
  if (!root || !file) return Promise.resolve()
  return loadDiff(`working:${file.path}`, () => backend.gitWorkingDiff(root, file.path, file.oldPath))
}

function loadCommitDiff(file: GitCommitFile) {
  const root = rootPath.value
  const hash = selectedCommitHash.value
  if (!root || !hash) return Promise.resolve()
  selectedCommitFilePath.value = file.path
  return loadDiff(`${hash}:${file.path}`, () => backend.gitCommitFileDiff(root, hash, file.path, file.oldPath))
}

async function loadStatus() {
  const root = rootPath.value
  if (!root) return
  loadingStatus.value = true
  statusError.value = ''
  try {
    const next = await backend.gitStatus(root)
    if (disposed || rootPath.value !== root) return
    status.value = next
    if (!next.files.some((file) => file.path === selectedStatusPath.value)) {
      selectedStatusPath.value = next.files[0]?.path ?? ''
    }
    if (activeTab.value === 'changes' && selectedStatusPath.value) await loadWorkingDiff()
  } catch (error) {
    if (rootPath.value !== root) return
    status.value = null
    statusError.value = errorMessage(error)
  } finally {
    if (rootPath.value === root) loadingStatus.value = false
  }
}

// 读取仓库自身的 CHANGELOG.md，用于按版本显示更新内容；没有该文件时只显示提交。
async function loadChangelog() {
  const root = rootPath.value
  const repoRoot = (status.value?.repoRoot || root).replace(/[\\/]+$/, '')
  if (!repoRoot) return
  const entries = await backend.readFile(`${repoRoot}/CHANGELOG.md`).then(parseChangelog).catch(() => [])
  if (!disposed && rootPath.value === root) changelog.value = entries
}

async function loadHistory(reset = true) {
  const root = rootPath.value
  if (!root) return
  loadingHistory.value = true
  historyError.value = ''
  try {
    const skip = reset ? 0 : commits.value.length
    const page = await backend.gitLog(root, PAGE_SIZE, skip)
    if (disposed || rootPath.value !== root) return
    commits.value = reset ? page : [...commits.value, ...page]
    historyHasMore.value = page.length === PAGE_SIZE
  } catch (error) {
    if (rootPath.value !== root) return
    historyError.value = errorMessage(error)
  } finally {
    if (rootPath.value === root) loadingHistory.value = false
  }
}

// 有版本分组时默认打开最新分组的更新说明，否则打开最新提交。
function selectInitialHistory() {
  const group = versionGroups.value[0]
  if (group) {
    selectVersion(group)
    return
  }
  const first = commits.value[0]
  if (first) void selectCommit(first)
}

function selectVersion(group: GitVersionGroup) {
  selectedVersionKey.value = group.key
  selectedCommitHash.value = ''
  selectedCommitFilePath.value = ''
  detailError.value = ''
  diffError.value = ''
  detailRequest += 1
  diffRequest += 1
  loadingDetail.value = false
  loadingDiff.value = false
  if (!expandedGroups.value.has(group.key)) toggleGroup(group.key)
}

function toggleGroup(key: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedGroups.value = next
}

async function selectCommit(commit: GitCommit) {
  const root = rootPath.value
  if (!root) return
  selectedVersionKey.value = ''
  selectedCommitHash.value = commit.hash
  detailError.value = ''
  diffError.value = ''
  diffRequest += 1
  const request = ++detailRequest
  // 浏览同一文件的历史时保持选中该文件；新提交不含该文件时选第一个。
  const preferredPath = selectedCommitFilePath.value
  const apply = (detail: GitCommitDetail) => {
    commitDetail.value = detail
    const file = detail.files.find((item) => item.path === preferredPath) ?? detail.files[0]
    selectedCommitFilePath.value = file?.path ?? ''
    if (file && activeTab.value === 'history') return loadCommitDiff(file)
    loadingDiff.value = false
  }
  const cached = detailCache.get(commit.hash)
  if (cached) {
    loadingDetail.value = false
    await apply(cached)
    return
  }
  loadingDetail.value = true
  try {
    const detail = await backend.gitCommitDetail(root, commit.hash)
    if (disposed || rootPath.value !== root || request !== detailRequest) return
    remember(detailCache, commit.hash, detail, DETAIL_CACHE_LIMIT)
    loadingDetail.value = false
    await apply(detail)
  } catch (error) {
    if (rootPath.value !== root || request !== detailRequest) return
    commitDetail.value = null
    detailError.value = errorMessage(error)
  } finally {
    if (request === detailRequest) loadingDetail.value = false
  }
}

function selectStatusFile(file: GitStatusFile) {
  if (selectedStatusPath.value === file.path && currentDiff.value) return
  selectedStatusPath.value = file.path
  void loadWorkingDiff()
}

function showChanges() {
  activeTab.value = 'changes'
  if (selectedStatusPath.value) void loadWorkingDiff()
}

function showHistory() {
  activeTab.value = 'history'
  if (!commits.value.length && !loadingHistory.value) {
    void Promise.all([loadHistory(true), changelog.value ? null : loadChangelog()]).then(() => {
      if (!selectedCommitHash.value && !selectedVersionKey.value) selectInitialHistory()
    })
    return
  }
  if (selectedCommitHash.value && selectedCommitFile.value) void loadCommitDiff(selectedCommitFile.value)
}

async function loadMore() {
  if (!historyHasMore.value || loadingHistory.value) return
  await loadHistory(false)
}

// 重新读取历史并尽量保留当前选中的提交或版本。
async function reloadHistory() {
  const currentHash = selectedCommitHash.value
  const currentVersion = selectedVersionKey.value
  await Promise.all([loadHistory(true), loadChangelog()])
  const commit = commits.value.find((item) => item.hash === currentHash)
  const group = versionGroups.value.find((item) => item.key === currentVersion)
  if (commit) await selectCommit(commit)
  else if (group) selectVersion(group)
  else selectInitialHistory()
}

async function refresh() {
  detailCache.clear()
  diffCache.clear()
  await loadStatus()
  if (commits.value.length) await reloadHistory()
}

function reset() {
  status.value = null
  commits.value = []
  commitDetail.value = null
  changelog.value = null
  selectedStatusPath.value = ''
  selectedCommitHash.value = ''
  selectedCommitFilePath.value = ''
  selectedVersionKey.value = ''
  expandedGroups.value = new Set()
  diff.value = null
  lastTextDiff.value = null
  statusError.value = ''
  historyError.value = ''
  detailError.value = ''
  diffError.value = ''
  loadingStatus.value = false
  loadingHistory.value = false
  loadingDetail.value = false
  loadingDiff.value = false
  historyHasMore.value = false
  detailCache.clear()
  diffCache.clear()
  diffRequest += 1
  detailRequest += 1
  activeTab.value = 'changes'
}

onMounted(() => {
  void loadStatus()
})

// 面板被 KeepAlive 缓存；重新进入时只刷新工作区状态，HEAD 变化后才重读历史。
onActivated(() => {
  // 首次挂载也会触发一次 activated，此时 onMounted 已读取状态。
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  if (!rootPath.value) return
  if (!loadingStatus.value) {
    for (const key of [...diffCache.keys()]) if (key.startsWith('working:')) diffCache.delete(key)
    void loadStatus()
  }
  const root = rootPath.value
  const head = commits.value[0]?.hash
  if (!head) return
  void backend.gitLog(root, 1, 0).then((page) => {
    if (!disposed && rootPath.value === root && page[0] && page[0].hash !== head) void reloadHistory()
  }).catch(() => undefined)
})

watch(rootPath, () => {
  reset()
  if (rootPath.value) void loadStatus()
})

onBeforeUnmount(() => {
  disposed = true
  diffRequest += 1
  detailRequest += 1
  if (loadingTimer != null) window.clearTimeout(loadingTimer)
  detailCache.clear()
  diffCache.clear()
})
</script>

<template>
  <section class="git-panel" aria-label="Git 变更与历史">
    <header class="git-header">
      <div class="git-branch" :title="status?.repoRoot || rootPath">
        <GitBranch :size="14" />
        <span class="git-branch-name">{{ branchLabel }}</span>
        <span v-if="syncLabel" class="git-sync">{{ syncLabel }}</span>
      </div>
      <div class="git-tabs" role="tablist" aria-label="Git 视图">
        <button type="button" class="git-tab" :class="{ active: activeTab === 'changes' }" role="tab" :aria-selected="activeTab === 'changes'" @click="showChanges">
          变更
          <span v-if="status" class="git-count">{{ status.files.length }}</span>
        </button>
        <button type="button" class="git-tab" :class="{ active: activeTab === 'history' }" role="tab" :aria-selected="activeTab === 'history'" @click="showHistory">
          历史
        </button>
        <button type="button" class="git-tab" :class="{ active: activeTab === 'replay' }" role="tab" :aria-selected="activeTab === 'replay'" @click="activeTab = 'replay'">
          回放
        </button>
      </div>
      <span v-if="activeTab === 'changes' && (statusTotals.add || statusTotals.del)" class="git-totals">
        <span class="git-stat-add">+{{ statusTotals.add }}</span>
        <span class="git-stat-del">−{{ statusTotals.del }}</span>
      </span>
      <span class="git-header-spacer" />
      <button
        v-if="activeTab !== 'replay'"
        type="button"
        class="git-refresh"
        title="刷新 Git 状态"
        aria-label="刷新 Git 状态"
        :disabled="loadingStatus || loadingHistory"
        @click="refresh"
      >
        <RefreshCw :size="14" :class="{ spinning: loadingStatus || loadingHistory }" />
      </button>
    </header>

    <GitReplayView v-if="activeTab === 'replay'" />
    <div v-else class="git-body" :class="`git-body--${bodyLayout}`">
      <aside class="git-list" :aria-label="activeTab === 'changes' ? '变更文件' : '提交历史'">
        <template v-if="activeTab === 'changes'">
          <div v-if="statusError" class="git-list-empty">{{ statusError }}</div>
          <div v-else-if="loadingStatus && !status" class="git-list-empty">正在读取 Git 状态…</div>
          <div v-else-if="!status?.files.length" class="git-list-empty">工作区没有未提交的变更</div>
          <GitFileRow
            v-for="file in status?.files ?? []"
            :key="file.path"
            :file="file"
            :active="file.path === selectedStatusPath"
            @click="selectStatusFile(file)"
          />
        </template>

        <template v-else>
          <div v-if="historyError" class="git-list-empty">{{ historyError }}</div>
          <div v-else-if="loadingHistory && !commits.length" class="git-list-empty">正在读取提交历史…</div>
          <div v-else-if="!commits.length" class="git-list-empty">还没有提交记录</div>
          <template v-for="row in historyRows" :key="row.key">
            <div v-if="row.kind === 'group'" class="git-group-header" :class="{ active: selectedVersionKey === row.group.key && !selectedCommitHash }">
              <button
                type="button"
                class="git-group-toggle"
                :aria-label="expandedGroups.has(row.group.key) ? '收起提交' : '展开提交'"
                :aria-expanded="expandedGroups.has(row.group.key)"
                @click="toggleGroup(row.group.key)"
              >
                <ChevronDown v-if="expandedGroups.has(row.group.key)" :size="13" />
                <ChevronRight v-else :size="13" />
              </button>
              <button type="button" class="git-group-main" :title="`查看 ${groupLabel(row.group)} 的更新内容`" @click="selectVersion(row.group)">
                <Tag :size="12" class="git-group-icon" :class="{ pending: !row.group.version }" />
                <span class="git-group-name">{{ groupLabel(row.group) }}</span>
                <span class="git-group-meta">{{ row.group.commits.length }}{{ row.last && historyHasMore ? '+' : '' }} 个提交 · {{ formatDay(row.group.commits[0]?.timestamp ?? 0) }}</span>
              </button>
            </div>
            <button
              v-else
              type="button"
              class="git-commit-row"
              :class="{ active: row.commit.hash === selectedCommitHash, nested: row.nested }"
              :title="commitTitle(row.commit)"
              @click="selectCommit(row.commit)"
            >
              <span class="git-commit-subject">{{ row.commit.subject }}</span>
              <span class="git-commit-time">{{ formatRelativeTime(row.commit.timestamp) }}</span>
            </button>
          </template>
          <button v-if="historyHasMore" type="button" class="git-load-more" :disabled="loadingHistory" @click="loadMore">
            {{ loadingHistory ? '正在加载…' : '加载更早的提交' }}
          </button>
        </template>
      </aside>

      <section v-if="historyMode === 'version' && selectedGroup" class="git-version-pane" aria-label="版本更新内容">
        <header class="git-pane-header">
          <Tag :size="13" class="git-group-icon" :class="{ pending: !selectedGroup.version }" />
          <span class="git-pane-title">{{ groupLabel(selectedGroup) }}</span>
          <span class="git-pane-meta">{{ groupRangeLabel(selectedGroup) }}</span>
        </header>
        <div class="git-version-notes">
          <template v-if="renderedGroupNotes.length">
            <article v-for="entry in renderedGroupNotes" :key="entry.version" class="git-version-entry">
              <h3 v-if="renderedGroupNotes.length > 1" class="git-version-entry-title">{{ entry.version }}<span v-if="entry.date"> · {{ entry.date }}</span></h3>
              <div class="markdown-body" v-html="entry.html" />
            </article>
          </template>
          <div v-else class="git-detail-empty">
            {{ changelog?.length ? '更新日志中没有该版本的记录，展开左侧分组查看提交' : '仓库没有 CHANGELOG.md，展开左侧分组查看提交' }}
          </div>
        </div>
      </section>

      <section v-if="historyMode === 'commit' && selectedCommit" class="git-commit-pane" :class="{ stale: detailStale || loadingDetail }" aria-label="提交详情">
        <header class="git-commit-header">
          <div class="git-commit-title">{{ selectedCommit.subject }}</div>
          <div class="git-commit-info">
            <code>{{ selectedCommit.shortHash }}</code>
            <span :title="selectedCommit.email">{{ selectedCommit.author }}</span>
            <span>{{ formatDateTime(selectedCommit.timestamp) }}</span>
          </div>
          <div v-if="selectedCommit.refs" class="git-commit-refs" :title="selectedCommit.refs">{{ selectedCommit.refs }}</div>
          <pre v-if="commitBody" class="git-commit-body">{{ commitBody }}</pre>
        </header>
        <div class="git-files-header">
          <span>{{ commitDetail && !detailStale ? `${commitDetail.files.length} 个文件` : '文件' }}</span>
          <span v-if="commitDetail && !detailStale && (commitTotals.add || commitTotals.del)" class="git-totals">
            <span class="git-stat-add">+{{ commitTotals.add }}</span>
            <span class="git-stat-del">−{{ commitTotals.del }}</span>
          </span>
        </div>
        <div class="git-commit-files">
          <GitFileRow
            v-for="file in commitDetail?.files ?? []"
            :key="file.path"
            :file="file"
            :active="file.path === selectedCommitFilePath"
            @click="loadCommitDiff(file)"
          />
        </div>
      </section>

      <main v-show="historyMode !== 'version'" class="git-detail">
        <div v-if="showLoading && !detailMessage" class="git-loading-bar" role="progressbar" aria-label="正在读取差异" />
        <div v-if="!detailMessage && renameNote" class="git-notice">{{ renameNote }}</div>
        <div v-if="!detailMessage && currentDiff?.truncated" class="git-notice">文件较大，仅显示前 2 MB。</div>
        <div v-if="detailMessage" class="git-detail-empty">{{ detailMessage }}</div>
        <GitDiffViewer
          v-if="lastTextDiff"
          v-show="!detailMessage"
          :path="lastTextDiff.path"
          :old-text="lastTextDiff.oldText"
          :new-text="lastTextDiff.newText"
        />
      </main>
    </div>
  </section>
</template>

<style scoped>
.git-panel {
  display: flex;
  flex-direction: column;
  grid-column: 2 / -1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--color-border);
  background: var(--surface-panel);
  color: var(--color-text-primary);
}

.git-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  height: 32px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-strong);
}

.git-branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--color-text-secondary);
}

.git-branch-name {
  max-width: 220px;
  overflow: hidden;
  font-size: 12px;
  font-weight: var(--sh-weight-emphasis);
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}

.git-sync {
  font-size: 11px;
  color: var(--color-accent-yellow);
  white-space: nowrap;
}

.git-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.git-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.git-tab:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.git-tab.active {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
  color: var(--color-text-primary);
}

.git-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--color-bg-hover);
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
}

.git-totals {
  display: inline-flex;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.git-stat-add { color: var(--color-accent-green); }
.git-stat-del { color: var(--color-accent-red); }

.git-header-spacer {
  flex: 1;
}

.git-refresh {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.git-refresh:hover:not(:disabled) {
  border-color: var(--color-border);
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.git-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.git-refresh .spinning {
  animation: git-spin 900ms linear infinite;
}

@keyframes git-spin {
  to { transform: rotate(360deg); }
}

.git-body {
  display: grid;
  flex: 1;
  min-height: 0;
}

.git-body--two { grid-template-columns: clamp(220px, 24%, 340px) minmax(0, 1fr); }
.git-body--version { grid-template-columns: clamp(240px, 26%, 360px) minmax(0, 1fr); }
.git-body--commit { grid-template-columns: clamp(240px, 24%, 340px) clamp(220px, 22%, 320px) minmax(0, 1fr); }

.git-list {
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--color-border);
  background: var(--surface-panel-soft);
  scrollbar-width: thin;
}

.git-list-empty {
  padding: 12px 10px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.git-group-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  height: 28px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-strong);
}

.git-group-header.active {
  background: var(--surface-accent-blue-soft);
}

.git-group-toggle {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 22px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.git-group-toggle:hover {
  color: var(--color-text-primary);
}

.git-group-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 8px 0 0;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.git-group-icon {
  flex: 0 0 auto;
  color: var(--color-accent-blue);
}

.git-group-icon.pending {
  color: var(--color-accent-yellow);
}

.git-group-name {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: var(--sh-weight-emphasis);
  white-space: nowrap;
}

.git-group-meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-commit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 26px;
  padding: 0 8px 0 10px;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.git-commit-row.nested {
  padding-left: 30px;
}

.git-commit-row:hover {
  background: var(--color-bg-hover);
}

.git-commit-row.active {
  background: var(--surface-accent-blue-soft);
}

.git-commit-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-commit-time {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.git-load-more {
  width: 100%;
  height: 28px;
  border: 0;
  border-top: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.git-load-more:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.git-commit-pane,
.git-version-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--color-border);
  background: var(--surface-panel-soft);
}

.git-version-pane {
  border-right: 0;
  background: var(--color-bg-primary);
}

.git-commit-pane.stale .git-commit-files {
  opacity: 0.55;
}

.git-pane-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  height: 32px;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-strong);
}

.git-pane-title {
  font-size: 13px;
  font-weight: var(--sh-weight-emphasis);
  white-space: nowrap;
}

.git-pane-meta {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-version-notes {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 16px 16px;
}

.git-version-entry + .git-version-entry {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}

.git-version-entry-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: var(--sh-weight-emphasis);
}

.git-commit-header {
  flex: 0 0 auto;
  max-height: 45%;
  overflow: auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
}

.git-commit-title {
  font-size: 13px;
  font-weight: var(--sh-weight-emphasis);
  line-height: 1.4;
  word-break: break-word;
}

.git-commit-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 11px;
}

.git-commit-info code {
  color: var(--color-accent-blue);
  font-family: var(--font-mono);
}

.git-commit-refs {
  margin-top: 3px;
  overflow: hidden;
  color: var(--color-accent-purple);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-commit-body {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.git-files-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 11px;
}

.git-commit-files {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
}

.git-detail {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.git-detail > .git-diff-viewer {
  flex: 1;
  min-height: 0;
}

.git-loading-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  height: 2px;
  overflow: hidden;
  background: var(--surface-accent-blue-soft);
}

.git-loading-bar::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 30%;
  background: var(--color-accent-blue);
  animation: git-loading 1s ease-in-out infinite;
}

@keyframes git-loading {
  from { transform: translateX(-100%); }
  to { transform: translateX(340%); }
}

@media (prefers-reduced-motion: reduce) {
  .git-loading-bar::after { animation: none; width: 100%; opacity: 0.6; }
  .git-refresh .spinning { animation: none; }
}

.git-detail-empty {
  display: grid;
  place-items: center;
  flex: 1;
  padding: 20px;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: center;
}

.git-notice {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-accent-blue-soft);
  color: var(--color-text-secondary);
  font-size: 11px;
}

@media (max-width: 1100px) {
  .git-body--commit { grid-template-columns: minmax(200px, 240px) minmax(180px, 220px) minmax(0, 1fr); }
}

@media (max-width: 860px) {
  .git-body--two,
  .git-body--version { grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); }
  .git-body--commit { grid-template-columns: 200px 190px minmax(0, 1fr); }
}
</style>
