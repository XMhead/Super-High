<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import {
  AlignJustify,
  CaseSensitive,
  ChevronDown,
  Clipboard,
  Code2,
  Clock,
  Copy,
  ChevronRight,
  FileSearch,
  FileCode2,
  FileText,
  FolderOpen,
  FolderSearch,
  Indent,
  ListTree,
  Maximize2,
  Minus,
  Network,
  NotebookPen,
  PanelLeftRightDashed,
  Pencil,
  Redo2,
  Save,
  Scissors,
  Search,
  Settings,
  Terminal,
  Trash2,
  Undo2,
  Wrench,
  X,
  Zap,
} from 'lucide-vue-next'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { buildBreadcrumbs, fileNameFromPath, normalizePath } from '@/lib/path'
import { isTauri } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import BreadcrumbFileTreeNode from './BreadcrumbFileTreeNode.vue'
import type { FileEntry } from '@/types'

const store = useWorkspaceStore()
const activeTab = computed(() => store.activeTab)
const breadcrumbs = computed(() => buildBreadcrumbs(activeTab.value?.path ?? store.workspace?.rootPath ?? ''))
const workspaceTabs = computed(() => store.workspaceTabs)
const docsWorkspace = computed(() => store.activeDocWorkspace)
const docsButtonTitle = computed(() => {
  const docs = docsWorkspace.value
  if (!store.workspace) return '先打开工作区'
  if (!docs) return '文档预览'
  if (docs.status === 'starting') return '正在启动文档预览…'
  if (docs.status === 'running') return docs.url || '文档预览已打开'
  if (docs.status === 'detected') return docs.running ? '文档预览已运行' : '已检测到文档'
  if (docs.status === 'missing') return '未检测到文档目录'
  if (docs.status === 'error') return docs.error || '文档预览不可用'
  return '文档预览'
})
const projectLayoutTitle = computed(() => (
  store.settings.projectLayoutMode === 'swapped' ? '恢复默认布局' : '切换左右布局'
))
const activeMenu = ref<TitleMenu | null>(null)
const menuRoot = ref<HTMLElement | null>(null)
const breadcrumbRoot = ref<HTMLElement | null>(null)
const breadcrumbDropdownPath = ref<string | null>(null)
const breadcrumbDropdownLoading = ref(false)
const breadcrumbContextMenu = ref<{ path: string; x: number; y: number } | null>(null)
const searchRoot = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const selectedSearchIndex = ref(0)
let searchTimer: number | null = null
let editorDispatchTimer: number | null = null

type TitleMenu = 'file' | 'edit' | 'search'
type EditorMenuCommand =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'selectAll'
  | 'uppercase'
  | 'lowercase'
  | 'indent'
  | 'outdent'
  | 'toggleComment'
type EditorActionCommand = 'find' | 'replace' | 'gotoLine' | 'symbols'

interface ParsedNavigationQuery {
  raw: string
  fileQuery: string
  lineNumber: number | null
  column: number | null
}

interface SymbolSearchMatch {
  symbol: string
  lineNumber: number
  column: number
  text: string
}

interface SearchItem {
  key: string
  kind: 'file' | 'text' | 'symbol' | 'tab'
  label: string
  detail: string
  path?: string
  lineNumber?: number
  column?: number
  icon: Component
  kindLabel: string
}

const hasActiveTextTab = computed(() => !!activeTab.value && activeTab.value.contentType === 'text')
const parsedSearchQuery = computed(() => parseNavigationQuery(store.searchQuery))
const isSymbolMode = computed(() => store.searchQuery.trim().startsWith('@'))
const symbolQuery = computed(() => store.searchQuery.trim().slice(1).trim().toLowerCase())
const symbolMatches = computed(() => {
  if (!isSymbolMode.value || !activeTab.value || activeTab.value.contentType !== 'text') return []
  const matches = extractEditorSymbols(activeTab.value.content)
  if (!symbolQuery.value) return matches.slice(0, 40)
  return matches.filter((item) => item.symbol.toLowerCase().includes(symbolQuery.value)).slice(0, 40)
})

const searchItems = computed<SearchItem[]>(() => {
  if (isSymbolMode.value) {
    return symbolMatches.value.map((match) => ({
      key: `symbol:${match.lineNumber}:${match.column}:${match.symbol}`,
      kind: 'symbol',
      label: `${match.symbol}:${match.lineNumber}`,
      detail: match.text,
      path: activeTab.value?.path,
      lineNumber: match.lineNumber,
      column: match.column,
      icon: ListTree,
      kindLabel: '符号',
    }))
  }

  const query = store.searchQuery.trim()
  if (!query) {
    return store.tabs.slice().reverse().map((tab) => ({
      key: `tab:${tab.path}`,
      kind: 'tab',
      label: tab.name || fileNameFromPath(tab.path),
      detail: displayPathInWorkspace(tab.path),
      path: tab.path,
      icon: Clock,
      kindLabel: '已打开',
    }))
  }

  const results = store.searchResults
  if (!results) return []
  const lineNumber = parsedSearchQuery.value.lineNumber ?? undefined
  const column = parsedSearchQuery.value.column ?? undefined
  return [
    ...results.files.map((file) => ({
      key: `file:${file.path}`,
      kind: 'file' as const,
      label: file.name,
      detail: file.relativePath,
      path: file.path,
      lineNumber,
      column,
      icon: FileText,
      kindLabel: '文件',
    })),
    ...results.textMatches.map((match) => ({
      key: `text:${match.path}:${match.lineNumber}:${match.column}`,
      kind: 'text' as const,
      label: `${match.relativePath}:${match.lineNumber}:${match.column}`,
      detail: match.preview,
      path: match.path,
      lineNumber: match.lineNumber,
      column: match.column,
      icon: Search,
      kindLabel: '正文',
    })),
  ]
})
const breadcrumbDropdownEntries = computed(() => {
  const path = breadcrumbDropdownPath.value
  if (!path) return []
  return sortEntries(store.directoryCache[path]?.entries ?? [])
})

watch([() => store.searchQuery, () => searchItems.value.length], () => {
  selectedSearchIndex.value = 0
})

function parseNavigationQuery(query: string): ParsedNavigationQuery {
  const raw = query.trim()
  const match = raw.match(/^(.*?)(?::(\d+))(?::(\d+))?$/)
  if (!match) {
    return {
      raw,
      fileQuery: raw,
      lineNumber: null,
      column: null,
    }
  }

  return {
    raw,
    fileQuery: match[1].trim(),
    lineNumber: Math.max(1, Number(match[2]) || 1),
    column: Math.max(1, Number(match[3]) || 1),
  }
}

function extractEditorSymbols(content: string): SymbolSearchMatch[] {
  const lines = content.split(/\r?\n/)
  const symbols: SymbolSearchMatch[] = []
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/,
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/,
    /(?:export\s+)?class\s+([A-Za-z_]\w*)\b/,
    /(?:export\s+)?interface\s+([A-Za-z_]\w*)\b/,
    /(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=/,
  ]

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (!match) continue
      symbols.push({
        symbol: match[1],
        lineNumber: index + 1,
        column: Math.max(1, line.indexOf(match[1]) + 1),
        text: line.trim().slice(0, 160),
      })
      break
    }
  }

  return symbols
}

function onSearchInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  store.searchQuery = value
  store.searchOpen = true
  if (searchTimer) window.clearTimeout(searchTimer)
  if (isSymbolMode.value) {
    store.searchResults = null
    store.searchLoading = false
    return
  }
  const backendQuery = parsedSearchQuery.value.fileQuery || value.trim()
  if (!backendQuery) {
    store.searchResults = null
    store.searchLoading = false
    return
  }
  searchTimer = window.setTimeout(() => {
    void store.searchProject(backendQuery, value, { fileNameOnly: true })
  }, 250)
}

// 搜索结果只展示项目内相对路径，避免把本机绝对路径暴露在顶部浮层里。
function displayPathInWorkspace(path: string): string {
  const normalizedPath = normalizePath(path).replace(/\/+$/, '')
  const normalizedRoot = normalizePath(store.workspace?.rootPath ?? '').replace(/\/+$/, '')
  if (!normalizedRoot) return fileNameFromPath(path)

  const pathKey = normalizedPath.toLowerCase()
  const rootKey = normalizedRoot.toLowerCase()
  const rootPrefix = `${normalizedRoot}/`
  if (pathKey === rootKey) return fileNameFromPath(path)
  if (!pathKey.startsWith(rootPrefix.toLowerCase())) return fileNameFromPath(path)

  return normalizedPath.slice(rootPrefix.length) || fileNameFromPath(path)
}

function toggleMenu(menu: TitleMenu) {
  activeMenu.value = activeMenu.value === menu ? null : menu
}

function closeMenu() {
  activeMenu.value = null
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

async function toggleBreadcrumbDropdown(path: string) {
  if (isActiveFileBreadcrumb(path)) {
    closeBreadcrumbDropdown()
    await store.openBreadcrumbTarget(path)
    return
  }
  if (breadcrumbDropdownPath.value === path) {
    closeBreadcrumbDropdown()
    return
  }
  breadcrumbDropdownPath.value = path
  breadcrumbDropdownLoading.value = true
  try {
    await store.loadDirectory(path, true)
  } catch {
    // Store already reports directory read errors.
  } finally {
    if (breadcrumbDropdownPath.value === path) breadcrumbDropdownLoading.value = false
  }
}

function closeBreadcrumbDropdown() {
  breadcrumbDropdownPath.value = null
  breadcrumbDropdownLoading.value = false
  breadcrumbContextMenu.value = null
}

function openBreadcrumbContextMenu(path: string, event: MouseEvent) {
  const menuWidth = 238
  const menuHeight = 36
  const margin = 8
  breadcrumbContextMenu.value = {
    path,
    x: Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin)),
  }
}

async function revealBreadcrumbTarget() {
  const path = breadcrumbContextMenu.value?.path
  breadcrumbContextMenu.value = null
  if (path) await store.openPath(path)
}

function isActiveFileBreadcrumb(path: string): boolean {
  const tab = activeTab.value
  if (!tab) return false
  const current = normalizePath(tab.path).replace(/\/+$/, '').toLowerCase()
  const candidate = normalizePath(path).replace(/\/+$/, '').toLowerCase()
  return current === candidate
}

function onWindowMouseDown(event: MouseEvent) {
  const target = event.target as Node
  if (!menuRoot.value?.contains(target)) closeMenu()
  if (breadcrumbDropdownPath.value && !breadcrumbRoot.value?.contains(target)) closeBreadcrumbDropdown()
  if (breadcrumbContextMenu.value && !(target as Element).closest?.('.breadcrumb-context-menu')) {
    breadcrumbContextMenu.value = null
  }
  if (store.searchOpen && !searchRoot.value?.contains(target)) closeSearch()
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && breadcrumbContextMenu.value) {
    breadcrumbContextMenu.value = null
    return
  }
  if (event.key === 'Escape' && activeMenu.value) {
    closeMenu()
    return
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault()
    closeMenu()
    void store.saveActiveTab()
    return
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    focusSearch('', false)
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    const selection = window.getSelection()?.toString().trim().split('\n')[0]?.slice(0, 100) ?? ''
    focusSearch(selection, !!selection)
  }
}

function openWorkspace() {
  closeMenu()
  void store.openProject()
}

function openRecentWorkspace(path: string) {
  closeMenu()
  void store.openProject(path)
}

function openSettings() {
  closeMenu()
  store.setSettingsOpen(true)
}

function activateWorkspace(rootPath: string) {
  void store.activateProjectWorkspace(rootPath)
}

function activateDocsWorkspace(rootPath: string) {
  void store.activateDocsWorkspaceTab(rootPath)
}

function closeWorkspaceTab(kind: 'project' | 'docs', rootPath: string) {
  if (kind === 'docs') {
    void store.closeDocsWorkspaceTab(rootPath)
    return
  }
  void store.closeWorkspaceTab(rootPath)
}

function prepareEditorDispatch(delayWhenMounting = 80): number {
  const needsMount = store.settings.activePreviewMode !== 'code'
  if (needsMount) store.setPreviewMode('code')
  return needsMount ? delayWhenMounting : 0
}

function dispatchEditorEvent(name: string, detail: Record<string, unknown>) {
  closeMenu()
  if (editorDispatchTimer) window.clearTimeout(editorDispatchTimer)
  const delay = prepareEditorDispatch()
  editorDispatchTimer = window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  }, delay)
}

function runEditorMenuCommand(command: EditorMenuCommand) {
  dispatchEditorEvent('superhigh:editor-menu-command', { command })
}

function runEditorAction(action: EditorActionCommand) {
  dispatchEditorEvent('superhigh:editor-action', { action })
}

function requestCloseCurrentTab() {
  closeMenu()
  if (!activeTab.value) return
  if (!activeTab.value.isDirty) {
    store.closeTab(activeTab.value.id)
    return
  }
  dispatchEditorEvent('superhigh:editor-close-current', {})
}

function saveActiveTab() {
  closeMenu()
  void store.saveActiveTab()
}

async function minimizeWindow() {
  if (!isTauri()) return
  try {
    await getCurrentWindow().minimize()
  } catch (error) {
    store.showErrorMessage(`最小化窗口失败：${formatError(error)}`)
  }
}

async function toggleMaximizeWindow() {
  if (!isTauri()) return
  try {
    await getCurrentWindow().toggleMaximize()
  } catch (error) {
    store.showErrorMessage(`切换窗口大小失败：${formatError(error)}`)
  }
}

function requestAppClose() {
  window.dispatchEvent(new CustomEvent('superhigh:request-app-close'))
}

function openDocsPreview() {
  closeMenu()
  void store.ensureVitePressDocs()
}

function showCodePreview() {
  if (store.codePreviewProjectEditorOpen) store.closeCodePreviewProjectEditor()
  store.setWorkspaceSurface('project')
  store.setPreviewMode('code')
  store.restoreProjectEditorEntryTab()
}

function showProjectEditor() {
  store.setWorkspaceSurface('editor')
}

function showMemoWindow() {
  store.toggleMemoWindow()
}

function showScriptTools() {
  store.toggleScriptTools()
}

function showLocalTerminalPreview() {
  store.setWorkspaceSurface('project')
  store.setPreviewMode('local_terminal')
}

function focusSearch(value?: string, selectText = true) {
  closeMenu()
  if (typeof value === 'string') {
    store.searchQuery = value
    store.searchResults = null
    store.searchLoading = false
  }
  store.searchOpen = true
  void nextTick(() => {
    searchInput.value?.focus()
    if (selectText) searchInput.value?.select()
  })
}

function clearSearch() {
  store.searchQuery = ''
  store.searchResults = null
  store.searchLoading = false
  store.searchOpen = true
  selectedSearchIndex.value = 0
  void nextTick(() => searchInput.value?.focus())
}

function closeSearch() {
  store.searchOpen = false
}

async function openSearchItem(item: SearchItem) {
  if (!item.path) return
  const lineNumber = item.lineNumber
  const column = item.column ?? 1
  const targetPath = item.path
  if (store.settings.activePreviewMode !== 'code') store.setPreviewMode('code')
  await store.openFile(targetPath)
  store.searchOpen = false
  store.searchQuery = ''

  if (lineNumber) {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('superhigh:reveal-editor-position', {
        detail: { path: targetPath, lineNumber, column },
      }))
    }, 100)
  }
}

function activateSearchItem(item: SearchItem | undefined) {
  if (!item) return
  void openSearchItem(item)
}

function onSearchKeydown(event: KeyboardEvent) {
  const count = searchItems.value.length
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedSearchIndex.value = count ? Math.min(selectedSearchIndex.value + 1, count - 1) : 0
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedSearchIndex.value = Math.max(selectedSearchIndex.value - 1, 0)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    activateSearchItem(searchItems.value[selectedSearchIndex.value] ?? searchItems.value[0])
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
    searchInput.value?.blur()
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

onMounted(() => {
  window.addEventListener('mousedown', onWindowMouseDown)
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer)
  if (editorDispatchTimer) window.clearTimeout(editorDispatchTimer)
  window.removeEventListener('mousedown', onWindowMouseDown)
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <header class="app-top">
    <div class="app-menu-row" data-tauri-drag-region>
      <div class="app-brand">
        <Zap class="brand-mark" :size="15" :stroke-width="2.5" />
        <span>Super High</span>
      </div>
      <div ref="menuRoot" class="top-menu-groups">
        <div class="top-menu-group">
          <button
            class="menu-button"
            :class="{ active: activeMenu === 'file' }"
            type="button"
            @click="toggleMenu('file')"
          >
            <span>文件</span>
            <ChevronDown :size="12" />
          </button>
          <div v-if="activeMenu === 'file'" class="menu-dropdown file-menu-dropdown">
            <div class="menu-submenu-group">
              <button class="menu-item" type="button" aria-haspopup="menu" @click="openWorkspace">
                <FolderOpen :size="14" />
                <span>打开工作区...</span>
                <ChevronRight :size="13" />
              </button>
              <div class="workspace-history-submenu" role="menu">
                <button
                  v-for="project in store.visibleRecentProjects"
                  :key="project.path"
                  class="workspace-history-item"
                  type="button"
                  :title="project.path"
                  @click="openRecentWorkspace(project.path)"
                >
                  <span class="workspace-history-name">{{ store.recentProjectTitle(project) }}</span>
                  <span class="workspace-history-path">{{ project.path }}</span>
                </button>
                <div v-if="!store.visibleRecentProjects.length" class="workspace-history-empty">暂无历史工作区</div>
              </div>
            </div>
            <button class="menu-item" type="button" @click="openSettings">
              <Settings :size="14" />
              <span>打开设置</span>
            </button>
            <div class="menu-separator" />
            <button
              class="menu-item"
              type="button"
              :disabled="!activeTab || activeTab.contentType !== 'text' || !activeTab.isDirty"
              @click="saveActiveTab"
            >
              <Save :size="14" />
              <span>保存当前文件</span>
              <span class="shortcut-label">Ctrl+S</span>
            </button>
            <button class="menu-item" type="button" :disabled="!activeTab" @click="requestCloseCurrentTab">
              <X :size="14" />
              <span>关闭当前标签</span>
            </button>
          </div>
        </div>

        <div class="top-menu-group">
          <button
            class="menu-button"
            :class="{ active: activeMenu === 'edit' }"
            type="button"
            @click="toggleMenu('edit')"
          >
            <span>编辑</span>
            <ChevronDown :size="12" />
          </button>
          <div v-if="activeMenu === 'edit'" class="menu-dropdown wide">
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('undo')">
              <Undo2 :size="14" />
              <span>撤销</span>
              <span class="shortcut-label">Ctrl+Z</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('redo')">
              <Redo2 :size="14" />
              <span>重做</span>
              <span class="shortcut-label">Ctrl+Y</span>
            </button>
            <div class="menu-separator" />
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('cut')">
              <Scissors :size="14" />
              <span>剪切</span>
              <span class="shortcut-label">Ctrl+X</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('copy')">
              <Copy :size="14" />
              <span>复制</span>
              <span class="shortcut-label">Ctrl+C</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('paste')">
              <Clipboard :size="14" />
              <span>粘贴</span>
              <span class="shortcut-label">Ctrl+V</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('delete')">
              <Trash2 :size="14" />
              <span>删除</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('selectAll')">
              <AlignJustify :size="14" />
              <span>全选</span>
              <span class="shortcut-label">Ctrl+A</span>
            </button>
            <div class="menu-separator" />
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('uppercase')">
              <CaseSensitive :size="14" />
              <span>转为大写</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('lowercase')">
              <CaseSensitive :size="14" />
              <span>转为小写</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('indent')">
              <Indent :size="14" />
              <span>增加缩进</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('outdent')">
              <Indent class="rotate-icon" :size="14" />
              <span>减少缩进</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorMenuCommand('toggleComment')">
              <Pencil :size="14" />
              <span>切换行注释</span>
              <span class="shortcut-label">Ctrl+/</span>
            </button>
          </div>
        </div>

        <div class="top-menu-group">
          <button
            class="menu-button"
            :class="{ active: activeMenu === 'search' }"
            type="button"
            @click="toggleMenu('search')"
          >
            <span>搜索</span>
            <ChevronDown :size="12" />
          </button>
          <div v-if="activeMenu === 'search'" class="menu-dropdown wide">
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorAction('find')">
              <Search :size="14" />
              <span>查找...</span>
              <span class="shortcut-label">Ctrl+F</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorAction('replace')">
              <FileSearch :size="14" />
              <span>替换...</span>
              <span class="shortcut-label">Ctrl+H</span>
            </button>
            <button class="menu-item" type="button" @click="focusSearch('', false)">
              <FileSearch :size="14" />
              <span>文件查找...</span>
              <span class="shortcut-label">Ctrl+Shift+F</span>
            </button>
            <div class="menu-separator" />
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="runEditorAction('gotoLine')">
              <ListTree :size="14" />
              <span>转到行...</span>
              <span class="shortcut-label">Ctrl+G</span>
            </button>
            <button class="menu-item" type="button" :disabled="!hasActiveTextTab" @click="focusSearch('@', false)">
              <FileText :size="14" />
              <span>转到符号...</span>
              <span class="shortcut-label">Ctrl+Shift+O</span>
            </button>
          </div>
        </div>
      </div>
      <div class="workspace-tabs">
        <button class="workspace-tab workspace-tab-settings" :class="{ active: store.settingsOpen }" @click="store.setSettingsOpen(true)">设置</button>
        <div
          v-for="workspaceTab in workspaceTabs"
          :key="workspaceTab.id"
          class="workspace-tab workspace-tab-item"
          :class="{ active: workspaceTab.active }"
        >
          <button
            class="workspace-tab-button"
            :title="workspaceTab.title"
            @click="workspaceTab.kind === 'docs' ? activateDocsWorkspace(workspaceTab.rootPath) : activateWorkspace(workspaceTab.rootPath)"
          >
            <span>{{ workspaceTab.label }}</span>
          </button>
          <button class="workspace-tab-close" title="关闭工作区标签" @click.stop="closeWorkspaceTab(workspaceTab.kind, workspaceTab.rootPath)">
            <X :size="12" />
          </button>
        </div>
      </div>
      <div class="window-controls">
        <button
          class="window-control-button layout-toggle-button"
          :class="{ active: store.settings.projectLayoutMode === 'swapped' }"
          type="button"
          :title="projectLayoutTitle"
          :aria-label="projectLayoutTitle"
          @click="store.toggleProjectLayoutMode()"
        >
          <PanelLeftRightDashed :size="13" />
        </button>
        <button class="window-control-button" type="button" title="最小化" aria-label="最小化" @click="minimizeWindow">
          <Minus :size="13" />
        </button>
        <button class="window-control-button" type="button" title="最大化" aria-label="最大化" @click="toggleMaximizeWindow">
          <Maximize2 :size="12" />
        </button>
        <button class="window-control-button close" type="button" title="关闭" aria-label="关闭" @click="requestAppClose">
          <X :size="14" />
        </button>
      </div>
    </div>

    <div class="app-command-row">
      <div ref="breadcrumbRoot" class="breadcrumb-strip compact app-breadcrumb-strip">
        <button
          v-for="crumb in breadcrumbs"
          :key="crumb.path"
          class="breadcrumb-button"
          :class="{ active: breadcrumbDropdownPath === crumb.path }"
          @click.stop="toggleBreadcrumbDropdown(crumb.path)"
        >
          {{ crumb.label }}
        </button>
        <div v-if="breadcrumbDropdownPath" class="app-breadcrumb-dropdown" @click.stop>
          <div v-if="breadcrumbDropdownLoading" class="breadcrumb-dropdown-empty">加载中...</div>
          <template v-else>
            <BreadcrumbFileTreeNode
              v-for="entry in breadcrumbDropdownEntries"
              :key="entry.path"
              :entry="entry"
              :depth="0"
              @file-open="closeBreadcrumbDropdown"
              @context-menu="openBreadcrumbContextMenu"
            />
            <div v-if="!breadcrumbDropdownEntries.length" class="breadcrumb-dropdown-empty">目录为空</div>
          </template>
          <div
            v-if="breadcrumbContextMenu"
            class="file-context-menu breadcrumb-context-menu"
            :style="{ left: `${breadcrumbContextMenu.x}px`, top: `${breadcrumbContextMenu.y}px` }"
            role="menu"
            @click.stop
            @contextmenu.prevent
          >
            <button type="button" class="file-context-item" @click="revealBreadcrumbTarget">
              <span class="context-icon"><FolderSearch :size="14" /></span>
              <span>在文件资源管理器中显示</span>
            </button>
          </div>
        </div>
      </div>

      <div ref="searchRoot" class="search-slot command-search">
        <Search class="search-field-icon" :size="14" />
        <input
          ref="searchInput"
          class="nav-search"
          :value="store.searchQuery"
          placeholder="按文件名搜索(追加 : 转到行，输入 @ 转到符号)"
          @input="onSearchInput"
          @focus="store.searchOpen = true"
          @keydown="onSearchKeydown"
        />
        <button
          v-if="store.searchQuery"
          class="search-clear-button"
          type="button"
          title="清空"
          @click="clearSearch"
        >
          <X :size="13" />
        </button>
        <div v-if="store.searchOpen" class="search-dropdown command-dropdown">
          <div v-if="store.searchLoading" class="search-empty">正在搜索...</div>
          <div v-else-if="isSymbolMode && !activeTab" class="search-empty">先打开一个文本文件，再搜索符号。</div>
          <template v-else>
            <button
              v-for="(item, index) in searchItems"
              :key="item.key"
              class="search-result-row"
              :class="{ active: index === selectedSearchIndex, text: item.kind === 'text' }"
              @mouseenter="selectedSearchIndex = index"
              @mousedown.prevent
              @click="activateSearchItem(item)"
            >
              <component :is="item.icon" class="search-result-icon" :size="14" />
              <span class="search-result-main">
                <span>{{ item.label }}</span>
                <span>{{ item.detail }}</span>
              </span>
              <span class="search-result-kind">{{ item.kindLabel }}</span>
            </button>
            <div
              v-if="!searchItems.length"
              class="search-empty"
            >
              {{ store.searchQuery.trim() ? '没有匹配结果' : '输入文件名开始搜索' }}
            </div>
          </template>
        </div>
      </div>

      <div class="preview-mode-strip">
        <button
          class="mode-button"
          :class="{ active: store.activeWorkspaceSurface === 'editor' }"
          type="button"
          title="项目编辑器预览"
          :disabled="!store.workspace"
          @click="showProjectEditor"
        >
          <FileCode2 class="mode-button-icon" :size="14" />
          <span>编辑器预览</span>
        </button>
        <button
          class="mode-button"
          :class="{ active: store.memoWindowOpen }"
          type="button"
          title="备忘录"
          :disabled="!store.workspace"
          @click="showMemoWindow"
        >
          <NotebookPen class="mode-button-icon" :size="14" />
          <span>备忘录</span>
        </button>
        <button
          class="mode-button"
          :class="{ active: store.scriptToolsOpen }"
          type="button"
          title="工作区脚本工具"
          :disabled="!store.workspace"
          @click="showScriptTools"
        >
          <Wrench class="mode-button-icon" :size="14" />
          <span>脚本工具</span>
        </button>
        <button
          class="mode-button"
          :class="{ active: store.activeWorkspaceSurface === 'docs' }"
          type="button"
          :title="docsButtonTitle"
          :disabled="!store.workspace || docsWorkspace?.status === 'starting'"
          @click="openDocsPreview"
        >
          <Network class="mode-button-icon" :size="14" />
          <span>文档预览</span>
        </button>
        <button
          class="mode-button"
          :class="{ active: store.activeWorkspaceSurface === 'project' && store.settings.activePreviewMode === 'code' }"
          type="button"
          title="代码预览"
          @click="showCodePreview"
        >
          <Code2 class="mode-button-icon" :size="14" />
          <span>代码预览</span>
        </button>
        <button
          class="mode-button"
          :class="{ active: store.activeWorkspaceSurface === 'project' && store.settings.activePreviewMode === 'local_terminal' }"
          type="button"
          title="本地终端"
          @click="showLocalTerminalPreview"
        >
          <Terminal class="mode-button-icon" :size="14" />
          <span>本地终端</span>
        </button>
        <button
          class="mode-button"
          :class="{ active: store.markdownPreviewEnabled }"
          type="button"
          title="Markdown 渲染模式"
          @click="store.toggleMarkdownPreview()"
        >
          <FileText class="mode-button-icon" :size="12" />
          <span>Markdown</span>
        </button>
      </div>
    </div>
  </header>
</template>
