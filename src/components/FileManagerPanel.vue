<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  ArrowLeftRight,
  ArrowUp,
  CheckSquare,
  Clipboard,
  ClipboardPaste,
  Copy,
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ImageDown,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'

import { backend } from '@/lib/tauri'
import {
  buildBreadcrumbs,
  extensionFromPath,
  fileNameFromPath,
  isMediaFile,
  isMediaImage,
  isMediaVideo,
  normalizePath,
} from '@/lib/path'
import type { FileEntry, ProjectFileMatch } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'

import EditorPane from './EditorPane.vue'
import FileManagerTreeNode from './FileManagerTreeNode.vue'

interface FileManagerTab {
  id: string
  path: string
  name: string
}

type ClipboardMode = 'copy' | 'cut'

interface LocalClipboard {
  mode: ClipboardMode
  paths: string[]
}

interface MediaPreviewState {
  open: boolean
  items: FileEntry[]
  index: number
  zoom: number
  panX: number
  panY: number
}

interface MediaDragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

const THUMBNAIL_LIMIT = 80

const store = useWorkspaceStore()
const tabs = ref<FileManagerTab[]>([])
const activeTabId = ref('')
const currentDirectory = ref('')
const expandedPaths = ref<string[]>([])
const selectedPaths = ref<string[]>([])
const localClipboard = ref<LocalClipboard | null>(null)
const searchDraft = ref('')
const mediaDataUrls = ref<Record<string, string>>({})
const mediaLoadingPaths = new Set<string>()
const mediaPreview = ref<MediaPreviewState>(createMediaPreviewState())
const mediaDrag = ref<MediaDragState | null>(null)
let searchTimer: number | null = null

const rootPath = computed(() => normalizeDirectoryPath(store.workspace?.rootPath ?? ''))
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null)
const normalizedCurrentDirectory = computed(() => normalizeDirectoryPath(currentDirectory.value || activeTab.value?.path || rootPath.value))
const breadcrumbs = computed(() => buildBreadcrumbs(normalizedCurrentDirectory.value))
const listing = computed(() => store.directoryCache[normalizedCurrentDirectory.value]?.entries ?? [])
const selectedEntries = computed(() => {
  const selected = new Set(selectedPaths.value)
  return listing.value.filter((entry) => selected.has(entry.path))
})
const activeFilePath = computed(() => store.activeTab?.path ?? '')
const activeFileName = computed(() => activeFilePath.value ? fileNameFromPath(activeFilePath.value) : '未打开文件')
const selectedPathSet = computed(() => new Set(selectedPaths.value))
const canPaste = computed(() => !!localClipboard.value?.paths.length && !!normalizedCurrentDirectory.value)
const canGoParent = computed(() => {
  const current = normalizedCurrentDirectory.value
  return Boolean(current && parentDirectoryOf(current) !== current)
})
const showSearchResults = computed(() => Boolean(searchDraft.value.trim()) || store.searchLoading)
const mediaEntries = computed(() => listing.value.filter((entry) => entry.type === 'file' && isMediaEntry(entry)))
const currentMedia = computed(() => mediaPreview.value.items[mediaPreview.value.index] ?? null)
const currentMediaDataUrl = computed(() => currentMedia.value ? mediaDataUrls.value[currentMedia.value.path] ?? '' : '')
const currentMediaTransformStyle = computed(() => ({
  transform: `translate(${mediaPreview.value.panX}px, ${mediaPreview.value.panY}px) scale(${mediaPreview.value.zoom})`,
}))
const canReplaceImageFromClipboard = computed(() => {
  if (selectedEntries.value.length !== 1) return false
  return selectedEntries.value[0].type === 'file' && isImageEntry(selectedEntries.value[0])
})
const selectedSummary = computed(() => selectedPaths.value.length ? `已选 ${selectedPaths.value.length} 项` : '未选择')

function createMediaPreviewState(overrides: Partial<MediaPreviewState> = {}): MediaPreviewState {
  return {
    open: false,
    items: [],
    index: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    ...overrides,
  }
}

function normalizeDirectoryPath(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '')
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`
  return normalized
}

function parentDirectoryOf(path: string): string {
  const normalized = normalizeDirectoryPath(path)
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized
  const trimmed = normalized.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index === 2 && trimmed[1] === ':') return trimmed.slice(0, 3)
  return index > 0 ? trimmed.slice(0, index) : trimmed
}

function randomId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function directoryName(path: string): string {
  const normalized = normalizeDirectoryPath(path)
  return normalized.split('/').filter(Boolean).pop() ?? normalized
}

function extensionFor(entry: FileEntry): string {
  return (entry.extension ?? extensionFromPath(entry.name)).toLowerCase()
}

function isImageEntry(entry: FileEntry): boolean {
  return isMediaImage(entry.path || entry.name)
}

function isVideoEntry(entry: FileEntry): boolean {
  return isMediaVideo(entry.path || entry.name)
}

function isMediaEntry(entry: FileEntry): boolean {
  return isMediaFile(entry.path || entry.name)
}

function entryIcon(entry: FileEntry) {
  if (entry.type === 'directory') return Folder
  const extension = extensionFor(entry)
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.html', '.rs', '.py'].includes(extension)) return FileCode2
  if (['.json', '.jsonc', '.lock', '.yml', '.yaml', '.toml', '.xml', '.ini'].includes(extension)) return FileJson
  if (['.md', '.mdx', '.txt'].includes(extension)) return FileText
  if (isMediaFile(entry.path || entry.name)) return FileImage
  return File
}

function entryClass(entry: FileEntry): string {
  if (entry.type === 'directory') return 'directory'
  const extension = extensionFor(entry)
  if (isMediaFile(entry.path || entry.name)) return 'image'
  if (['.json', '.jsonc', '.lock', '.yml', '.yaml', '.toml', '.xml', '.ini'].includes(extension)) return 'data'
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.html', '.rs', '.py'].includes(extension)) return 'code'
  if (['.md', '.mdx', '.txt'].includes(extension)) return 'document'
  return 'file'
}

function entryMeta(entry: FileEntry): string {
  if (entry.type === 'directory') return '文件夹'
  if (typeof entry.size !== 'number') return entry.extension || '文件'
  return formatSize(entry.size)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function setTabsForRoot(path: string) {
  if (!path) {
    tabs.value = []
    activeTabId.value = ''
    currentDirectory.value = ''
    selectedPaths.value = []
    return
  }
  if (tabs.value.length && tabs.value.some((tab) => tab.path === path)) return
  const tab = { id: randomId('fm-tab'), path, name: directoryName(path) }
  tabs.value = [tab]
  activeTabId.value = tab.id
  currentDirectory.value = path
  expandedPaths.value = Array.from(new Set([...expandedPaths.value, path]))
}

async function addTab(path: string) {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized) return
  const existing = tabs.value.find((tab) => tab.path.toLowerCase() === normalized.toLowerCase())
  if (existing) {
    activeTabId.value = existing.id
    await navigateDirectory(existing.path)
    return
  }
  const tab = { id: randomId('fm-tab'), path: normalized, name: directoryName(normalized) }
  tabs.value = [...tabs.value, tab]
  activeTabId.value = tab.id
  expandedPaths.value = Array.from(new Set([...expandedPaths.value, normalized]))
  await navigateDirectory(normalized)
}

async function chooseDirectory() {
  const selected = await backend.selectDirectory(normalizedCurrentDirectory.value || rootPath.value)
  if (selected) await addTab(selected)
}

function closeTab(tabId: string) {
  const index = tabs.value.findIndex((tab) => tab.id === tabId)
  if (index < 0) return
  tabs.value = tabs.value.filter((tab) => tab.id !== tabId)
  if (activeTabId.value !== tabId) return
  const next = tabs.value[index] ?? tabs.value[Math.max(0, index - 1)] ?? tabs.value[0] ?? null
  activeTabId.value = next?.id ?? ''
  currentDirectory.value = next?.path ?? ''
  selectedPaths.value = []
}

async function activateTab(tab: FileManagerTab) {
  activeTabId.value = tab.id
  await navigateDirectory(tab.path)
}

async function navigateDirectory(path: string) {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized) return
  currentDirectory.value = normalized
  selectedPaths.value = []
  await store.loadDirectory(normalized).catch(() => undefined)
}

async function toggleTreeDirectory(path: string) {
  const normalized = normalizeDirectoryPath(path)
  if (expandedPaths.value.includes(normalized)) {
    expandedPaths.value = expandedPaths.value.filter((item) => item !== normalized)
    return
  }
  expandedPaths.value = [...expandedPaths.value, normalized]
  await store.loadDirectory(normalized).catch(() => undefined)
}

async function openEntry(entry: FileEntry, event?: MouseEvent) {
  if (event?.ctrlKey || event?.metaKey) {
    toggleSelected(entry.path)
    return
  }
  selectedPaths.value = [entry.path]
  if (entry.type === 'directory') {
    await navigateDirectory(entry.path)
    return
  }
  if (isMediaEntry(entry)) {
    await showMediaPreview(entry)
    return
  }
  await store.openFile(entry.path)
}

async function openTreeEntry(entry: FileEntry, event: MouseEvent) {
  if (entry.type === 'directory') {
    await navigateDirectory(entry.path)
    if (!expandedPaths.value.includes(entry.path)) expandedPaths.value = [...expandedPaths.value, entry.path]
    return
  }
  await openEntry(entry, event)
}

async function openSearchResult(result: ProjectFileMatch) {
  clearSearch()
  await store.openFile(result.path)
  await navigateDirectory(parentDirectoryOf(result.path))
}

function toggleSelected(path: string) {
  selectedPaths.value = selectedPathSet.value.has(path)
    ? selectedPaths.value.filter((item) => item !== path)
    : [...selectedPaths.value, path]
}

function selectAllEntries() {
  selectedPaths.value = listing.value.map((entry) => entry.path)
}

function clearSelection() {
  selectedPaths.value = []
}

async function goParent() {
  if (!canGoParent.value) return
  await navigateDirectory(parentDirectoryOf(normalizedCurrentDirectory.value))
}

async function refreshCurrentDirectory() {
  if (!normalizedCurrentDirectory.value) return
  await store.loadDirectory(normalizedCurrentDirectory.value, true).catch(() => undefined)
}

async function revealCurrentDirectory() {
  if (!normalizedCurrentDirectory.value) return
  await store.openPath(normalizedCurrentDirectory.value)
}

async function copyCurrentDirectory() {
  await copyText(normalizedCurrentDirectory.value)
  store.showActivityMessage('已复制当前目录路径')
}

async function copyText(value: string) {
  if (!value) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function copySelected(mode: ClipboardMode = 'copy') {
  if (!selectedPaths.value.length) return
  localClipboard.value = { mode, paths: [...selectedPaths.value] }
  store.showActivityMessage(mode === 'copy' ? `已复制 ${selectedPaths.value.length} 项` : `已剪切 ${selectedPaths.value.length} 项`)
}

async function pasteLocalClipboard() {
  const clipboard = localClipboard.value
  if (!clipboard?.paths.length || !normalizedCurrentDirectory.value) return
  const results = clipboard.mode === 'copy'
    ? await backend.copyPathsToDirectory(clipboard.paths, normalizedCurrentDirectory.value)
    : await backend.movePathsToDirectory(clipboard.paths, normalizedCurrentDirectory.value)
  const okCount = results.filter((result) => result.ok).length
  if (clipboard.mode === 'cut') localClipboard.value = null
  await refreshAfterOperations([...clipboard.paths, normalizedCurrentDirectory.value])
  store.showActivityMessage(`${clipboard.mode === 'copy' ? '已粘贴' : '已移动'} ${okCount} 项`)
  const firstError = results.find((result) => !result.ok)?.error
  if (firstError) store.showErrorMessage(firstError)
}

async function importFiles() {
  if (!normalizedCurrentDirectory.value) return
  const files = await backend.selectFiles(normalizedCurrentDirectory.value)
  if (!files.length) return
  const results = await backend.copyPathsToDirectory(files, normalizedCurrentDirectory.value)
  await refreshAfterOperations([normalizedCurrentDirectory.value])
  store.showActivityMessage(`已导入 ${results.filter((result) => result.ok).length} 个文件`)
}

async function deleteSelected() {
  if (!selectedPaths.value.length) return
  const paths = [...selectedPaths.value]
  const names = selectedEntries.value.map((entry) => entry.name)
  const containsDirectory = selectedEntries.value.some((entry) => entry.type === 'directory')
  const previewNames = names.slice(0, 6).join('、')
  const overflow = names.length > 6 ? ` 等 ${names.length} 项` : ''
  const targetLabel = previewNames ? `${previewNames}${overflow}` : `${paths.length} 项`
  if (paths.length === 1 && !containsDirectory) {
    if (!window.confirm(`确定删除 ${targetLabel} 吗？这会直接从磁盘删除。`)) return
  } else {
    const answer = window.prompt(`将直接从磁盘删除：${targetLabel}\n请输入“删除”确认。`)
    if (answer !== '删除') return
  }
  let okCount = 0
  for (const path of paths) {
    try {
      await store.deletePath(path)
      okCount += 1
    } catch {
      // Store reports the failure.
    }
  }
  selectedPaths.value = []
  await refreshAfterOperations(paths)
  store.showActivityMessage(`已删除 ${okCount} 项`)
}

async function copySelectedToSystemClipboard() {
  if (!selectedPaths.value.length) return
  await backend.copyFilesToClipboard(selectedPaths.value)
  store.showActivityMessage(`已复制 ${selectedPaths.value.length} 项到系统剪贴板`)
}

async function replaceSelectedImageFromClipboard() {
  if (!canReplaceImageFromClipboard.value) return
  const entry = selectedEntries.value[0]
  await backend.replaceImageFromClipboard(entry.path)
  delete mediaDataUrls.value[entry.path]
  await loadMediaDataUrl(entry.path)
  await refreshAfterOperations([entry.path])
  store.showActivityMessage(`已用剪贴板图片替换：${entry.name}`)
}

async function refreshAfterOperations(paths: string[]) {
  const directories = new Set(paths.map((path) => parentDirectoryOf(path)))
  directories.add(normalizedCurrentDirectory.value)
  await Promise.all([...directories].filter(Boolean).map((path) => store.loadDirectory(path, true).catch(() => undefined)))
}

function onSearchInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  searchDraft.value = value
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void store.searchProject(value)
  }, 250)
}

function clearSearch() {
  searchDraft.value = ''
  void store.searchProject('')
}

async function loadMediaDataUrl(path: string) {
  if (!path || mediaDataUrls.value[path] || mediaLoadingPaths.has(path)) return
  mediaLoadingPaths.add(path)
  try {
    const dataUrl = await backend.readMediaAsDataUrl(path)
    mediaDataUrls.value = { ...mediaDataUrls.value, [path]: dataUrl }
  } catch {
    // Unsupported or oversized media simply falls back to the icon.
  } finally {
    mediaLoadingPaths.delete(path)
  }
}

async function preloadMediaDataUrls() {
  const targets = mediaEntries.value
    .filter((entry) => (entry.size ?? 0) <= 32 * 1024 * 1024)
    .slice(0, THUMBNAIL_LIMIT)
  await Promise.all(targets.map((entry) => loadMediaDataUrl(entry.path)))
}

async function showMediaPreview(entry: FileEntry) {
  stopMediaPan()
  const items = mediaEntries.value
  const index = Math.max(0, items.findIndex((item) => item.path === entry.path))
  mediaPreview.value = createMediaPreviewState({ open: true, items, index })
  await loadMediaDataUrl(entry.path)
}

async function shiftMediaPreview(delta: number) {
  stopMediaPan()
  const count = mediaPreview.value.items.length
  if (!count) return
  const index = (mediaPreview.value.index + delta + count) % count
  mediaPreview.value = createMediaPreviewState({ open: true, items: mediaPreview.value.items, index })
  const entry = mediaPreview.value.items[index]
  if (entry) await loadMediaDataUrl(entry.path)
}

function closeMediaPreview() {
  stopMediaPan()
  mediaPreview.value = createMediaPreviewState()
}

function setMediaZoom(zoom: number) {
  mediaPreview.value = { ...mediaPreview.value, zoom: clampMediaZoom(zoom) }
}

function clampMediaZoom(zoom: number): number {
  return Math.min(8, Math.max(0.25, Math.round(zoom * 1000) / 1000))
}

function onMediaStageWheel(event: WheelEvent) {
  if (!currentMedia.value || !currentMediaDataUrl.value) return
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
  setMediaZoom(mediaPreview.value.zoom * factor)
}

function beginMediaPan(event: PointerEvent) {
  if (!currentMedia.value || !currentMediaDataUrl.value) return
  if (!isImageEntry(currentMedia.value) || event.button !== 0) return
  event.preventDefault()
  stopMediaPan()
  mediaDrag.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: mediaPreview.value.panX,
    originY: mediaPreview.value.panY,
  }
  window.addEventListener('pointermove', onWindowMediaPointerMove)
  window.addEventListener('pointerup', onWindowMediaPointerUp)
  window.addEventListener('pointercancel', onWindowMediaPointerUp)
}

function onWindowMediaPointerMove(event: PointerEvent) {
  const drag = mediaDrag.value
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  mediaPreview.value = {
    ...mediaPreview.value,
    panX: drag.originX + (event.clientX - drag.startX),
    panY: drag.originY + (event.clientY - drag.startY),
  }
}

function onWindowMediaPointerUp(event: PointerEvent) {
  const drag = mediaDrag.value
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  stopMediaPan()
}

function stopMediaPan() {
  if (!mediaDrag.value) return
  window.removeEventListener('pointermove', onWindowMediaPointerMove)
  window.removeEventListener('pointerup', onWindowMediaPointerUp)
  window.removeEventListener('pointercancel', onWindowMediaPointerUp)
  mediaDrag.value = null
}

function onGridKeydown(event: KeyboardEvent) {
  if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    selectAllEntries()
  } else if (event.key === 'Escape') {
    if (mediaPreview.value.open) closeMediaPreview()
    else clearSelection()
  } else if (event.key === 'Delete') {
    void deleteSelected()
  }
}

watch(rootPath, (path) => {
  setTabsForRoot(path)
  if (path) void store.loadDirectory(path).catch(() => undefined)
}, { immediate: true })

watch(normalizedCurrentDirectory, (path) => {
  if (path) void store.loadDirectory(path).catch(() => undefined)
})

watch(listing, () => {
  selectedPaths.value = selectedPaths.value.filter((path) => listing.value.some((entry) => entry.path === path))
  void nextTick(() => { void preloadMediaDataUrls() })
}, { immediate: true })

onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer)
  stopMediaPan()
})
</script>

<template>
  <section class="file-manager-panel" aria-label="文件管理器" @keydown="onGridKeydown">
    <aside class="file-manager-tree-pane">
      <div class="file-manager-tab-strip">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="file-manager-tab"
          :class="{ active: tab.id === activeTabId }"
          :title="tab.path"
          @click="activateTab(tab)"
        >
          <span>{{ tab.name }}</span>
          <X v-if="tabs.length > 1" :size="12" @click.stop="closeTab(tab.id)" />
        </button>
        <button class="file-manager-tab add" type="button" title="选择目录" @click="chooseDirectory">
          <Plus :size="14" />
        </button>
      </div>
      <div class="file-manager-tree-root">
        <button class="file-manager-tree-row root" type="button" :title="activeTab?.path" @click="activeTab && navigateDirectory(activeTab.path)">
          <Folder :size="15" />
          <span>{{ activeTab?.name ?? '未打开目录' }}</span>
        </button>
        <FileManagerTreeNode
          v-for="entry in store.directoryCache[activeTab?.path ?? '']?.entries ?? []"
          :key="entry.path"
          :entry="entry"
          :depth="0"
          :directory-cache="store.directoryCache"
          :expanded-paths="expandedPaths"
          :selected-paths="selectedPaths"
          :active-directory="normalizedCurrentDirectory"
          @toggle-directory="toggleTreeDirectory"
          @open-entry="openTreeEntry"
        />
      </div>
    </aside>
    <main class="file-manager-browser-pane">
      <div class="file-manager-toolbar">
        <div class="file-manager-title">
          <strong>文件管理器</strong>
          <span :title="normalizedCurrentDirectory">{{ normalizedCurrentDirectory || '未打开项目' }}</span>
        </div>
        <div class="file-manager-actions">
          <button class="icon-button" type="button" title="选择目录" aria-label="选择目录" @click="chooseDirectory">
            <FolderPlus :size="14" />
          </button>
          <button class="icon-button" type="button" title="上一级" aria-label="上一级" :disabled="!canGoParent" @click="goParent">
            <ArrowUp :size="14" />
          </button>
          <button class="icon-button" type="button" title="刷新" aria-label="刷新" :disabled="!normalizedCurrentDirectory" @click="refreshCurrentDirectory">
            <RefreshCw :size="14" />
          </button>
          <button class="icon-button" type="button" title="导入文件到当前目录" aria-label="导入文件到当前目录" :disabled="!normalizedCurrentDirectory" @click="importFiles">
            <Upload :size="14" />
          </button>
          <button class="icon-button" type="button" title="复制选中项" aria-label="复制选中项" :disabled="!selectedPaths.length" @click="copySelected('copy')">
            <Copy :size="14" />
          </button>
          <button class="icon-button" type="button" title="剪切选中项" aria-label="剪切选中项" :disabled="!selectedPaths.length" @click="copySelected('cut')">
            <Scissors :size="14" />
          </button>
          <button class="icon-button" type="button" title="粘贴到当前目录" aria-label="粘贴到当前目录" :disabled="!canPaste" @click="pasteLocalClipboard">
            <ClipboardPaste :size="14" />
          </button>
          <button class="icon-button" type="button" title="复制到系统剪贴板" aria-label="复制到系统剪贴板" :disabled="!selectedPaths.length" @click="copySelectedToSystemClipboard">
            <Clipboard :size="14" />
          </button>
          <button class="icon-button" type="button" title="用剪贴板图片覆盖选中图片" aria-label="用剪贴板图片覆盖选中图片" :disabled="!canReplaceImageFromClipboard" @click="replaceSelectedImageFromClipboard">
            <ImageDown :size="14" />
          </button>
          <button class="icon-button danger" type="button" title="删除选中项" aria-label="删除选中项" :disabled="!selectedPaths.length" @click="deleteSelected">
            <Trash2 :size="14" />
          </button>
          <button class="icon-button" type="button" title="复制当前路径" aria-label="复制当前路径" :disabled="!normalizedCurrentDirectory" @click="copyCurrentDirectory">
            <ArrowLeftRight :size="14" />
          </button>
          <button class="icon-button" type="button" title="在系统资源管理器中显示" aria-label="在系统资源管理器中显示" :disabled="!normalizedCurrentDirectory" @click="revealCurrentDirectory">
            <FolderOpen :size="14" />
          </button>
        </div>
        <label class="file-manager-search">
          <Search :size="14" />
          <input :value="searchDraft" placeholder="搜索当前项目文件" @input="onSearchInput" />
          <button v-if="searchDraft" type="button" title="清空搜索" aria-label="清空搜索" @click="clearSearch">
            <X :size="13" />
          </button>
        </label>
      </div>
      <div class="file-manager-breadcrumbs" aria-label="当前路径">
        <button
          v-for="crumb in breadcrumbs"
          :key="crumb.path"
          type="button"
          :title="crumb.path"
          @click="navigateDirectory(crumb.path)"
        >
          {{ crumb.label }}
        </button>
        <span class="file-manager-selection">{{ selectedSummary }}</span>
      </div>
      <div class="file-manager-content">
        <section class="file-manager-grid-shell">
          <div v-if="showSearchResults" class="file-manager-search-results">
            <div class="file-manager-results-header">
              <span>{{ store.searchLoading ? '搜索中...' : `搜索结果：${store.searchResults?.files.length ?? 0}` }}</span>
            </div>
            <button
              v-for="result in store.searchResults?.files ?? []"
              :key="result.path"
              type="button"
              class="file-manager-result-row"
              :title="result.path"
              @click="openSearchResult(result)"
            >
              <FileText :size="15" />
              <span>{{ result.name }}</span>
              <small>{{ result.relativePath }}</small>
            </button>
            <div v-if="!store.searchLoading && !(store.searchResults?.files.length)" class="file-manager-empty">
              没有匹配文件
            </div>
          </div>
          <div v-else class="file-manager-grid" data-testid="file-manager-grid" tabindex="0">
            <button
              v-for="entry in listing"
              :key="entry.path"
              type="button"
              class="file-manager-entry"
              :class="[entryClass(entry), { active: activeFilePath === entry.path, selected: selectedPathSet.has(entry.path) }]"
              :title="entry.path"
              :data-testid="`file-manager-entry-${entry.name}`"
              @click="openEntry(entry, $event)"
            >
              <span
                class="file-manager-entry-check"
                :class="{ checked: selectedPathSet.has(entry.path) }"
                role="checkbox"
                :aria-checked="selectedPathSet.has(entry.path)"
                :aria-label="selectedPathSet.has(entry.path) ? '取消选择' : '选择'"
                @click.stop="toggleSelected(entry.path)"
              >
                <CheckSquare v-if="selectedPathSet.has(entry.path)" :size="13" />
                <Square v-else :size="13" />
              </span>
              <span class="file-manager-entry-icon">
                <img v-if="isImageEntry(entry) && mediaDataUrls[entry.path]" :src="mediaDataUrls[entry.path]" alt="" />
                <video v-else-if="isVideoEntry(entry) && mediaDataUrls[entry.path]" :src="mediaDataUrls[entry.path]" muted preload="metadata" />
                <component :is="entryIcon(entry)" v-else :size="28" />
              </span>
              <span class="file-manager-entry-name">{{ entry.name }}</span>
              <span class="file-manager-entry-meta">{{ entryMeta(entry) }}</span>
            </button>
            <div v-if="normalizedCurrentDirectory && !listing.length" class="file-manager-empty">
              当前目录为空
            </div>
            <div v-if="!normalizedCurrentDirectory" class="file-manager-empty">
              先打开一个项目
            </div>
          </div>
        </section>
        <section class="file-manager-preview-pane">
          <div class="file-manager-preview-header">
            <span>预览</span>
            <strong :title="activeFilePath">{{ activeFileName }}</strong>
          </div>
          <EditorPane />
        </section>
      </div>
    </main>
    <div v-if="mediaPreview.open && currentMedia" class="file-manager-media-backdrop" @click.self="closeMediaPreview">
      <div class="file-manager-media-viewer">
        <div class="file-manager-media-header">
          <strong :title="currentMedia.path">{{ currentMedia.name }}</strong>
          <span>{{ mediaPreview.index + 1 }} / {{ mediaPreview.items.length }}</span>
          <button type="button" @click="closeMediaPreview"><X :size="16" /></button>
        </div>
        <div class="file-manager-media-stage" @wheel="onMediaStageWheel">
          <button type="button" class="file-manager-media-arrow" @click="shiftMediaPreview(-1)">‹</button>
          <div class="file-manager-media-stage-body" :class="{ 'is-dragging': mediaDrag }" @pointerdown="beginMediaPan">
            <img
              v-if="isImageEntry(currentMedia) && currentMediaDataUrl"
              :src="currentMediaDataUrl"
              :alt="currentMedia.name"
              :style="currentMediaTransformStyle"
              draggable="false"
              @dragstart.prevent
            />
            <video
              v-else-if="isVideoEntry(currentMedia) && currentMediaDataUrl"
              :src="currentMediaDataUrl"
              controls
              autoplay
              :style="currentMediaTransformStyle"
            />
            <div v-else class="file-manager-media-loading">正在读取媒体...</div>
          </div>
          <button type="button" class="file-manager-media-arrow" @click="shiftMediaPreview(1)">›</button>
        </div>
        <div class="file-manager-media-footer">
          <button type="button" @click="setMediaZoom(1)">100%</button>
          <button type="button" @click="setMediaZoom(mediaPreview.zoom * 1.25)">放大</button>
          <button type="button" @click="setMediaZoom(mediaPreview.zoom / 1.25)">缩小</button>
        </div>
      </div>
    </div>
  </section>
</template>
