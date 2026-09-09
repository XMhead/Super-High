<script setup lang="ts">
import { Copy, FilePlus, FileText, FoldVertical, FolderPlus, FolderSearch, Pencil, RefreshCw, Trash2 } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { FileEntry } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
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
}>()
const contextMenu = ref<{ x: number; y: number; entry: FileEntry | null } | null>(null)
const focusedPath = ref<string | null>(null)
const explorerBody = ref<HTMLElement | null>(null)
const searchQuery = ref('')
const searchLoading = ref(false)
let viewportRestoreId = 0
let searchIndexRequestId = 0

const flatVisibleEntries = computed((): FileEntry[] => {
  if (normalizedSearchQuery.value) return searchResults.value
  const result: FileEntry[] = []
  function walk(entries: FileEntry[]) {
    for (const entry of entries) {
      result.push(entry)
      if (entry.type === 'directory' && store.expandedPaths.includes(entry.path)) {
        const children = store.directoryCache[entry.path]?.entries ?? []
        walk(children)
      }
    }
  }
  walk(entries.value)
  return result
})

const explorerRootPath = computed(() => normalizePath(props.rootPath || store.workspace?.rootPath || ''))
const entries = computed(() => {
  return explorerRootPath.value ? store.directoryCache[explorerRootPath.value]?.entries ?? [] : []
})
const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase())
const searchResults = computed(() => {
  const query = normalizedSearchQuery.value
  if (!query || !explorerRootPath.value) return []
  const result: FileEntry[] = []
  const visited = new Set<string>()
  function walk(path: string) {
    const pathKey = normalizePath(path).toLowerCase()
    if (visited.has(pathKey)) return
    visited.add(pathKey)
    for (const entry of store.directoryCache[path]?.entries ?? []) {
      if (entry.type === 'file' && `${entry.name} ${relativePathOf(entry.path)}`.toLowerCase().includes(query)) result.push(entry)
      if (entry.type === 'directory') walk(entry.path)
    }
  }
  walk(explorerRootPath.value)
  return result
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
const canEditContextTarget = computed(() => Boolean(contextMenu.value?.entry))
const explorerRootName = computed(() => {
  if (!explorerRootPath.value) return store.workspace ? store.currentProjectTitle : ''
  const normalized = explorerRootPath.value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || explorerRootPath.value
})

function openNodeContextMenu(entry: FileEntry, event: MouseEvent) {
  contextMenu.value = {
    ...clampMenuPosition(event.clientX, event.clientY),
    entry,
  }
}

function openRootContextMenu(event: MouseEvent) {
  if (!explorerRootPath.value) return
  contextMenu.value = {
    ...clampMenuPosition(event.clientX, event.clientY),
    entry: null,
  }
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
  const height = 320
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

async function openFileEntry(entry: FileEntry) {
  if (props.customFileOpen) {
    emit('file-open', entry)
    return
  }
  store.setWorkspaceSurface('project')
  if (store.settings.activePreviewMode !== 'code') store.setPreviewMode('code')
  await store.openFile(entry.path)
}

async function createFileFromMenu() {
  const directory = contextTargetDirectory.value
  closeContextMenu()
  const name = window.prompt('新建文件名')
  if (!name?.trim()) return
  await store.createFile(joinPath(directory, name.trim()))
}

async function createDirectoryFromMenu() {
  const directory = contextTargetDirectory.value
  closeContextMenu()
  const name = window.prompt('新建文件夹名')
  if (!name?.trim()) return
  await store.createDirectory(joinPath(directory, name.trim()))
}

async function renameTarget() {
  const entry = contextMenu.value?.entry
  closeContextMenu()
  if (!entry) return
  const nextName = window.prompt('重命名', entry.name)
  if (!nextName?.trim() || nextName.trim() === entry.name) return
  await store.renamePath(entry.path, nextName.trim())
}

async function deleteTarget() {
  const entry = contextMenu.value?.entry
  closeContextMenu()
  if (!entry) return
  const confirmed = window.confirm(`确定删除“${entry.name}”吗？这会直接从磁盘删除。`)
  if (!confirmed) return
  await store.deletePath(entry.path)
}

async function copyName() {
  const value = contextTargetName.value
  closeContextMenu()
  await copyText(value)
}

async function copyRelativePath() {
  const value = relativePathOf(contextTargetPath.value)
  closeContextMenu()
  await copyText(value)
}

async function copyAbsolutePath() {
  const value = contextTargetPath.value
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
  await store.refreshExplorer(path)
}

function collapseAllDirectories() {
  const root = explorerRootPath.value
  closeContextMenu()
  if (!root) return
  store.collapseAllDirectories(root)
}

async function loadSearchIndex(path: string, requestId: number) {
  if (requestId !== searchIndexRequestId) return
  await store.loadDirectory(path, !store.directoryCache[path]).catch(() => undefined)
  const childDirectories = (store.directoryCache[path]?.entries ?? []).filter((entry) => entry.type === 'directory')
  for (const directory of childDirectories) await loadSearchIndex(directory.path, requestId)
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (store.settingsOpen) return
  if (event.key === 'Escape') {
    closeContextMenu()
    return
  }
  if (event.key === 'F2' && contextMenu.value?.entry) {
    event.preventDefault()
    void renameTarget()
  }
}

function onExplorerKeydown(event: KeyboardEvent) {
  const flat = flatVisibleEntries.value
  if (!flat.length) return
  const currentIndex = focusedPath.value ? flat.findIndex((e) => e.path === focusedPath.value) : -1

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    const next = Math.min(currentIndex + 1, flat.length - 1)
    focusedPath.value = flat[next]?.path ?? null
    scrollFocusedIntoView()
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    const next = Math.max(currentIndex - 1, 0)
    focusedPath.value = flat[next]?.path ?? null
    scrollFocusedIntoView()
    return
  }
  if (event.key === 'Enter' && focusedPath.value) {
    event.preventDefault()
    const entry = flat[currentIndex]
    if (entry) {
      if (entry.type === 'directory') void store.toggleDirectory(entry.path)
      else void openFileEntry(entry)
    }
    return
  }
  if (event.key === 'ArrowRight' && focusedPath.value) {
    const entry = flat[currentIndex]
    if (entry?.type === 'directory' && !store.expandedPaths.includes(entry.path)) {
      event.preventDefault()
      void store.toggleDirectory(entry.path)
    }
    return
  }
  if (event.key === 'ArrowLeft' && focusedPath.value) {
    const entry = flat[currentIndex]
    if (entry?.type === 'directory' && store.expandedPaths.includes(entry.path)) {
      event.preventDefault()
      void store.toggleDirectory(entry.path)
    }
    return
  }
}

function scrollFocusedIntoView() {
  if (!focusedPath.value) return
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.tree-entry[data-path="${CSS.escape(focusedPath.value!)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function preserveExplorerViewport() {
  const container = explorerBody.value
  if (!container || container.scrollTop <= 0) return

  const containerTop = container.getBoundingClientRect().top
  const entries = Array.from(container.querySelectorAll<HTMLElement>('.tree-entry'))
  const anchor = entries.find((entry) => entry.getBoundingClientRect().bottom > containerTop)
  const scrollTop = container.scrollTop
  const anchorPath = anchor?.dataset.path
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - containerTop : 0
  const restoreId = ++viewportRestoreId

  void nextTick().then(() => {
    if (restoreId !== viewportRestoreId || !container.isConnected) return
    const nextAnchor = anchorPath
      ? Array.from(container.querySelectorAll<HTMLElement>('.tree-entry'))
          .find((entry) => entry.dataset.path === anchorPath) ?? null
      : null
    if (!nextAnchor) {
      container.scrollTop = scrollTop
      return
    }
    container.scrollTop += nextAnchor.getBoundingClientRect().top - containerTop - anchorOffset
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
  document.addEventListener('click', closeContextMenu)
  document.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('resize', closeContextMenu)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('resize', closeContextMenu)
})

watch(explorerRootPath, (path) => {
  if (!path) return
  searchQuery.value = ''
  void store.loadDirectory(path, !store.directoryCache[path]).catch(() => undefined)
}, { immediate: true })

watch([normalizedSearchQuery, explorerRootPath], ([query, rootPath]) => {
  const requestId = ++searchIndexRequestId
  if (!query || !rootPath) {
    searchLoading.value = false
    return
  }
  searchLoading.value = true
  void loadSearchIndex(rootPath, requestId).finally(() => {
    if (requestId === searchIndexRequestId) searchLoading.value = false
  })
})

watch(
  () => store.explorerRevealRequestId,
  () => syncFocusedPathFromStore(),
)

watch(
  () => flatVisibleEntries.value.map((entry) => entry.path).join('\u0000'),
  () => preserveExplorerViewport(),
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
    <div ref="explorerBody" class="explorer-body" tabindex="0" @contextmenu.prevent="openRootContextMenu" @scroll.passive="closeContextMenu" @keydown="onExplorerKeydown">
      <template v-if="normalizedSearchQuery">
        <button
          v-for="entry in searchResults"
          :key="entry.path"
          type="button"
          class="tree-entry explorer-search-result"
          :class="{ active: store.activeTab?.path === entry.path, focused: store.explorerFocusedPath === entry.path }"
          :title="entry.path"
          :data-path="entry.path"
          @click="openFileEntry(entry)"
          @contextmenu.prevent.stop="openNodeContextMenu(entry, $event)"
        >
          <FileText :size="15" class="tree-kind-icon data" aria-hidden="true" />
          <span class="tree-name">{{ entry.name }}</span>
          <span class="explorer-search-result-path">{{ relativePathOf(entry.path) }}</span>
        </button>
        <div v-if="searchLoading" class="empty-hint">搜索中...</div>
        <div v-else-if="!searchResults.length" class="empty-hint">未找到匹配文件。</div>
      </template>
      <template v-else>
        <FileTreeNode
          v-for="entry in entries"
          :key="entry.path"
          :entry="entry"
          :depth="0"
          :context-menu-path="contextMenu?.entry?.path ?? null"
          @node-context-menu="openNodeContextMenu"
          @node-file-open="openFileEntry"
        />
      </template>
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
      <button type="button" class="file-context-item" :disabled="!contextMenu.entry" @click="openWithSuperHigh">
        <span class="context-icon"><FileText :size="14" /></span>
        <span>通过 Super High 打开</span>
      </button>
      <button type="button" class="file-context-item" @click="revealInExplorer">
        <span class="context-icon"><FolderSearch :size="14" /></span>
        <span>在文件资源管理器中显示</span>
      </button>
      <div class="file-context-separator" />
      <button type="button" class="file-context-item" @click="createFileFromMenu">
        <span class="context-icon"><FilePlus :size="14" /></span>
        <span>新建文件</span>
      </button>
      <button type="button" class="file-context-item" @click="createDirectoryFromMenu">
        <span class="context-icon"><FolderPlus :size="14" /></span>
        <span>新建文件夹</span>
      </button>
      <div class="file-context-separator" />
      <button type="button" class="file-context-item" :disabled="!canEditContextTarget" @click="renameTarget">
        <span class="context-icon"><Pencil :size="14" /></span>
        <span>重命名</span>
        <span class="context-shortcut">F2</span>
      </button>
      <button type="button" class="file-context-item danger" :disabled="!canEditContextTarget" @click="deleteTarget">
        <span class="context-icon"><Trash2 :size="14" /></span>
        <span>删除</span>
      </button>
      <div class="file-context-separator" />
      <button type="button" class="file-context-item" @click="copyName">
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
