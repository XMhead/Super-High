<script setup lang="ts">
import { ArrowUpToLine, Copy, FilePlus, FileText, FoldVertical, FolderPlus, FolderSearch, NotebookPen, Pencil, RefreshCw, Trash2 } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { FileEntry } from '@/types'
import { fileIconComponents, fileIconTone } from '@/lib/fileIcons'
import { useWorkspaceStore } from '@/stores/workspace'
import { appConfirm, appPrompt } from '@/lib/appDialog'
import { backend } from '@/lib/tauri'
import { runMemoCommand } from '@/lib/memoCommands'
import FileTreeNode from './FileTreeNode.vue'

const store = useWorkspaceStore()
const props = withDefaults(defineProps<{
  rootPath?: string
  title?: string
  emptyText?: string
  customFileOpen?: boolean
  searchable?: boolean
  searchPlaceholder?: string
}>(), {
  rootPath: '',
  title: '资源管理器',
  emptyText: '当前目录为空。',
  customFileOpen: false,
  searchable: false,
  searchPlaceholder: '搜索文件...',
})
const emit = defineEmits<{
  (event: 'file-open', entry: FileEntry): void
  (event: 'directory-open', entry: FileEntry): void
}>()
const contextMenu = ref<{ x: number; y: number; entry: FileEntry | null } | null>(null)
const focusedPath = ref<string | null>(null)
const selectedPaths = ref<string[]>([])
const selectionAnchorPath = ref<string | null>(null)
const selectedPathSet = computed(() => new Set(selectedPaths.value))
const deleting = ref(false)
const importingMemo = ref(false)
const explorerBody = ref<HTMLElement | null>(null)
const explorerScrolled = ref(false)
const searchQuery = ref('')
const searchLoading = ref(false)
let viewportRestoreId = 0
let searchIndexRequestId = 0

const expandedPathSet = computed(() => new Set(store.expandedPaths))
const rowHeight = 22
const scrollTop = ref(0)
const viewportHeight = ref(660)
let resizeObserver: ResizeObserver | undefined
const treeRows = computed(() => {
  const rows: { entry: FileEntry; depth: number; hint?: string }[] = []
  const stack = entries.value.map((entry) => ({ entry, depth: 0 })).reverse()
  while (stack.length) {
    const row = stack.pop()!
    rows.push(row)
    if (row.entry.type !== 'directory' || !expandedPathSet.value.has(row.entry.path)) continue
    const listing = store.directoryCache[row.entry.path]
    const children = listing?.entries ?? []
    if (!children.length) {
      rows.push({ ...row, depth: row.depth + 1, hint: listing ? '空目录' : '读取中...' })
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ entry: children[i]!, depth: row.depth + 1 })
  }
  return rows
})
const displayRows = computed(() => normalizedSearchQuery.value
  ? searchResults.value.map((entry) => ({ entry, depth: 0, hint: undefined as string | undefined }))
  : treeRows.value)
const flatVisibleEntries = computed(() => displayRows.value.filter((row) => !row.hint).map((row) => row.entry))
const rowIndex = computed(() => new Map(displayRows.value.flatMap((row, index) => row.hint ? [] : [[row.entry.path, index] as const])))
const visibleStart = computed(() => Math.max(0, Math.min(displayRows.value.length - 1, Math.floor(scrollTop.value / rowHeight)) - 12))
const visibleEnd = computed(() => Math.min(displayRows.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / rowHeight) + 12))
const viewportRows = computed(() => displayRows.value.slice(visibleStart.value, visibleEnd.value))

const explorerRootPath = computed(() => normalizePath(props.rootPath || store.workspace?.rootPath || ''))
const entries = computed(() => {
  return explorerRootPath.value ? store.directoryCache[explorerRootPath.value]?.entries ?? [] : []
})
const settledSearchQuery = ref('')
const normalizedSearchQuery = computed(() => settledSearchQuery.value.trim().toLowerCase())
let queryTimer: ReturnType<typeof setTimeout> | undefined
let indexTask: Promise<void> | undefined
// Build names once per directory revision; typing only filters this inventory.
const searchableEntries = computed(() => {
  const result: { entry: FileEntry; text: string }[] = []
  const visited = new Set<string>()
  const pending = explorerRootPath.value ? [explorerRootPath.value] : []
  while (pending.length) {
    const path = pending.pop()!
    const key = normalizePath(path).toLowerCase()
    if (visited.has(key)) continue
    visited.add(key)
    for (const entry of store.directoryCache[path]?.entries ?? []) {
      if (entry.type === 'file') result.push({ entry, text: `${entry.name} ${relativePathOf(entry.path)}`.toLowerCase() })
      else pending.push(entry.path)
    }
  }
  return result
})
const searchResults = computed(() => {
  const query = normalizedSearchQuery.value
  return query ? searchableEntries.value.filter((item) => item.text.includes(query)).map((item) => item.entry) : []
})

const isRefreshing = computed(() => {
  const root = explorerRootPath.value
  if (!root) return false
  return store.loadingDirectories.some((path) => isSameOrChildPath(path, root))
})

const hasExpandedDirectories = computed(() => {
  const root = explorerRootPath.value
  if (!root) return false
  return store.expandedPaths.some((path) => path !== root && isSameOrChildPath(path, root))
})
const contextTargetPath = computed(() => contextMenu.value?.entry?.path ?? explorerRootPath.value)
const contextTargetName = computed(() => contextMenu.value?.entry?.name ?? explorerRootName.value)
const contextTargetDirectory = computed(() => {
  const entry = contextMenu.value?.entry
  if (!entry) return explorerRootPath.value
  return entry.type === 'directory' ? entry.path : parentDirectoryOf(entry.path)
})
const contextEntries = computed(() => {
  const entry = contextMenu.value?.entry
  if (!entry) return []
  return flatVisibleEntries.value.filter((item) => selectedPathSet.value.has(item.path))
})
const hasMultipleContextEntries = computed(() => contextEntries.value.length > 1)
const canEditContextTarget = computed(() => Boolean(contextMenu.value?.entry) && !hasMultipleContextEntries.value)
const explorerRootName = computed(() => {
  if (!explorerRootPath.value) return store.workspace ? store.currentProjectTitle : ''
  const normalized = explorerRootPath.value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || explorerRootPath.value
})

function openNodeContextMenu(entry: FileEntry, event: MouseEvent) {
  if (!selectedPathSet.value.has(entry.path)) {
    selectedPaths.value = [entry.path]
    selectionAnchorPath.value = entry.path
  }
  focusedPath.value = entry.path
  contextMenu.value = {
    ...clampMenuPosition(event.clientX, event.clientY),
    entry,
  }
}

function openRootContextMenu(event: MouseEvent) {
  if (!explorerRootPath.value) return
  selectedPaths.value = []
  contextMenu.value = {
    ...clampMenuPosition(event.clientX, event.clientY),
    entry: null,
  }
}

function selectEntry(entry: FileEntry, event: MouseEvent | KeyboardEvent) {
  const additive = event.ctrlKey || event.metaKey
  if (event.shiftKey) {
    const flat = flatVisibleEntries.value
    const anchor = flat.findIndex((item) => item.path === selectionAnchorPath.value)
    const target = flat.findIndex((item) => item.path === entry.path)
    const range = anchor < 0 ? [entry.path] : flat.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).map((item) => item.path)
    selectedPaths.value = additive ? [...new Set([...selectedPaths.value, ...range])] : range
    if (anchor < 0) selectionAnchorPath.value = entry.path
  } else {
    selectedPaths.value = additive
      ? selectedPathSet.value.has(entry.path) ? selectedPaths.value.filter((path) => path !== entry.path) : [...selectedPaths.value, entry.path]
      : [entry.path]
    selectionAnchorPath.value = entry.path
  }
  focusedPath.value = entry.path
}

function activateSearchEntry(entry: FileEntry, event: MouseEvent) {
  selectEntry(entry, event)
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey) void openFileEntry(entry)
}

function closeContextMenu() {
  contextMenu.value = null
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isSameOrChildPath(path: string, target: string): boolean {
  const normalized = normalizePath(path).toLowerCase()
  const normalizedTarget = normalizePath(target).toLowerCase()
  return normalized === normalizedTarget || normalized.startsWith(`${normalizedTarget}/`)
}

function clampMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const width = 250
  const height = 356
  const margin = 8
  return {
    x: Math.max(margin, Math.min(clientX, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(clientY, window.innerHeight - height - margin)),
  }
}

function parentDirectoryOf(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index === 2 && normalized[1] === ':') return normalized.slice(0, 3)
  return index > 0 ? normalized.slice(0, index) : normalized
}

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\\/g, '/').replace(/\/+$/, '')}/${name.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

function relativePathOf(path: string): string {
  const root = explorerRootPath.value.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = path.replace(/\\/g, '/')
  if (!root) return normalized
  if (normalized.toLowerCase() === root.toLowerCase()) return '.'
  const prefix = `${root}/`
  return normalized.toLowerCase().startsWith(prefix.toLowerCase()) ? normalized.slice(prefix.length) : normalized
}

async function copyText(value: string) {
  if (!value) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
  } else {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

async function openWithSuperHigh() {
  const entry = contextMenu.value?.entry
  closeContextMenu()
  if (!entry) return
  if (entry.type === 'directory') {
    await store.openProject(entry.path)
    return
  }
  await openFileEntry(entry)
}

async function importContentToMemo() {
  const entry = contextMenu.value?.entry
  if (!entry || entry.type !== 'file' || importingMemo.value || hasMultipleContextEntries.value) return
  closeContextMenu()
  importingMemo.value = true
  try {
    const file = await backend.readEditorFile(entry.path)
    await runMemoCommand({ operation: 'memo.create', options: { title: entry.name, content: file.content, category: '' } })
    store.setMemoWindowOpen(true)
    store.showActivityMessage('已导入文件内容到备忘录')
    store.showImportRecycleNotice(entry.path, entry.name)
  } catch (caught) {
    store.showActivityMessage(`导入备忘录失败：${caught instanceof Error ? caught.message : String(caught)}`)
  } finally {
    importingMemo.value = false
  }
}

async function openFileEntry(entry: FileEntry) {
  if (props.customFileOpen) {
    emit('file-open', entry)
    return
  }
  store.setWorkspaceSurface('project')
  if (store.settings.activePreviewMode !== 'code') store.setPreviewMode('code')
  await store.openFile(entry.path, { bindToActiveEditor: true })
}

async function createFileFromMenu() {
  const directory = contextTargetDirectory.value
  closeContextMenu()
  const name = await appPrompt('新建文件名')
  if (!name?.trim()) return
  await store.createFile(joinPath(directory, name.trim()))
}

async function createDirectoryFromMenu() {
  const directory = contextTargetDirectory.value
  closeContextMenu()
  const name = await appPrompt('新建文件夹名')
  if (!name?.trim()) return
  await store.createDirectory(joinPath(directory, name.trim()))
}

async function renameTarget() {
  const entry = contextMenu.value?.entry
  closeContextMenu()
  if (!entry) return
  const nextName = await appPrompt('重命名', entry.name)
  if (!nextName?.trim() || nextName.trim() === entry.name) return
  await store.renamePath(entry.path, nextName.trim())
}

async function deleteTarget() {
  const targets = [...contextEntries.value]
  closeContextMenu()
  await deleteEntries(targets)
}

async function deleteEntries(entries: FileEntry[]) {
  if (!entries.length || deleting.value) return
  const scrollTop = explorerBody.value?.scrollTop ?? 0
  const names = entries.slice(0, 6).map((entry) => `“${entry.name}”`).join('、')
  const label = entries.length === 1 ? names : `${names}${entries.length > 6 ? '等' : ''}，共 ${entries.length} 项`
  deleting.value = true
  try {
    if (!await appConfirm(`确定删除${label}吗？这会直接从磁盘删除，文件夹中的内容也会删除。`)) return
    // A selected directory already includes its selected descendants.
    const targets = entries.filter((entry) => !entries.some((parent) => parent.type === 'directory' && parent.path !== entry.path && isSameOrChildPath(entry.path, parent.path)))
    const deletedPaths: string[] = []
    const errors: string[] = []
    for (const entry of targets) {
      if (await store.deletePath(entry.path)) deletedPaths.push(entry.path)
      else errors.push(store.errorMessage)
    }
    selectedPaths.value = selectedPaths.value.filter((path) => !deletedPaths.some((deleted) => isSameOrChildPath(path, deleted)))
    if (errors.length) store.showErrorMessage(errors.join('\n'))
    await nextTick()
    if (explorerBody.value && scrollTop > 0) explorerBody.value.scrollTop = scrollTop
  } finally {
    deleting.value = false
  }
}

async function copyName() {
  const value = contextTargetName.value
  closeContextMenu()
  await copyText(value)
}

async function copyRelativePath() {
  const value = contextEntries.value.length
    ? contextEntries.value.map((entry) => relativePathOf(entry.path)).join('\n')
    : relativePathOf(contextTargetPath.value)
  closeContextMenu()
  await copyText(value)
}

async function copyAbsolutePath() {
  const value = contextEntries.value.length
    ? contextEntries.value.map((entry) => entry.path).join('\n')
    : contextTargetPath.value
  closeContextMenu()
  await copyText(value)
}

async function revealInExplorer() {
  const path = contextTargetPath.value
  closeContextMenu()
  if (!path) return
  await store.openPath(path)
}

async function refreshExplorer() {
  const path = explorerRootPath.value
  closeContextMenu()
  if (!path) return
  ++searchIndexRequestId
  indexTask = undefined
  searchLoading.value = false
  await store.refreshExplorer(path)
  ensureSearchIndex()
}

function scrollExplorerTop() {
  closeContextMenu()
  explorerBody.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

function onExplorerScroll() {
  scrollTop.value = explorerBody.value?.scrollTop ?? 0
  explorerScrolled.value = scrollTop.value > 0
  closeContextMenu()
}

function collapseAllDirectories() {
  const root = explorerRootPath.value
  closeContextMenu()
  if (!root) return
  store.collapseAllDirectories(root)
}

async function loadSearchIndex(path: string, requestId: number) {
  const pending = [path]
  const visited = new Set<string>()
  while (pending.length && requestId === searchIndexRequestId) {
    const next = pending.pop()!
    const key = normalizePath(next).toLowerCase()
    if (visited.has(key)) continue
    visited.add(key)
    if (!store.directoryCache[next]) await store.loadDirectory(next).catch(() => undefined)
    if (requestId !== searchIndexRequestId) return
    for (const entry of store.directoryCache[next]?.entries ?? []) {
      if (entry.type === 'directory') pending.push(entry.path)
    }
    // Yield between cached batches as well, so large warm trees do not block input.
    if (visited.size % 64 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (store.settingsOpen) return
  if (event.key === 'Escape') {
    closeContextMenu()
    return
  }
  if (event.key === 'F2' && canEditContextTarget.value) {
    event.preventDefault()
    void renameTarget()
  }
}

function onExplorerKeydown(event: KeyboardEvent) {
  if (event.target instanceof Element && event.target.closest('.app-dialog')) return
  const flat = flatVisibleEntries.value
  if (!flat.length) return
  const currentIndex = focusedPath.value ? flat.findIndex((e) => e.path === focusedPath.value) : -1

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    selectedPaths.value = flat.map((entry) => entry.path)
    return
  }
  if (event.key === 'Delete' && selectedPaths.value.length) {
    event.preventDefault()
    closeContextMenu()
    void deleteEntries(flat.filter((entry) => selectedPathSet.value.has(entry.path)))
    return
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    explorerBody.value?.focus({ preventScroll: true })
    const next = Math.min(currentIndex + 1, flat.length - 1)
    focusedPath.value = flat[next]?.path ?? null
    if (flat[next] && (!event.ctrlKey && !event.metaKey || event.shiftKey)) selectEntry(flat[next], event)
    scrollFocusedIntoView()
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    explorerBody.value?.focus({ preventScroll: true })
    const next = Math.max(currentIndex - 1, 0)
    focusedPath.value = flat[next]?.path ?? null
    if (flat[next] && (!event.ctrlKey && !event.metaKey || event.shiftKey)) selectEntry(flat[next], event)
    scrollFocusedIntoView()
    return
  }
  if (event.key === 'Enter' && focusedPath.value) {
    event.preventDefault()
    const entry = flat[currentIndex]
    if (entry) {
      if (entry.type === 'directory') {
        emit('directory-open', entry)
        void store.toggleDirectory(entry.path)
      }
      else void openFileEntry(entry)
    }
    return
  }
  if (event.key === 'ArrowRight' && focusedPath.value) {
    const entry = flat[currentIndex]
    if (entry?.type === 'directory' && !expandedPathSet.value.has(entry.path)) {
      event.preventDefault()
      emit('directory-open', entry)
      void store.toggleDirectory(entry.path)
    }
    return
  }
  if (event.key === 'ArrowLeft' && focusedPath.value) {
    const entry = flat[currentIndex]
    if (entry?.type === 'directory' && expandedPathSet.value.has(entry.path)) {
      event.preventDefault()
      void store.toggleDirectory(entry.path)
    }
    return
  }
}

function scrollFocusedIntoView() {
  const index = focusedPath.value ? rowIndex.value.get(focusedPath.value) : undefined
  const container = explorerBody.value
  if (index === undefined || !container) return
  const top = index * rowHeight
  if (top < container.scrollTop) container.scrollTop = top
  else if (top + rowHeight > container.scrollTop + (container.clientHeight || viewportHeight.value)) {
    container.scrollTop = top + rowHeight - (container.clientHeight || viewportHeight.value)
  }
  onExplorerScroll()
}

function preserveExplorerViewport(previousRows: typeof displayRows.value) {
  const container = explorerBody.value
  if (!container || container.scrollTop <= 0) return
  const previousScrollTop = container.scrollTop
  const anchorIndex = Math.min(previousRows.length - 1, Math.floor(previousScrollTop / rowHeight))
  const anchor = previousRows[anchorIndex]
  if (!anchor) return
  const nextIndex = displayRows.value.findIndex((row) => row.entry.path === anchor.entry.path && Boolean(row.hint) === Boolean(anchor.hint))
  const targetScrollTop = nextIndex < 0 ? previousScrollTop : previousScrollTop + (nextIndex - anchorIndex) * rowHeight
  const restoreId = ++viewportRestoreId
  void nextTick().then(() => {
    // A later user scroll or root change takes precedence over this pending restore.
    if (restoreId !== viewportRestoreId || !container.isConnected || container.scrollTop !== previousScrollTop) return
    container.scrollTop = targetScrollTop
    onExplorerScroll()
  })
}

function syncFocusedPathFromStore() {
  const path = store.explorerFocusedPath
  if (!path) return
  if (explorerRootPath.value && !isSameOrChildPath(path, explorerRootPath.value)) return
  focusedPath.value = path
  scrollFocusedIntoView()
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && explorerBody.value) {
    resizeObserver = new ResizeObserver(([entry]) => { if (entry) viewportHeight.value = entry.contentRect.height })
    resizeObserver.observe(explorerBody.value)
  }
  document.addEventListener('click', closeContextMenu)
  document.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('resize', closeContextMenu)
})

onBeforeUnmount(() => {
  ++searchIndexRequestId
  clearTimeout(queryTimer)
  resizeObserver?.disconnect()
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('resize', closeContextMenu)
})

watch(explorerRootPath, (path) => {
  ++searchIndexRequestId
  indexTask = undefined
  searchLoading.value = false
  clearTimeout(queryTimer)
  settledSearchQuery.value = searchQuery.value
  ++viewportRestoreId
  scrollTop.value = 0
  if (explorerBody.value) explorerBody.value.scrollTop = 0
  explorerScrolled.value = false
  selectedPaths.value = []
  selectionAnchorPath.value = null
  focusedPath.value = null
  closeContextMenu()
  if (!path) return
  void store.loadDirectory(path, !store.directoryCache[path]).catch(() => undefined)
}, { immediate: true })

watch(normalizedSearchQuery, () => {
  if (explorerBody.value) explorerBody.value.scrollTop = 0
  scrollTop.value = 0
})
watch(searchQuery, (query) => {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(() => { settledSearchQuery.value = query }, 160)
})
function ensureSearchIndex() {
  const rootPath = explorerRootPath.value
  if (!normalizedSearchQuery.value || !rootPath || indexTask) return
  const requestId = searchIndexRequestId
  searchLoading.value = true
  indexTask = loadSearchIndex(rootPath, requestId).finally(() => {
    if (requestId === searchIndexRequestId) searchLoading.value = false
  })
}
watch([normalizedSearchQuery, explorerRootPath], ensureSearchIndex)
watch(entries, () => {
  if (searchLoading.value) return
  indexTask = undefined
  ensureSearchIndex()
})

watch(
  () => store.explorerRevealRequestId,
  () => syncFocusedPathFromStore(),
)

watch(
  displayRows,
  (_rows, previousRows) => {
    preserveExplorerViewport(previousRows)
    const visible = new Set(flatVisibleEntries.value.map((entry) => entry.path))
    selectedPaths.value = selectedPaths.value.filter((path) => visible.has(path))
  },
  { flush: 'pre' },
)
</script>

<template>
  <aside class="panel explorer-panel">
    <div class="panel-header">
      <div class="panel-title">{{ title }}</div>
      <input
        v-if="searchable"
        v-model="searchQuery"
        class="explorer-search-input"
        type="search"
        :placeholder="searchPlaceholder"
        aria-label="搜索文件"
      />
      <button
        type="button"
        class="icon-button explorer-top-button"
        :disabled="!explorerScrolled"
        title="返回顶部"
        aria-label="返回顶部"
        @click="scrollExplorerTop"
      >
        <ArrowUpToLine :size="14" />
      </button>
      <button
        type="button"
        class="icon-button explorer-collapse-button"
        :disabled="!explorerRootPath || !hasExpandedDirectories"
        title="收起所有文件夹"
        aria-label="收起所有文件夹"
        @click="collapseAllDirectories"
      >
        <FoldVertical :size="14" />
      </button>
      <button
        type="button"
        class="icon-button explorer-refresh-button"
        :class="{ refreshing: isRefreshing }"
        :disabled="!explorerRootPath"
        :title="isRefreshing ? '再次刷新' : '刷新'"
        :aria-label="isRefreshing ? '再次刷新' : '刷新'"
        @click="refreshExplorer"
      >
        <RefreshCw :size="14" />
      </button>
    </div>
    <div ref="explorerBody" class="explorer-body" tabindex="0" @contextmenu.prevent="openRootContextMenu" @scroll.passive="onExplorerScroll" @keydown="onExplorerKeydown">
      <div :style="{ height: `${visibleStart * rowHeight}px` }" aria-hidden="true" />
      <template v-for="row in viewportRows" :key="row.entry.path + (row.hint ? ':hint' : '')">
        <div v-if="row.hint" class="tree-hint explorer-virtual-hint" :style="{ paddingLeft: `${row.depth * 14 + 25}px` }">{{ row.hint }}</div>
        <button
          v-else-if="normalizedSearchQuery"
          type="button"
          class="tree-entry explorer-search-result"
          :class="{ active: store.activeTab?.path === row.entry.path, focused: focusedPath === row.entry.path, selected: selectedPathSet.has(row.entry.path) }"
          :aria-pressed="selectedPathSet.has(row.entry.path)"
          :title="row.entry.path"
          :data-path="row.entry.path"
          @click="activateSearchEntry(row.entry, $event)"
          @contextmenu.prevent.stop="openNodeContextMenu(row.entry, $event)"
        >
          <span class="tree-kind-icon" :class="fileIconTone(row.entry.path, row.entry.extension)" aria-hidden="true">
            <component :is="fileIconComponents[fileIconTone(row.entry.path, row.entry.extension)]" :size="15" :stroke-width="1.9" />
          </span>
          <span class="tree-name">{{ row.entry.name }}</span>
          <span class="explorer-search-result-path">{{ relativePathOf(row.entry.path) }}</span>
        </button>
        <FileTreeNode
          v-else
          :entry="row.entry"
          :depth="row.depth"
          flat
          :expanded-paths="expandedPathSet"
          :focused-path="focusedPath"
          :context-menu-path="contextMenu?.entry?.path ?? null"
          :selected-paths="selectedPathSet"
          @node-select="selectEntry"
          @node-context-menu="openNodeContextMenu"
          @node-file-open="openFileEntry"
          @node-directory-open="emit('directory-open', $event)"
        />
      </template>
      <div :style="{ height: `${Math.max(0, displayRows.length - visibleEnd) * rowHeight}px` }" aria-hidden="true" />
      <div v-if="normalizedSearchQuery && searchLoading" class="empty-hint">搜索中...</div>
      <div v-else-if="normalizedSearchQuery && !searchResults.length" class="empty-hint">未找到匹配文件。</div>
      <div v-if="!normalizedSearchQuery && explorerRootPath && !entries.length" class="empty-hint">{{ emptyText }}</div>
      <div v-if="!explorerRootPath" class="empty-hint">先打开一个项目。</div>
    </div>
    <div
      v-if="contextMenu"
      class="file-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      role="menu"
      @click.stop
      @contextmenu.prevent
    >
      <button type="button" class="file-context-item" :disabled="!canEditContextTarget" @click="openWithSuperHigh">
        <span class="context-icon"><FileText :size="14" /></span>
        <span>通过 Super High 打开</span>
      </button>
      <button type="button" class="file-context-item" :disabled="hasMultipleContextEntries" @click="revealInExplorer">
        <span class="context-icon"><FolderSearch :size="14" /></span>
        <span>在文件资源管理器中显示</span>
      </button>
      <button type="button" class="file-context-item" :disabled="!canEditContextTarget || contextMenu.entry?.type !== 'file' || importingMemo" @click="importContentToMemo">
        <span class="context-icon"><NotebookPen :size="14" /></span>
        <span>导入内容到备忘录</span>
      </button>
      <div class="file-context-separator" />
      <button type="button" class="file-context-item" :disabled="hasMultipleContextEntries" @click="createFileFromMenu">
        <span class="context-icon"><FilePlus :size="14" /></span>
        <span>新建文件</span>
      </button>
      <button type="button" class="file-context-item" :disabled="hasMultipleContextEntries" @click="createDirectoryFromMenu">
        <span class="context-icon"><FolderPlus :size="14" /></span>
        <span>新建文件夹</span>
      </button>
      <div class="file-context-separator" />
      <button type="button" class="file-context-item" :disabled="!canEditContextTarget" @click="renameTarget">
        <span class="context-icon"><Pencil :size="14" /></span>
        <span>重命名</span>
        <span class="context-shortcut">F2</span>
      </button>
      <button type="button" class="file-context-item danger" :disabled="!contextEntries.length || deleting" @click="deleteTarget">
        <span class="context-icon"><Trash2 :size="14" /></span>
        <span>{{ hasMultipleContextEntries ? `删除 ${contextEntries.length} 项` : '删除' }}</span>
      </button>
      <div class="file-context-separator" />
      <button type="button" class="file-context-item" :disabled="hasMultipleContextEntries" @click="copyName">
        <span class="context-icon"><Copy :size="14" /></span>
        <span>复制名称</span>
      </button>
      <button type="button" class="file-context-item" @click="copyRelativePath">
        <span class="context-icon"><Copy :size="14" /></span>
        <span>复制相对路径</span>
      </button>
      <button type="button" class="file-context-item" @click="copyAbsolutePath">
        <span class="context-icon"><Copy :size="14" /></span>
        <span>复制完整路径</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.explorer-virtual-hint { height: 22px; box-sizing: border-box; margin: 0; }
.explorer-search-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  color: var(--color-text-primary);
  background: var(--color-bg-primary);
  font: inherit;
  font-size: 12px;
}

.explorer-search-input:focus {
  border-color: var(--color-accent-blue);
  outline: 0;
}

.explorer-search-result-path {
  flex: none;
  max-width: 50%;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
