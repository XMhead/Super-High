<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { loadMonaco, getMonaco, MONACO_UNICODE_HIGHLIGHT, type Monaco } from '@/lib/monaco'
import type * as MonacoTypes from 'monaco-editor'
import { AlertTriangle, ChevronDown, Copy, Ellipsis, FileCode2, FolderSearch, GripHorizontal, List, MessageSquarePlus, Save, SaveAll, Search, X } from 'lucide-vue-next'

import { buildColorCodePreviewRanges, colorCodePreviewClassName, colorCodePreviewStyleRule } from '@/lib/colorCodePreview'
import { applyEditorContentChanges, createVersionCache, createTrailingTask } from '@/lib/editorInputAnalysis'
import { createYamlSyntaxAnalysis } from '@/lib/yamlSyntaxAnalysis'
import { buildExternalLinkBridgeScript } from '@/lib/externalLinks'
import { buildHtmlPreviewLongPressScript, isHtmlPreviewLongPressMessage, sendHtmlPreviewPathToChat } from '@/lib/htmlPreviewLongPress'
import { buildHtmlPreviewResourceBridge, inlineHtmlPreviewAssets, HTML_PREVIEW_DOWNLOAD_MESSAGE, HTML_PREVIEW_RESOURCE_ERROR_MESSAGE, HTML_PREVIEW_RESOURCE_MESSAGE, HTML_PREVIEW_RESOURCE_RESULT_MESSAGE, resolveHtmlPreviewResourcePath, saveHtmlPreviewDownload } from '@/lib/htmlPreviewResources'
import { findPluginPreviewProvider, type PluginPreviewInstance, type PluginPreviewProvider } from '@/lib/pluginPreviewProviders'
import { isSuperhighUiPath } from '@/lib/superhighUi'
import { prepareHtmlPreviewScripts } from '@/lib/htmlPreviewScripts'
import { persistHtmlPreviewStorage } from '@/lib/htmlPreviewStorage'
import { HTML_PREVIEW_OPEN_FILE_MESSAGE } from '@/lib/externalLinks'
import { scanMarkdownHeadings, type MarkdownHeadingSpan } from '@/lib/markdown'
import { linkWorkspacePaths, renderWorkspaceMarkdown } from '@/lib/workspacePathLinks'
import { buildWorkspaceBreadcrumbs, extensionFromPath, inferLanguage, isPresentationDocument, normalizePath } from '@/lib/path'
import { formatCodePreviewSelectionSourceForRange } from '@/lib/selectionChat'
import { registerEditorTabCompletion } from '@/lib/tabCompletion'
import { memoTitleColor } from '@/lib/theme'
import { applyEditorTheme, EDITOR_THEME_ID } from '@/lib/editorTheme'
import { scrollSpeedMultiplier } from '@/lib/scrollSpeed'
import { fileIconComponents, fileIconTone } from '@/lib/fileIcons'
import {
  buildYamlKeyIndex,
  findYamlKeyValueLine,
  nextKeyOccurrence,
  scanYamlTopLevelKeys,
  type YamlKeySpan,
  type YamlSyntaxIssue,
} from '@/lib/yamlPreview'
import type { EditorTab, FileEntry } from '@/types'
import BreadcrumbFileTreeNode from './BreadcrumbFileTreeNode.vue'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'
import SuperhighUiPreview from './SuperhighUiPreview.vue'
import { registerMobileHtmlPreview, replyMobileHtml } from '@/lib/mobileHtmlBridge'
import { appDataDirectory, isEditorPagePath } from '@/lib/editorCatalog'
import OfficePreview from './OfficePreview.vue'
import MarkdownFilePreview from './MarkdownFilePreview.vue'
import EditorMediaPreview from './EditorMediaPreview.vue'
import FileOpenActions from './FileOpenActions.vue'
import EditorFileTab from './EditorFileTab.vue'
import EditorFindDialog from './EditorFindDialog.vue'
const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'))
const GitDiffViewer = defineAsyncComponent(() => import('./GitDiffViewer.vue'))
const PresentationPreview = defineAsyncComponent(() => import('./PresentationPreview.vue'))

import { useWorkspaceStore } from '@/stores/workspace'
import { backend } from '@/lib/tauri'

const props = defineProps<{
  onBreadcrumbFileOpen?: (path: string) => void | Promise<void>
}>()

const store = useWorkspaceStore()
const editorHost = ref<HTMLDivElement | null>(null)
const tabsList = ref<HTMLElement | null>(null)
const selectedText = ref('')
const imageZoom = ref(1)
const imageNaturalSize = ref<{ width: number; height: number } | null>(null)
const imagePreviewStage = ref<HTMLDivElement | null>(null)
const htmlPreviewFrame = ref<HTMLIFrameElement | null>(null)
const markdownPreview = ref<InstanceType<typeof MarkdownFilePreview> | null>(null)
const pluginPreviewHost = ref<HTMLDivElement | null>(null)
let pluginPreview: { provider: PluginPreviewProvider; path: string; host: HTMLElement; instance: PluginPreviewInstance | null } | null = null
const imagePreviewDragging = ref(false)
const saveDialogTab = ref<EditorTab | null>(null)
const tabsActionMenuOpen = ref(false)
const tabsListMenuOpen = ref(false)
const tabsListButton = ref<HTMLElement | null>(null)
const tabsListMenuEl = ref<HTMLElement | null>(null)
const tabsListMenuStyle = ref<CSSProperties>({})
const hoveredTabId = ref<string | null>(null)
const editorPanel = ref<HTMLElement | null>(null)
const findDialogOpen = ref(false)
const findDialogMode = ref<FindDialogMode>('find')
const findDialog = ref<InstanceType<typeof EditorFindDialog> | null>(null)
let tabsMenuLayoutObserver: ResizeObserver | null = null
const tabsActionMenuRoot = ref<HTMLElement | null>(null)
const mdConfigRoot = ref<HTMLElement | null>(null)
const mdConfigMenuOpen = ref(false)
const encodingControlRoot = ref<HTMLElement | null>(null)
const encodingMenuOpen = ref(false)
const encodingMenuMode = ref<'reopen' | 'save'>('reopen')
const tabContextMenu = ref<{ tab: EditorTab; x: number; y: number } | null>(null)
const dragOverTabIndex = ref<number | null>(null)
const yamlSyntaxIssues = ref<YamlSyntaxIssue[]>([])
const yamlTopLevelPanelOffset = ref({ x: 0, y: 0 })
let editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null
let syncing = false
// Keep save content synchronous; defer only derived analysis.
let syncedEditorContent = ''
const analysisCache = createVersionCache<MonacoTypes.editor.ITextModel>()
const yamlSyntaxAnalysis = createYamlSyntaxAnalysis()
let yamlAnalysisTarget: { model: MonacoTypes.editor.ITextModel; version: number; tabId: string } | null = null
const editorAnalysisTask = createTrailingTask(() => updateEditorDecorations(), 160)
const editorViewportTask = createTrailingTask(() => updateVisibleEditorDecorations(), 0)
const panelContent = ref<{ tabId: string; content: string } | null>(null)
const panelEntriesCache = new Map<string, { content: string; language: string; entries: KeyValuePanelEntry[] }>()
let lastSyncedTabId: string | null = null
let saveDialogResolve: ((choice: SaveCloseChoice) => void) | null = null
let revealTimer: number | null = null
let yamlTopLevelPanelDrag: { startX: number; startY: number; originX: number; originY: number; moved: boolean } | null = null
let imagePreviewDrag: { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null = null
const viewStateCache = new Map<string, MonacoTypes.editor.ICodeEditorViewState>()
// Models belong to this pane, independently of the transient editor/preview surface.
const modelNamespace = crypto.randomUUID()
const fileModels = new Map<string, { path: string; model: MonacoTypes.editor.ITextModel; sourceContent: string; content: string }>()
const MODEL_CACHE_BUDGET = 32 * 1024 * 1024
function pruneFileModels() {
  const openIds = new Set(store.tabs.map(tab => tab.id))
  for (const id of panelEntriesCache.keys()) if (!openIds.has(id)) panelEntriesCache.delete(id)
  for (const id of viewStateCache.keys()) if (!openIds.has(id)) viewStateCache.delete(id)
  let bytes = 0
  for (const [id, entry] of fileModels) {
    if (!openIds.has(id)) {
      if (editor?.getModel() === entry.model) editor.setModel(null)
      entry.model.dispose()
      fileModels.delete(id)
      viewStateCache.delete(id)
      panelEntriesCache.delete(id)
    } else bytes += entry.model.getValueLength() * 2
  }
  // Open inactive tabs retain their text in the store; evict oldest models only under pressure.
  for (const [id, entry] of fileModels) {
    if (bytes <= MODEL_CACHE_BUDGET) break
    if (id === activeTab.value?.id) continue
    bytes -= entry.model.getValueLength() * 2
    entry.model.dispose()
    fileModels.delete(id)
  }
}

// ---- breadcrumb state ----
const BREADCRUMB_DROPDOWN_OFFSET_PX = 8
const editorBreadcrumbs = computed(() => buildWorkspaceBreadcrumbs(activeTab.value?.path ?? '', store.workspace?.rootPath))
type BreadcrumbDropdownState = {
  targetPath: string
  directoryPath: string
  expandedDirectoryPaths: string[]
  activePath: string
}
type BreadcrumbDropdownRow = {
  entry: FileEntry
  depth: number
  expanded: boolean
}

const breadcrumbDropdown = ref<BreadcrumbDropdownState | null>(null)
const breadcrumbDropdownPath = computed(() => breadcrumbDropdown.value?.targetPath ?? null)
const breadcrumbDropdownActivePath = computed(() => breadcrumbDropdown.value?.activePath ?? breadcrumbDropdownPath.value)
const breadcrumbDropdownAnchorLeft = ref(0)
const breadcrumbDropdownStyle = computed<CSSProperties>(() => ({
  left: `${breadcrumbDropdownAnchorLeft.value}px`,
}))
const breadcrumbDropdownLoading = ref(false)
const breadcrumbDropdownRef = ref<HTMLElement | null>(null)
const breadcrumbDropdownMenuRef = ref<HTMLElement | null>(null)
const breadcrumbDropdownEntries = computed(() => {
  const directoryPath = breadcrumbDropdown.value?.directoryPath
  if (!directoryPath) return []
  return sortEditorBreadcrumbEntries(store.directoryCache[directoryPath]?.entries ?? [])
})
const breadcrumbDropdownRows = computed<BreadcrumbDropdownRow[]>(() => {
  const dropdown = breadcrumbDropdown.value
  if (!dropdown) return []
  return buildBreadcrumbDropdownRows(
    breadcrumbDropdownEntries.value,
    new Set(dropdown.expandedDirectoryPaths.map((path) => path.toLowerCase())),
    0,
  )
})

function sortEditorBreadcrumbEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function buildBreadcrumbDropdownRows(entries: FileEntry[], expandedPathKeys: Set<string>, depth: number): BreadcrumbDropdownRow[] {
  const rows: BreadcrumbDropdownRow[] = []
  for (const entry of entries) {
    const path = normalizePath(entry.path)
    const expanded = entry.type === 'directory' && expandedPathKeys.has(path.toLowerCase())
    rows.push({ entry, depth, expanded })
    if (expanded) {
      rows.push(...buildBreadcrumbDropdownRows(
        sortEditorBreadcrumbEntries(store.directoryCache[path]?.entries ?? []),
        expandedPathKeys,
        depth + 1,
      ))
    }
  }
  return rows
}

async function toggleEditorBreadcrumb(targetPath: string, event?: MouseEvent) {
  const normalizedTargetPath = normalizePath(targetPath)
  if (breadcrumbDropdown.value?.targetPath === normalizedTargetPath) {
    closeEditorBreadcrumbDropdown()
    return
  }
  breadcrumbDropdownAnchorLeft.value = ((event?.currentTarget as HTMLElement | null)?.offsetLeft ?? 0) + BREADCRUMB_DROPDOWN_OFFSET_PX
  const parentDirectory = parentDirectoryOf(normalizedTargetPath)
  await openEditorBreadcrumbDropdown(
    normalizedTargetPath,
    parentDirectory,
    {
      activePath: normalizedTargetPath,
      expandedDirectoryPaths: [],
    },
  )
}

async function openEditorBreadcrumbDropdown(
  targetPath: string,
  directoryPath: string,
  options: { activePath?: string | null; expandedDirectoryPaths?: string[] } = {},
) {
  const normalizedTargetPath = normalizePath(targetPath)
  const normalizedDirectoryPath = normalizePath(directoryPath)
  const normalizedExpandedDirectoryPaths = options.expandedDirectoryPaths?.map((path) => normalizePath(path)) ?? []
  const normalizedActivePath = normalizePath(options.activePath ?? normalizedTargetPath)
  breadcrumbDropdown.value = {
    targetPath: normalizedTargetPath,
    directoryPath: normalizedDirectoryPath,
    expandedDirectoryPaths: normalizedExpandedDirectoryPaths,
    activePath: normalizedActivePath,
  }
  breadcrumbDropdownLoading.value = true
  try {
    await store.loadDirectory(normalizedDirectoryPath, true)
  } catch {
    // Store already reports directory read errors.
  } finally {
    if (
      breadcrumbDropdown.value?.targetPath === normalizedTargetPath
      && breadcrumbDropdown.value?.directoryPath === normalizedDirectoryPath
    ) {
      breadcrumbDropdownLoading.value = false
      await revealActiveBreadcrumbRow()
    }
  }
}

function parentDirectoryOf(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '')
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`
  const index = normalized.lastIndexOf('/')
  if (index === 2 && normalized[1] === ':') return normalized.slice(0, 3)
  return index > 0 ? normalized.slice(0, index) : normalized
}

async function toggleBreadcrumbDirectoryEntry(path: string) {
  const normalizedPath = normalizePath(path)
  const dropdown = breadcrumbDropdown.value
  if (!dropdown) {
    await openEditorBreadcrumbDropdown(normalizedPath, normalizedPath, {
      activePath: normalizePath(activeTab.value?.path ?? normalizedPath),
      expandedDirectoryPaths: [],
    })
    return
  }
  const pathKey = normalizedPath.toLowerCase()
  const isExpanded = dropdown.expandedDirectoryPaths.some((item) => item.toLowerCase() === pathKey)
  const scrollTop = breadcrumbDropdownMenuRef.value?.scrollTop ?? 0
  if (isExpanded) {
    breadcrumbDropdown.value = {
      ...dropdown,
      activePath: normalizedPath,
      expandedDirectoryPaths: dropdown.expandedDirectoryPaths.filter((item) => {
        const itemKey = item.toLowerCase()
        return itemKey !== pathKey && !itemKey.startsWith(`${pathKey}/`)
      }),
    }
    await restoreBreadcrumbDropdownScroll(scrollTop)
    return
  }

  breadcrumbDropdown.value = {
    ...dropdown,
    activePath: normalizedPath,
    expandedDirectoryPaths: [...dropdown.expandedDirectoryPaths, normalizedPath],
  }
  if (store.directoryCache[normalizedPath]) {
    await restoreBreadcrumbDropdownScroll(scrollTop)
    return
  }
  try {
    await store.loadDirectory(normalizedPath)
  } catch {
    // Store already reports directory read errors.
  } finally {
    if (
      breadcrumbDropdown.value?.targetPath === dropdown.targetPath
      && breadcrumbDropdown.value?.directoryPath === dropdown.directoryPath
      && breadcrumbDropdown.value?.expandedDirectoryPaths.some((item) => item.toLowerCase() === pathKey)
    ) {
      await restoreBreadcrumbDropdownScroll(scrollTop)
    }
  }
}

async function restoreBreadcrumbDropdownScroll(scrollTop: number) {
  await nextTick()
  const dropdown = breadcrumbDropdownMenuRef.value
  if (dropdown) dropdown.scrollTop = scrollTop
  await revealActiveBreadcrumbRow()
}

async function revealActiveBreadcrumbRow() {
  await nextTick()
  const activeRow = breadcrumbDropdownMenuRef.value?.querySelector<HTMLElement>('.breadcrumb-picker-row.active')
  activeRow?.scrollIntoView?.({ block: 'nearest' })
}

function closeEditorBreadcrumbDropdown() {
  breadcrumbDropdown.value = null
  breadcrumbDropdownLoading.value = false
  breadcrumbDropdownAnchorLeft.value = 0
}

async function openBreadcrumbFile(path: string) {
  if (props.onBreadcrumbFileOpen) await props.onBreadcrumbFileOpen(path)
  else await store.openFile(path)
  closeEditorBreadcrumbDropdown()
}

function onEditorBreadcrumbWindowClick(event: MouseEvent) {
  if (!mdConfigRoot.value?.contains(event.target as Node)) mdConfigMenuOpen.value = false
  if (breadcrumbDropdownRef.value?.contains(event.target as Node)) return
  if (encodingControlRoot.value?.contains(event.target as Node)) return
  closeEditorBreadcrumbDropdown()
  encodingMenuOpen.value = false
}

function openEncodingMenuFromActions() {
  closeTabsActionMenu()
  openEncodingMenu('reopen')
}

function openEncodingMenu(mode: 'reopen' | 'save' = 'reopen') {
  encodingMenuMode.value = mode
  encodingMenuOpen.value = true
}

function toggleEncodingMenu() {
  if (encodingMenuOpen.value) encodingMenuOpen.value = false
  else openEncodingMenu()
}

async function chooseEditorEncoding(encoding: string) {
  const tab = activeTab.value
  if (!tab) return
  if (encodingMenuMode.value === 'save') await store.saveTabWithEncoding(tab.id, encoding)
  else await store.reopenTabWithEncoding(tab.id, encoding)
  encodingMenuOpen.value = false
}
// ---- end breadcrumb state ----

type SaveCloseChoice = 'save' | 'discard' | 'cancel'
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
type FindDialogMode = 'find' | 'replace' | 'findInFiles' | 'findInProjects' | 'mark'

const EDITOR_ACTIONS: Record<EditorActionCommand, string> = {
  find: 'actions.find',
  replace: 'editor.action.startFindReplaceAction',
  gotoLine: 'editor.action.gotoLine',
  symbols: 'editor.action.quickOutline',
}

// Hover is local to this pane. It never changes workspace selection or history.
const previewingTab = computed(() => {
  if (!tabsListMenuOpen.value || !hoveredTabId.value) return null
  const tab = visibleTabs.value.find((tab) => tab.id === hoveredTabId.value)
  // Preview-only rendering errors must not mutate the open file's record.
  return tab ? { ...tab } : null
})
const activeTab = computed(() => previewingTab.value ?? store.activeTab)
const codePreviewScopePath = computed(() => store.codePreviewScopePath)
const visibleTabs = computed(() => {
  const scopePath = codePreviewScopePath.value?.replace(/\/+$/, '').toLowerCase()
  if (!scopePath) return store.tabs
  const originPath = store.codePreviewOriginPath ? normalizePath(store.codePreviewOriginPath).toLowerCase() : null
  return store.tabs.filter((tab) => {
    const path = normalizePath(tab.path).toLowerCase()
    return path === originPath || path.startsWith(`${scopePath}/`)
  })
})
const currentThemeId = computed(() => store.currentThemeId)
const currentFontStyleId = computed(() => store.settings.fontStyleId)
const renderColorCodesEnabled = computed(() => store.settings.renderColorCodes)
const imageZoomPresets = [0.25, 0.5, 0.75, 1, 2, 4]
const changePreview = computed(() => activeTab.value?.changePreview)
const showChangeDiff = computed(() => !!changePreview.value?.showingDiff)
const changeHasUiPreview = computed(() => isSuperhighUiPath(activeTab.value?.path ?? ''))
const showUnchangedCode = ref(false)
watch(() => changePreview.value?.requestId, () => { showUnchangedCode.value = false })
async function showCurrentSource() {
  const tab = activeTab.value
  if (!tab) return
  const before = tab.changePreview?.oldText.split('\n') ?? []
  const after = tab.changePreview?.newText.split('\n') ?? []
  let line = 0
  while (line < before.length && line < after.length && before[line] === after[line]) line++
  await store.openTerminalFileLink(tab.path, Math.max(1, Math.min(line + 1, after.length)), { preserveChangePreview: true })
}
const activeTabIsText = computed(() => activeTab.value?.contentType === 'text' && !showChangeDiff.value)
const canChangeEncoding = computed(() => !showChangeDiff.value && (activeTab.value?.contentType === 'text' || activeTab.value?.contentType === 'unsupported'))
const showEncodingBadge = computed(() => canChangeEncoding.value && (activeTab.value?.encoding ?? 'utf-8') !== 'utf-8')
const activeTabIsImage = computed(() => activeTab.value?.contentType === 'image')
const activeTabIsUnsupported = computed(() => activeTab.value?.contentType === 'unsupported')
const editorEncodingOptions = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'UTF-8 BOM', value: 'utf-8-bom' },
  { label: 'GBK', value: 'gbk' },
  { label: 'GB18030', value: 'gb18030' },
  { label: 'Big5', value: 'big5' },
  { label: 'Shift JIS', value: 'shift_jis' },
  { label: 'Windows-1252', value: 'windows-1252' },
  { label: 'UTF-16 LE', value: 'utf-16le' },
  { label: 'UTF-16 LE BOM', value: 'utf-16le-bom' },
  { label: 'UTF-16 BE', value: 'utf-16be' },
  { label: 'UTF-16 BE BOM', value: 'utf-16be-bom' },
]
const editorEncodingLabel = computed(() => {
  const encoding = activeTab.value?.encoding ?? 'utf-8'
  if (encoding.startsWith('mixed:')) return '混合编码'
  return editorEncodingOptions.find((option) => option.value === encoding)?.label ?? encoding.toUpperCase()
})
const showMarkdownPreview = computed(() => !changePreview.value?.sourceOnly && activeTabIsText.value && store.markdownPreviewEnabled && activeTab.value?.language === 'markdown')
const activeTabIsHtml = computed(() => activeTabIsText.value && extensionFromPath(activeTab.value?.path ?? '') === '.html')
const activeTabIsSuperhighEditorHtml = computed(() => activeTabIsHtml.value && isEditorPagePath(activeTab.value?.path ?? ''))
const showHtmlPreview = computed(() => !changePreview.value?.sourceOnly && activeTabIsHtml.value && store.settings.htmlPreviewEnabled)
const activeTabIsSuperhighUi = computed(() => activeTabIsText.value && isSuperhighUiPath(activeTab.value?.path ?? ''))
// IUI 用于直接呈现方案；进入文件时默认渲染，源码开关不沿用 HTML 的全局偏好。
watch(() => store.activeTab?.path, () => { store.superhighUiPreviewEnabled = true }, { immediate: true })
const showSuperhighUiPreview = computed(() => !changePreview.value?.sourceOnly && activeTabIsSuperhighUi.value && (!!previewingTab.value || store.superhighUiPreviewEnabled))
const activePluginPreviewProvider = computed(() => (activeTabIsText.value && activeTab.value && !activeTabIsSuperhighUi.value ? findPluginPreviewProvider(activeTab.value.path) : null))
const showPluginPreview = computed(() => !changePreview.value?.sourceOnly && !!activePluginPreviewProvider.value && store.settings.htmlPreviewEnabled)
const previewToggleLabel = computed(() => activePluginPreviewProvider.value?.title || (activeTabIsSuperhighUi.value ? '界面预览' : 'HTML 预览'))
const previewEnabled = computed(() => activeTabIsSuperhighUi.value ? showSuperhighUiPreview.value : store.settings.htmlPreviewEnabled)
function togglePreview() {
  if (activeTabIsSuperhighUi.value) store.superhighUiPreviewEnabled = !store.superhighUiPreviewEnabled
  else store.toggleHtmlPreview()
}
const showMonacoEditor = computed(() => activeTabIsText.value && !showMarkdownPreview.value && !showHtmlPreview.value && !showPluginPreview.value && !showSuperhighUiPreview.value)
const activeTabHasConflict = computed(() => {
  if (!activeTab.value) return false
  return !!store.fileConflictPaths[normalizePath(activeTab.value.path).toLowerCase()]
})
const dirtyTabCount = computed(() => visibleTabs.value.filter((tab) => tab.contentType === 'text' && tab.isDirty).length)
const renderedMarkdown = ref('')
watch(() => [showMarkdownPreview.value, activeTab.value?.path, activeTab.value?.content] as const, async ([visible, path, source], _old, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  if (!visible || !path) { renderedMarkdown.value = ''; return }
  const directory = path.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
  const html = renderWorkspaceMarkdown(source ?? '', directory)
  renderedMarkdown.value = html
  const linked = await linkWorkspacePaths(html, directory, candidate => backend.resolveTerminalPath(candidate))
  if (!cancelled) {
    const progress = markdownPreview.value?.getScrollProgress()
    renderedMarkdown.value = linked
    await nextTick()
    if (!cancelled && progress != null) markdownPreview.value?.setScrollProgress(progress)
  }
}, { immediate: true })

async function handleMarkdownClick(event: MouseEvent) {
  if (event.button !== 0) return
  const anchor = (event.target instanceof Element ? event.target.closest('a[href]') : null)
  const href = anchor?.getAttribute('href')?.trim()
  const sourcePath = activeTab.value?.path.replace(/\\/g, '/')
  if (!href || !sourcePath || /^https?:\/\//i.test(href)) return
  event.preventDefault()
  if (href.startsWith('#')) return
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return
  try {
    const autoPath = anchor?.getAttribute('data-workspace-path')
    let path = autoPath
    if (!path) {
      const base = sourcePath.startsWith('//') ? `file:${sourcePath}` : `file:///${sourcePath.replace(/^\//, '')}`
      const target = new URL(href.replace(/\\/g, '/'), base)
      if (target.protocol !== 'file:') return
      const localPath = decodeURIComponent(target.pathname).replace(/^\/([a-z]:\/)/i, '$1')
      path = target.hostname ? `//${target.hostname}${localPath}` : localPath
    }
    const resolved = await backend.resolveTerminalPath(path)
    if (!resolved) throw new Error(`未找到路径：${path}`)
    if (resolved.isFile) await store.openFile(resolved.path)
    else await store.openPath(resolved.path)
  } catch (error) {
    store.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}
const htmlPreviewDocument = ref('')
watch(() => [showHtmlPreview.value && !activeTabIsSuperhighEditorHtml.value, activeTab.value?.path, activeTab.value?.content] as const, async ([visible, path, source], _old, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  htmlPreviewDocument.value = ''
  if (!visible || !path) return
  try {
    const html = await inlineHtmlPreviewAssets(source ?? '', path, backend, store.workspace?.rootPath)
    if (!cancelled) htmlPreviewDocument.value = buildHtmlPreviewDocument(html)
  } catch (error) {
    if (!cancelled) store.showErrorMessage(`HTML 预览加载失败：${String(error)}`)
  }
}, { immediate: true })
const tabContextMenuStyle = computed<CSSProperties>(() => ({
  left: `${tabContextMenu.value?.x ?? 0}px`,
  top: `${tabContextMenu.value?.y ?? 0}px`,
}))
type KeyValuePanelEntry = YamlKeySpan | MarkdownHeadingSpan

const keyValuePanelEntries = computed<KeyValuePanelEntry[]>(() => {
  if (!store.settings.yamlKeyValuePanelEnabled || !activeTabIsText.value || !activeTab.value) return []
  const content = showMonacoEditor.value && panelContent.value?.tabId === activeTab.value.id
    ? panelContent.value.content : activeTab.value.content
  const language = activeTab.value.language
  const tabId = activeTab.value.id
  const compute = () => {
    const cached = panelEntriesCache.get(tabId)
    if (cached?.content === content && cached.language === language) return cached.entries
    const entries = language === 'yaml' ? scanYamlTopLevelKeys(content)
      : language === 'markdown' ? scanMarkdownHeadings(content) : []
    panelEntriesCache.set(tabId, { content, language, entries })
    return entries
  }
  const entry = fileModels.get(tabId)
  if (entry?.sourceContent === content) {
    return analysisCache.get(entry.model, entry.model.getVersionId(), `panel-entries:${language}`, compute)
  }
  return compute()
})
const keyValuePanelLabel = computed(() => activeTab.value?.language === 'markdown' ? 'MD标题' : 'YAML')
const keyValuePanelQuery = ref('')
const filteredKeyValuePanelEntries = computed<KeyValuePanelEntry[]>(() => {
  const query = keyValuePanelQuery.value.trim().toLowerCase()
  if (!query) return keyValuePanelEntries.value
  return keyValuePanelEntries.value.filter((key) => (
    key.keyName.toLowerCase().includes(query)
    || (!isMarkdownHeadingEntry(key) && key.keyPath.toLowerCase().includes(query))
  ))
})
const showMarkdownSwitch = computed(() => activeTabIsText.value && activeTab.value?.language === 'markdown')
watch(() => store.activeTabId, () => {
  mdConfigMenuOpen.value = false
})
const showKeyValueSwitch = computed(() => {
  const path = activeTab.value?.path ?? ''
  return (
    activeTab.value?.language === 'yaml'
    || activeTab.value?.language === 'markdown'
    || /\.(?:ya?ml|md|markdown)$/i.test(path)
  )
})
function toggleKeyValuePanel() {
  yamlTopLevelPanelOffset.value = { x: 0, y: 0 }
  keyValuePanelQuery.value = ''
  void store.setYamlKeyValuePanelEnabled(!store.settings.yamlKeyValuePanelEnabled)
}
function isMarkdownHeadingEntry(key: KeyValuePanelEntry): key is MarkdownHeadingSpan {
  return 'navigationDepth' in key
}
function keyValuePanelEntryStyle(key: KeyValuePanelEntry): CSSProperties | undefined {
  if (isMarkdownHeadingEntry(key)) {
    const style: CSSProperties = { paddingLeft: `${7 + key.navigationDepth * 14}px` }
    if (store.settings.markdownHeadingColorsEnabled) style.color = memoTitleColor(`md-heading:${key.keyName}`)
    return style
  }
  if (!store.settings.yamlKeyValueCodexColors) return undefined
  return { color: memoTitleColor(`yaml-key:${key.keyName}`) }
}
const yamlTopLevelPanelStyle = computed<CSSProperties>(() => ({
  transform: `translate(${yamlTopLevelPanelOffset.value.x}px, ${yamlTopLevelPanelOffset.value.y}px)`,
}))
const imageStyle = computed<CSSProperties>(() => {
  const size = imageNaturalSize.value
  if (!size) {
    return {
      maxWidth: '100%',
      maxHeight: '100%',
      imageRendering: 'pixelated',
    }
  }
  const width = Math.max(1, Math.round(size.width * imageZoom.value))
  const height = Math.max(1, Math.round(size.height * imageZoom.value))
  return {
    width: `${width}px`,
    height: `${height}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    imageRendering: 'pixelated',
  }
})
/** 代码预览区底部至少多出的可滚动行数（与 lineHeight 相乘），便于最后一行滚到视野上方 */
const MONACO_EXTRA_BOTTOM_SCROLL_LINES = 50
const MONACO_LINE_HEIGHT_PX = 20
const YAML_MARKER_OWNER = 'super-high-yaml'
const markdownScrollProgressByTabId = new Map<string, number>()
let yamlDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let yamlSyntaxDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let colorCodeDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let colorCodeStyleElement: HTMLStyleElement | null = null

// 给普通 HTML 预览注入外链桥接脚本，让网页链接交给系统浏览器。
function buildHtmlPreviewDocument(source: string): string {
  const bridge = `<script id="superhigh-external-link-bridge">${buildExternalLinkBridgeScript()}<\/script><script id="superhigh-long-press-bridge">${buildHtmlPreviewLongPressScript()}<\/script><script id="superhigh-resource-bridge">${buildHtmlPreviewResourceBridge(activeTab.value?.path ?? '')}<\/script>`
  const html = /<head(?:\s[^>]*)?>/i.test(source)
    ? source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bridge}`)
    : `${bridge}${source}`
  // 正式版 CSP 会拦截 srcdoc 内联脚本，需与 SuperhighHtmlPreview 一样经 bootstrap 转为 blob 脚本加载
  return prepareHtmlPreviewScripts(html, new URL('/html-preview-bootstrap.js', window.location.href).href)
}

async function mountEditor() {
  if (!editorHost.value || editor) return
  const monaco = await loadMonaco()
  if (!editorHost.value || editor) return
  registerEditorTabCompletion(monaco)
  applyEditorTheme(monaco, currentThemeId.value)
  editor = monaco.editor.create(editorHost.value, {
    model: null,
    theme: EDITOR_THEME_ID,
    automaticLayout: true,
    readOnly: !!previewingTab.value,
    minimap: { enabled: false },
    // Monaco 0.52 默认开启粘滞滚动：它会把「作用域行」浮层压在编辑器顶部。本项目主题的
    // 编辑器背景可以完全透明，浮层没有独立背景色，于是浮层文字与正文叠印成重影；对纯文本
    // 文件它还会按缩进挑出路径行当作用域，显示无意义内容。这里显式关闭。
    stickyScroll: { enabled: false },
    unicodeHighlight: MONACO_UNICODE_HIGHLIGHT,
    fontFamily: getCurrentMonoFontFamily(),
    fontWeight: getCurrentMonoFontWeight(),
    fontSize: 13,
    lineHeight: MONACO_LINE_HEIGHT_PX,
    roundedSelection: false,
    scrollBeyondLastLine: false,
    mouseWheelScrollSensitivity: scrollSpeedMultiplier(store.settings.scrollSpeedPercent),
    padding: { bottom: MONACO_EXTRA_BOTTOM_SCROLL_LINES * MONACO_LINE_HEIGHT_PX },
    inlineSuggest: {
      enabled: true,
      mode: 'subwordSmart',
      showToolbar: 'never',
      suppressSuggestions: true,
      keepOnBlur: true,
    },
    quickSuggestions: {
      other: 'inline',
      comments: 'off',
      strings: 'inline',
    },
    quickSuggestionsDelay: 25,
    suggest: {
      preview: true,
      previewMode: 'subwordSmart',
      localityBonus: true,
      snippetsPreventQuickSuggestions: false,
      selectionMode: 'whenQuickSuggestion',
    },
    tabCompletion: 'on',
    acceptSuggestionOnEnter: 'smart',
    wordBasedSuggestions: 'currentDocument',
    renderLineHighlight: 'line',
    renderLineHighlightOnlyWhenFocus: false,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    matchBrackets: 'never',
    renderValidationDecorations: 'on',
    selectionHighlight: false,
    occurrencesHighlight: 'off',
    bracketPairColorization: { enabled: false },
    guides: {
      indentation: false,
      highlightActiveIndentation: false,
      bracketPairs: false,
      bracketPairsHorizontal: false,
      highlightActiveBracketPair: false,
    },
  })
  syncedEditorContent = editor.getValue()
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void store.saveActiveTab()
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
    void openFindDialog('find')
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => {
    void openFindDialog('replace')
  })
  yamlDecorations = editor.createDecorationsCollection()
  yamlSyntaxDecorations = editor.createDecorationsCollection()
  colorCodeDecorations = editor.createDecorationsCollection()
  editor.onDidChangeModelContent((event) => {
    if (syncing || previewingTab.value || !editor || lastSyncedTabId !== store.activeTabId) return
    syncedEditorContent = event.isFlush || event.isEolChange
      ? editor.getValue()
      : applyEditorContentChanges(syncedEditorContent, event.changes)
    // Freeze navigation input before publishing the new store content.
    if (activeTab.value && panelContent.value?.tabId !== activeTab.value.id) {
      panelContent.value = { tabId: activeTab.value.id, content: activeTab.value.content }
    }
    const entry = fileModels.get(lastSyncedTabId ?? '')
    if (entry) entry.sourceContent = entry.content = syncedEditorContent
    store.updateActiveTabContent(syncedEditorContent)
    const model = editor.getModel()
    if (model && activeTab.value?.language === 'yaml') updateYamlSyntaxMarkers(model)
    editorAnalysisTask.schedule()
  })
  editor.onDidScrollChange?.(() => editorViewportTask.schedule())
  editor.onDidLayoutChange?.(() => editorViewportTask.schedule())
  editor.onDidChangeCursorSelection(() => {
    const selection = editor?.getSelection()
    const model = editor?.getModel()
    selectedText.value = selection && model && !selection.isEmpty()
      ? model.getValueInRange(selection)
      : ''
  })
  // Ctrl+click YAML key → jump to next occurrence
  editor.onMouseDown((event) => {
    if (!event.event.ctrlKey && !event.event.metaKey) return
    const target = event.target
    if (!target.position || !target.position.lineNumber) return
    if (activeTab.value?.language !== 'yaml' || lastSyncedTabId !== activeTab.value.id) return
    const model = editor?.getModel()
    if (!model) return
    const line = model.getLineContent(target.position.lineNumber)
    const column = target.position.column - 1
    // Find which key span this column falls under
    const index = analysisCache.get(model, model.getVersionId(), 'yaml-index', () => buildYamlKeyIndex(syncedEditorContent))
    const span = index.all.find(
      (s) => s.lineNumber === target.position!.lineNumber && column >= s.startColumn && column < s.endColumn,
    )
    if (!span) return
    const next = nextKeyOccurrence(index, span.keyName, span.lineNumber)
    if (!next) return
    editor?.setPosition({ lineNumber: next.lineNumber, column: next.startColumn + 1 })
    editor?.revealLineInCenter(next.lineNumber)
    editor?.focus()
  })
}

function disposeEditor() {
  cancelYamlSyntaxAnalysis()
  editorAnalysisTask.cancel()
  editorViewportTask.cancel()
  saveCurrentViewState()
  selectedText.value = ''
  yamlDecorations?.clear()
  yamlDecorations = null
  yamlSyntaxDecorations?.clear()
  yamlSyntaxDecorations = null
  clearYamlSyntaxMarkers()
  yamlSyntaxIssues.value = []
  colorCodeDecorations?.clear()
  colorCodeDecorations = null
  clearColorCodeStyles()
  editor?.dispose()
  editor = null
  lastSyncedTabId = null
}

function getEditorScrollProgress() {
  if (!editor) return null
  const maxScrollTop = Math.max(0, (editor.getScrollHeight?.() ?? 0) - (editor.getLayoutInfo?.()?.height ?? 0))
  const scrollTop = editor.getScrollTop?.() ?? 0
  return maxScrollTop > 0 ? Math.min(1, Math.max(0, scrollTop / maxScrollTop)) : 0
}

function setEditorScrollProgress(progress: number) {
  if (!editor) return
  const maxScrollTop = Math.max(0, (editor.getScrollHeight?.() ?? 0) - (editor.getLayoutInfo?.()?.height ?? 0))
  editor.setScrollTop?.(Math.round(Math.min(1, Math.max(0, progress)) * maxScrollTop))
}

function captureMarkdownScrollProgress() {
  const tab = activeTab.value
  if (!tab || tab.language !== 'markdown') return
  const progress = markdownPreview.value?.getScrollProgress() ?? getEditorScrollProgress()
  if (progress != null) markdownScrollProgressByTabId.set(tab.id, progress)
}

async function restoreMarkdownScrollProgress() {
  const tab = activeTab.value
  const progress = tab ? markdownScrollProgressByTabId.get(tab.id) : undefined
  if (tab?.language !== 'markdown' || progress == null) return
  await nextTick()
  if (showMarkdownPreview.value) markdownPreview.value?.setScrollProgress(progress)
  else setEditorScrollProgress(progress)
}

function editorLanguageForTab(tab: EditorTab | null): string {
  if (!tab) return 'plaintext'
  return tab.contentType === 'text' ? inferLanguage(tab.path) : tab.language
}

function buildYamlKeyValueDecorations(model: MonacoTypes.editor.ITextModel): MonacoTypes.editor.IModelDeltaDecoration[] {
  const monaco = getMonaco()
  if (!monaco) return []
  const decorations: MonacoTypes.editor.IModelDeltaDecoration[] = []
  const visible = visibleEditorLines(model)
  // Block scalars can start above the viewport. Cache their context once per
  // version so scrolling does not repeatedly scan the entire prefix.
  const contexts = analysisCache.get(model, model.getVersionId(), 'yaml-block-context', () => {
    const result: (number | null)[] = []
    let parent: number | null = null
    for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
      result.push(parent)
      const line = model.getLineContent(lineNumber)
      if (parent !== null) {
        if (!line.trim() || countLeadingWhitespace(line) > parent) continue
        parent = null
      }
      const match = findYamlKeyValueLine(line)
      if (match?.valueKind === 'block') parent = match.keyStartIndex
    }
    return result
  })
  let activeBlockParentIndent = contexts[visible.startLineNumber - 1] ?? null

  for (let lineNumber = visible.startLineNumber; lineNumber <= visible.endLineNumber; lineNumber += 1) {
    const line = model.getLineContent(lineNumber)
    const trimmed = line.trim()
    const indent = countLeadingWhitespace(line)

    if (activeBlockParentIndent !== null) {
      if (!trimmed) continue
      if (indent > activeBlockParentIndent) {
        decorations.push({
          range: new monaco.Range(lineNumber, indent + 1, lineNumber, line.length + 1),
          options: {
            inlineClassName: 'yaml-preview-block-text',
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })
        continue
      }
      activeBlockParentIndent = null
    }

    const commentStart = findYamlCommentStart(line)
    if (commentStart >= 0) {
      decorations.push({
        range: new monaco.Range(lineNumber, commentStart + 1, lineNumber, line.length + 1),
        options: {
          inlineClassName: 'yaml-preview-comment',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })
    }

    const match = findYamlKeyValueLine(line)
    if (!match) continue

    decorations.push({
      range: new monaco.Range(lineNumber, match.keyStartIndex + 1, lineNumber, match.keyEndIndex + 1),
      options: {
        inlineClassName: 'yaml-preview-key',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })
    decorations.push({
      range: new monaco.Range(lineNumber, match.separatorIndex + 1, lineNumber, match.separatorIndex + 2),
      options: {
        inlineClassName: 'yaml-preview-separator',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })

    const sequenceMarkerStart = findYamlSequenceMarkerStart(line, indent)
    if (sequenceMarkerStart >= 0) {
      decorations.push({
        range: new monaco.Range(lineNumber, sequenceMarkerStart + 1, lineNumber, sequenceMarkerStart + 2),
        options: {
          inlineClassName: 'yaml-preview-list-marker',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })
    }

    if (match.valueEndIndex > match.valueStartIndex) {
      const valueText = line.slice(match.valueStartIndex, match.valueEndIndex)
      decorations.push({
        range: new monaco.Range(lineNumber, match.valueStartIndex + 1, lineNumber, match.valueEndIndex + 1),
        options: {
          inlineClassName: match.valueKind === 'block' ? 'yaml-preview-block-marker' : yamlValuePreviewClass(valueText),
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })
    }

    if (match.valueKind === 'block') {
      activeBlockParentIndent = match.keyStartIndex
    }
  }

  return decorations
}

function buildYamlSyntaxDecorations(issues: YamlSyntaxIssue[]): MonacoTypes.editor.IModelDeltaDecoration[] {
  const monaco = getMonaco()
  if (!monaco) return []

  return issues.map((issue) => ({
    range: new monaco.Range(issue.lineNumber, issue.column, issue.endLineNumber, issue.endColumn),
    options: {
      inlineClassName: 'yaml-preview-error',
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }))
}

function countLeadingWhitespace(line: string): number {
  let index = 0
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1
  return index
}

function findYamlSequenceMarkerStart(line: string, indent: number): number {
  const marker = line.slice(indent, indent + 2)
  return marker === '- ' || marker === '-\t' ? indent : -1
}

function yamlValuePreviewClass(value: string): string {
  const trimmed = value.trim()
  if (/^(true|false|null|~)$/i.test(trimmed)) return 'yaml-preview-literal'
  if (/^[-+]?(?:0|[1-9][\d_]*)(?:\.[\d_]+)?(?:e[-+]?\d+)?$/i.test(trimmed)) return 'yaml-preview-number'
  if (/^["'].*["']$/.test(trimmed)) return 'yaml-preview-string'
  if (/^[\[{]/.test(trimmed)) return 'yaml-preview-flow'
  return 'yaml-preview-value'
}

function findYamlCommentStart(line: string): number {
  let quote: '"' | "'" | null = null

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    const previous = line[index - 1]

    if (quote === "'") {
      if (char === "'" && next === "'") {
        index += 1
      } else if (char === "'") {
        quote = null
      }
      continue
    }

    if (quote === '"') {
      if (char === '\\') {
        index += 1
      } else if (char === '"') {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (char === '#' && (!previous || previous === ' ' || previous === '\t')) return index
  }

  return -1
}

function updateYamlKeyValueDecorations() {
  const model = editor?.getModel()
  if (!model || activeTab.value?.language !== 'yaml') {
    yamlDecorations?.clear()
    yamlSyntaxDecorations?.clear()
    clearYamlSyntaxMarkers()
    yamlSyntaxIssues.value = []
    return
  }

  yamlDecorations?.set(buildYamlKeyValueDecorations(model))
}

function updateYamlSyntaxMarkers(model: MonacoTypes.editor.ITextModel) {
  const monaco = getMonaco()
  const tabId = activeTab.value?.id
  if (!monaco || !tabId) return
  if (model.getValueLength() > 2 * 1024 * 1024 || model.getLineCount() > 100000) {
    cancelYamlSyntaxAnalysis()
    clearYamlSyntaxMarkers()
    return
  }
  const version = model.getVersionId()
  if (yamlAnalysisTarget?.model === model && yamlAnalysisTarget.version === version && yamlAnalysisTarget.tabId === tabId) return
  if (yamlAnalysisTarget?.model !== model || yamlAnalysisTarget.tabId !== tabId) yamlSyntaxAnalysis.cancel()
  const target = { model, version, tabId }
  yamlAnalysisTarget = target
  yamlSyntaxIssues.value = []
  monaco.editor.setModelMarkers(model, YAML_MARKER_OWNER, [])
  yamlSyntaxDecorations?.clear()
  yamlSyntaxAnalysis.schedule(syncedEditorContent, (issues) => {
    if (yamlAnalysisTarget !== target || editor?.getModel() !== model || activeTab.value?.id !== tabId
      || activeTab.value.language !== 'yaml' || model.getVersionId() !== version) return
    yamlSyntaxIssues.value = issues
    monaco.editor.setModelMarkers(model, YAML_MARKER_OWNER, issues.map((issue) => ({
      severity: monaco.MarkerSeverity.Error,
      message: issue.message,
      startLineNumber: issue.lineNumber,
      startColumn: issue.column,
      endLineNumber: issue.endLineNumber,
      endColumn: issue.endColumn,
    })))
    yamlSyntaxDecorations?.set(buildYamlSyntaxDecorations(issues))
  }, (error) => {
    if (yamlAnalysisTarget === target) yamlAnalysisTarget = null
    console.warn('YAML syntax analysis failed', error)
  })
}

function cancelYamlSyntaxAnalysis() {
  yamlSyntaxAnalysis.cancel()
  yamlAnalysisTarget = null
  yamlSyntaxIssues.value = []
  yamlSyntaxDecorations?.clear()
  clearYamlSyntaxMarkers()
}

function clearYamlSyntaxMarkers() {
  const monaco = getMonaco()
  const model = editor?.getModel()
  if (!monaco || !model) return
  monaco.editor.setModelMarkers(model, YAML_MARKER_OWNER, [])
}

function updateColorCodePreviewDecorations() {
  const monaco = getMonaco()
  const model = editor?.getModel()
  if (!monaco || !model || !activeTabIsText.value || !renderColorCodesEnabled.value) {
    colorCodeDecorations?.clear()
    clearColorCodeStyles()
    return
  }

  const visible = visibleEditorLines(model)
  const text = model.getValueInRange({
    startLineNumber: visible.startLineNumber, startColumn: 1,
    endLineNumber: visible.endLineNumber, endColumn: model.getLineMaxColumn(visible.endLineNumber),
  })
  const ranges = buildColorCodePreviewRanges(text).map(range => ({
    ...range, lineNumber: range.lineNumber + visible.startLineNumber - 1,
  }))
  const colors = Array.from(new Set(ranges.map((range) => range.color)))
  applyColorCodeStyles(colors)
  colorCodeDecorations?.set(ranges.map((range) => ({
    range: new monaco.Range(range.lineNumber, range.startColumn, range.lineNumber, range.endColumn),
    options: {
      inlineClassName: colorCodePreviewClassName(range.color),
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  })))
}

function visibleEditorLines(model: MonacoTypes.editor.ITextModel) {
  const ranges = editor?.getVisibleRanges?.() ?? []
  const lineCount = model.getLineCount()
  const startLineNumber = Math.min(lineCount, Math.max(1, (ranges[0]?.startLineNumber ?? 1) - 20))
  return {
    startLineNumber,
    endLineNumber: Math.max(startLineNumber, Math.min(lineCount, (ranges.at(-1)?.endLineNumber ?? 80) + 20)),
  }
}

function updateVisibleEditorDecorations() {
  if (syncing || editorAnalysisTask.pending || lastSyncedTabId !== activeTab.value?.id) return
  updateYamlKeyValueDecorations()
  updateColorCodePreviewDecorations()
}

function updateEditorDecorations() {
  editorAnalysisTask.cancel()
  editorViewportTask.cancel()
  if (lastSyncedTabId !== activeTab.value?.id) return
  const model = editor?.getModel()
  if (model && activeTab.value?.language === 'yaml') updateYamlSyntaxMarkers(model)
  else cancelYamlSyntaxAnalysis()
  if (activeTab.value) panelContent.value = { tabId: activeTab.value.id, content: activeTab.value.content }
  updateVisibleEditorDecorations()
}

function applyColorCodeStyles(colors: string[]) {
  if (!colors.length) {
    clearColorCodeStyles()
    return
  }
  if (!colorCodeStyleElement) {
    colorCodeStyleElement = document.createElement('style')
    colorCodeStyleElement.dataset.superHighColorCodes = 'true'
    document.head.appendChild(colorCodeStyleElement)
  }
  colorCodeStyleElement.textContent = colors.map(colorCodePreviewStyleRule).join('\n')
}

function clearColorCodeStyles() {
  if (colorCodeStyleElement) colorCodeStyleElement.textContent = ''
}

function saveCurrentViewState() {
  if (!editor || !lastSyncedTabId) return
  const state = editor.saveViewState()
  if (state) viewStateCache.set(lastSyncedTabId, state)
}

function syncEditor() {
  const monaco = getMonaco()
  if (!monaco || !editor || !activeTab.value || !activeTabIsText.value) return
  editor.updateOptions({ readOnly: !!previewingTab.value })
  const current = fileModels.get(activeTab.value.id)
  if (lastSyncedTabId === activeTab.value.id && current?.path === activeTab.value.path && current.sourceContent === activeTab.value.content && current.model === editor.getModel()) return
  saveCurrentViewState()
  syncing = true
  try {
    const tab = activeTab.value
    let entry = fileModels.get(tab.id)
    if (entry && entry.path !== tab.path) {
      if (editor.getModel() === entry.model) editor.setModel(null)
      entry.model.dispose()
      fileModels.delete(tab.id)
      entry = undefined
    }
    const language = editorLanguageForTab(tab)
    if (!entry) {
      const model = monaco.editor.createModel(tab.content, language, monaco.Uri.from({ scheme: 'superhigh-editor', authority: modelNamespace, path: `/${tab.id}/${tab.path.replace(/\\/g, '/')}` }))
      entry = { path: tab.path, model, sourceContent: tab.content, content: model.getValue() }
      fileModels.set(tab.id, entry)
    }
    // Refresh insertion order so budget pressure evicts the least recently used buffer.
    fileModels.delete(tab.id)
    fileModels.set(tab.id, entry)
    const model = entry.model
    if (editor.getModel() !== model) editor.setModel(model)
    monaco.editor.setModelLanguage(model, language)
    if (entry.sourceContent !== tab.content) {
      model.setValue(tab.content)
      entry.sourceContent = tab.content
      entry.content = model.getValue()
    }
    syncedEditorContent = entry.content
    // Keep expensive suggestions off for very large buffers; text and saving remain immediate.
    const large = model.getValueLength() > 2 * 1024 * 1024
    editor.updateOptions({ wordBasedSuggestions: large ? 'off' : 'currentDocument', folding: !large })
    pruneFileModels()
  } finally {
    syncing = false
  }
  lastSyncedTabId = activeTab.value.id
  const cached = viewStateCache.get(activeTab.value.id)
  if (cached) {
    editor.restoreViewState(cached)
  }
  updateEditorDecorations()
}

function syncTheme() {
  const monaco = getMonaco()
  if (!monaco) return
  applyEditorTheme(monaco, currentThemeId.value)
}

async function ensureEditorReady() {
  if (!activeTab.value || !activeTabIsText.value) return null
  if (showMarkdownPreview.value) store.toggleMarkdownPreview()
  await nextTick()
  await mountEditor()
  syncEditor()
  syncTheme()
  editor?.focus()
  return editor
}

async function runEditorAction(action: string) {
  const instance = await ensureEditorReady()
  await instance?.getAction(action)?.run()
}

async function openFindDialog(mode: FindDialogMode) {
  await ensureEditorReady()
  findDialogMode.value = mode
  findDialogOpen.value = true
  await nextTick()
  findDialog.value?.activate()
}

function findDialogEditor() {
  return editor
}

function applyFindDialogTabContent(tabId: string, content: string) {
  store.updateTabContent(tabId, content)
  if (tabId !== store.activeTabId) return
  const model = editor?.getModel()
  if (!model) return
  syncing = true
  try {
    syncedEditorContent = content
    model.setValue(content)
    syncedEditorContent = model.getValue()
    const entry = fileModels.get(tabId)
    if (entry) { entry.sourceContent = content; entry.content = syncedEditorContent }
  } finally {
    syncing = false
  }
  updateEditorDecorations()
}

async function navigateFromFindDialog(detail: { path: string; lineNumber: number; column: number }) {
  const currentPath = activeTab.value?.path
  if (!currentPath || normalizePath(currentPath).toLowerCase() !== normalizePath(detail.path).toLowerCase()) {
    const opened = await store.openFile(detail.path)
    if (!opened) return
  }
  await revealEditorPosition({ path: detail.path, lineNumber: detail.lineNumber, column: detail.column })
}

function selectionOrWordRange(instance: MonacoTypes.editor.IStandaloneCodeEditor): MonacoTypes.IRange | null {
  const selection = instance.getSelection()
  const model = instance.getModel()
  if (!selection || !model) return null
  if (!selection.isEmpty()) return selection

  const position = selection.getStartPosition()
  const word = model.getWordAtPosition(position)
  if (!word) return null
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  }
}

function replaceSelectionText(
  instance: MonacoTypes.editor.IStandaloneCodeEditor,
  transform: (value: string) => string,
) {
  const model = instance.getModel()
  const range = selectionOrWordRange(instance)
  if (!model || !range) return
  const nextText = transform(model.getValueInRange(range))
  instance.executeEdits('superhigh-menu', [{ range, text: nextText, forceMoveMarkers: true }])
  instance.focus()
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // Clipboard permissions vary by webview; Monaco fallback handles paste below.
  }
}

async function runEditorMenuCommand(command: EditorMenuCommand) {
  const instance = await ensureEditorReady()
  const model = instance?.getModel()
  if (!instance || !model) return

  instance.focus()

  if (command === 'undo' || command === 'redo') {
    instance.trigger('superhigh-menu', command, null)
    return
  }

  if (command === 'selectAll') {
    instance.setSelection(model.getFullModelRange())
    return
  }

  if (command === 'copy' || command === 'cut' || command === 'delete') {
    const selection = instance.getSelection()
    if (!selection || selection.isEmpty()) return
    if (command !== 'delete') await writeClipboard(model.getValueInRange(selection))
    if (command !== 'copy') {
      instance.executeEdits('superhigh-menu', [{ range: selection, text: '', forceMoveMarkers: true }])
    }
    return
  }

  if (command === 'paste') {
    try {
      const text = await navigator.clipboard?.readText()
      if (typeof text !== 'string') throw new Error('clipboard unavailable')
      const selection = instance.getSelection()
      if (!selection) return
      instance.executeEdits('superhigh-menu', [{ range: selection, text, forceMoveMarkers: true }])
    } catch {
      instance.trigger('superhigh-menu', 'editor.action.clipboardPasteAction', null)
    }
    return
  }

  if (command === 'uppercase') {
    replaceSelectionText(instance, (value) => value.toUpperCase())
    return
  }

  if (command === 'lowercase') {
    replaceSelectionText(instance, (value) => value.toLowerCase())
    return
  }

  if (command === 'indent') {
    await instance.getAction('editor.action.indentLines')?.run()
    return
  }

  if (command === 'outdent') {
    await instance.getAction('editor.action.outdentLines')?.run()
    return
  }

  if (command === 'toggleComment') {
    await instance.getAction('editor.action.commentLine')?.run()
  }
}

async function revealEditorPosition(
  detail: { path?: string; lineNumber?: number; column?: number },
  attempt = 0,
) {
  const expectedPath = detail.path?.trim()
  const currentPath = activeTab.value?.path
  if (
    expectedPath &&
    (!currentPath || normalizePath(currentPath).toLowerCase() !== normalizePath(expectedPath).toLowerCase())
  ) {
    if (attempt < 12) {
      revealTimer = window.setTimeout(() => {
        revealTimer = null
        void revealEditorPosition(detail, attempt + 1)
      }, 50)
    }
    return
  }

  const instance = await ensureEditorReady()
  const model = instance?.getModel()
  if (!instance || !model) return

  const requestedLine = Math.max(1, Number(detail.lineNumber) || 1)
  const lineNumber = Math.min(requestedLine, model.getLineCount())
  const requestedColumn = Math.max(1, Number(detail.column) || 1)
  const column = Math.min(requestedColumn, model.getLineMaxColumn(lineNumber))
  instance.setPosition({ lineNumber, column })
  instance.revealLineInCenter(lineNumber)
  instance.focus()
}

async function revealYamlSyntaxIssue(issue: YamlSyntaxIssue) {
  const instance = await ensureEditorReady()
  if (!instance) return
  updateEditorDecorations()
  const current = yamlSyntaxIssues.value.find(candidate => candidate.message === issue.message)
  if (!current) return
  issue = current
  instance.setPosition({ lineNumber: issue.lineNumber, column: issue.column })
  instance.revealLineInCenter(issue.lineNumber)
  instance.focus()
}

async function revealKeyValuePanelEntry(key: KeyValuePanelEntry) {
  if (showMarkdownPreview.value && isMarkdownHeadingEntry(key)) {
    markdownPreview.value?.scrollToHeading(key.anchorId)
    return
  }
  const instance = await ensureEditorReady()
  const model = instance?.getModel()
  if (!instance || !model) return
  updateEditorDecorations()
  const current = keyValuePanelEntries.value.find(candidate => (
    isMarkdownHeadingEntry(key) && isMarkdownHeadingEntry(candidate)
      ? candidate.anchorId === key.anchorId
      : !isMarkdownHeadingEntry(key) && !isMarkdownHeadingEntry(candidate) && candidate.keyPath === key.keyPath
  ))
  if (!current) return
  key = current

  const lineNumber = Math.min(Math.max(1, key.lineNumber), model.getLineCount())
  const column = Math.min(Math.max(1, key.startColumn + 1), model.getLineMaxColumn(lineNumber))
  instance.setPosition({ lineNumber, column })
  instance.revealLineInCenter(lineNumber)
  instance.focus()
}

function startYamlTopLevelPanelDrag(event: PointerEvent) {
  if (event.button !== 0) return
  yamlTopLevelPanelDrag = {
    startX: event.clientX,
    startY: event.clientY,
    originX: yamlTopLevelPanelOffset.value.x,
    originY: yamlTopLevelPanelOffset.value.y,
    moved: false,
  }
  window.addEventListener('pointermove', onYamlTopLevelPanelDrag)
  window.addEventListener('pointerup', stopYamlTopLevelPanelDrag)
  window.addEventListener('pointercancel', stopYamlTopLevelPanelDrag)
}

function onYamlTopLevelPanelDrag(event: PointerEvent) {
  if (!yamlTopLevelPanelDrag) return
  const deltaX = event.clientX - yamlTopLevelPanelDrag.startX
  const deltaY = event.clientY - yamlTopLevelPanelDrag.startY
  if (Math.abs(deltaX) + Math.abs(deltaY) > 3) yamlTopLevelPanelDrag.moved = true
  if (yamlTopLevelPanelDrag.moved) event.preventDefault()
  yamlTopLevelPanelOffset.value = {
    x: yamlTopLevelPanelDrag.originX + deltaX,
    y: yamlTopLevelPanelDrag.originY + deltaY,
  }
}

function stopYamlTopLevelPanelDrag() {
  yamlTopLevelPanelDrag = null
  window.removeEventListener('pointermove', onYamlTopLevelPanelDrag)
  window.removeEventListener('pointerup', stopYamlTopLevelPanelDrag)
  window.removeEventListener('pointercancel', stopYamlTopLevelPanelDrag)
}

function handleEditorMenuCommand(event: Event) {
  const command = (event as CustomEvent<{ command?: EditorMenuCommand }>).detail?.command
  if (!command) return
  void runEditorMenuCommand(command)
}

function handleEditorAction(event: Event) {
  const action = (event as CustomEvent<{ action?: EditorActionCommand }>).detail?.action
  if (!action) return
  if (action === 'find' || action === 'replace') {
    void openFindDialog(action)
    return
  }
  void runEditorAction(EDITOR_ACTIONS[action])
}

function handleRevealEditorPosition(event: Event) {
  const detail = (event as CustomEvent<{ path?: string; lineNumber?: number; column?: number }>).detail
  if (!detail) return
  void revealEditorPosition(detail)
}

function handleEditorCloseRequest() {
  closeCurrentTab()
}

function closeTabsActionMenu() {
  tabsActionMenuOpen.value = false
}

function toggleTabsActionMenu() {
  if (!visibleTabs.value.length) return
  closeTabContextMenu()
  tabsActionMenuOpen.value = !tabsActionMenuOpen.value
}

function positionTabsListMenu() {
  const rect = tabsListButton.value?.getBoundingClientRect()
  const panel = editorPanel.value?.closest('.shared-preview-panel') ?? editorPanel.value
  const bounds = panel?.getBoundingClientRect()
  if (rect && bounds) {
    // Meet the outer edge of the actual splitter, including its width.
    const nextPanel = panel?.nextElementSibling
    const previousPanel = panel?.previousElementSibling
    const opensRight = store.settings.projectLayoutMode === 'swapped'
    const splitter = opensRight ? nextPanel : previousPanel
    const splitBounds = splitter?.classList.contains('workspace-resizer') ? splitter.getBoundingClientRect() : bounds
    const edge = opensRight ? splitBounds.right : splitBounds.left
    tabsListMenuStyle.value = {
      top: `${rect.top}px`,
      left: opensRight ? `${edge}px` : 'auto',
      right: opensRight ? 'auto' : `${window.innerWidth - edge}px`,
      maxWidth: `${Math.max(0, opensRight ? window.innerWidth - edge : edge)}px`,
      maxHeight: `${Math.max(0, window.innerHeight - rect.top)}px`,
    }
  }
}

function toggleTabsListMenu() {
  if (!visibleTabs.value.length) return
  if (tabsListMenuOpen.value) {
    tabsListMenuOpen.value = false
    return
  }
  positionTabsListMenu()
  tabsListMenuOpen.value = true
  closeTabsActionMenu()
}

watch(tabsListMenuOpen, () => { hoveredTabId.value = null })
watch(() => !!previewingTab.value, (previewing) => { editor?.updateOptions({ readOnly: previewing }) })

function closeTabsListOnResize() {
  tabsListMenuOpen.value = false
}

function selectTabFromList(tab: EditorTab) {
  void store.setActiveTab(tab.id)
  tabsListMenuOpen.value = false
  void nextTick(scrollActiveEditorTabIntoView)
}

function closeTabContextMenu() {
  tabContextMenu.value = null
}

function clampMenuPosition(clientX: number, clientY: number, width = 238, height = 130) {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(clientX, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(clientY, window.innerHeight - height - margin)),
  }
}

function openTabContextMenu(tab: EditorTab, event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  closeTabsActionMenu()
  store.setActiveTab(tab.id)
  const position = clampMenuPosition(event.clientX, event.clientY)
  tabContextMenu.value = { tab, ...position }
}

function tabRelativePath(tab: EditorTab): string {
  const normalizedPath = normalizePath(tab.path)
  const normalizedRoot = normalizePath(store.workspace?.rootPath ?? '').replace(/\/+$/, '')
  if (!normalizedRoot) return normalizedPath
  const pathKey = normalizedPath.toLowerCase()
  const rootKey = normalizedRoot.toLowerCase()
  if (pathKey === rootKey) return '.'
  const prefix = `${normalizedRoot}/`
  return pathKey.startsWith(prefix.toLowerCase()) ? normalizedPath.slice(prefix.length) : normalizedPath
}

async function copyTabRelativePath() {
  const tab = tabContextMenu.value?.tab
  closeTabContextMenu()
  if (!tab) return
  await writeClipboard(tabRelativePath(tab))
}

async function copyTabAbsolutePath() {
  const tab = tabContextMenu.value?.tab
  closeTabContextMenu()
  if (!tab) return
  await writeClipboard(normalizePath(tab.path))
}

function getCurrentMonoFontFamily() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
}

function getCurrentMonoFontWeight() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono-weight').trim() || 'normal'
}

async function openTabInExplorer() {
  const tab = tabContextMenu.value?.tab
  closeTabContextMenu()
  if (!tab) return
  // Keep the tab's own path. Tabs opened from a CLI conversation can live
  // outside the current workspace, so joining it to workspace.rootPath would
  // reveal a different file.
  await store.openPath(normalizePath(tab.path))
}

function addTabRelativePathToChat() {
  const tab = tabContextMenu.value?.tab
  closeTabContextMenu()
  if (!tab) return
  window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', {
    detail: {
      text: tabRelativePath(tab),
      insertMode: 'plain',
    },
  }))
}

function onTabsActionWindowMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (tabContextMenu.value && !target?.closest('.tab-context-menu')) closeTabContextMenu()
  if (tabsListMenuOpen.value && !tabsListButton.value?.contains(event.target as Node) && !tabsListMenuEl.value?.contains(event.target as Node)) tabsListMenuOpen.value = false
  if (tabsActionMenuOpen.value) {
    if (tabsActionMenuRoot.value?.contains(event.target as Node)) return
    closeTabsActionMenu()
  }
}

function onTabsActionWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeTabsActionMenu()
    tabsListMenuOpen.value = false
    mdConfigMenuOpen.value = false
    closeTabContextMenu()
    closeEditorBreadcrumbDropdown()
  }
}

function scrollActiveEditorTabIntoView() {
  const list = tabsList.value
  if (!list || !store.activeTabId) return
  const active = list.querySelector<HTMLElement>('.editor-tab.active')
  if (active && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

function handleEditorTabsWheel(event: WheelEvent) {
  const list = tabsList.value
  if (!list || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  if (list.scrollWidth <= list.clientWidth) return
  event.preventDefault()
  list.scrollLeft += event.deltaY * scrollSpeedMultiplier(store.settings.scrollSpeedPercent)
}

function onTabDragStart(event: DragEvent, index: number) {
  event.dataTransfer?.setData('text/plain', String(index))
  event.dataTransfer!.effectAllowed = 'move'
}

function onTabDragOver(event: DragEvent, index: number) {
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'move'
  dragOverTabIndex.value = index
}

function onTabDragLeave() {
  dragOverTabIndex.value = null
}

function onTabDrop(event: DragEvent, toIndex: number) {
  event.preventDefault()
  dragOverTabIndex.value = null
  const fromIndex = Number(event.dataTransfer?.getData('text/plain'))
  if (!Number.isNaN(fromIndex)) store.reorderTab(fromIndex, toIndex)
}

function onTabDragEnd() {
  dragOverTabIndex.value = null
}

function onImageLoad(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  imageNaturalSize.value = {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }
}

function setImageZoom(zoom: number) {
  imageZoom.value = zoom
}

function onImagePreviewWheel(event: WheelEvent) {
  if (!imageNaturalSize.value) return
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
  setImageZoom(Math.min(8, Math.max(0.25, imageZoom.value * factor)))
}

function startImagePreviewDrag(event: PointerEvent) {
  if (event.button !== 0 || !imagePreviewStage.value) return
  event.preventDefault()
  imagePreviewDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: imagePreviewStage.value.scrollLeft,
    scrollTop: imagePreviewStage.value.scrollTop,
  }
  imagePreviewDragging.value = true
  window.addEventListener('pointermove', moveImagePreviewDrag)
  window.addEventListener('pointerup', stopImagePreviewDrag)
  window.addEventListener('pointercancel', stopImagePreviewDrag)
  window.addEventListener('blur', stopImagePreviewDrag)
}

function moveImagePreviewDrag(event: PointerEvent) {
  const drag = imagePreviewDrag
  const stage = imagePreviewStage.value
  if (!drag || !stage || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  stage.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX)
  stage.scrollTop = drag.scrollTop - (event.clientY - drag.startY)
}

function stopImagePreviewDrag() {
  imagePreviewDrag = null
  imagePreviewDragging.value = false
  window.removeEventListener('pointermove', moveImagePreviewDrag)
  window.removeEventListener('pointerup', stopImagePreviewDrag)
  window.removeEventListener('pointercancel', stopImagePreviewDrag)
  window.removeEventListener('blur', stopImagePreviewDrag)
}

function askSaveBeforeClose(tab: EditorTab): Promise<SaveCloseChoice> {
  saveDialogTab.value = tab
  return new Promise((resolve) => {
    saveDialogResolve = resolve
  })
}

function answerSaveDialog(choice: SaveCloseChoice) {
  const resolve = saveDialogResolve
  saveDialogResolve = null
  saveDialogTab.value = null
  resolve?.(choice)
}

async function closeTabsWithPrompt(tabs: EditorTab[]) {
  for (const tab of tabs) {
    const current = store.tabs.find((item) => item.id === tab.id)
    if (!current) continue

    if (current.isDirty && current.contentType === 'text') {
      store.setActiveTab(current.id)
      const choice = await askSaveBeforeClose(current)
      if (choice === 'cancel') return
      if (choice === 'save') {
        const saved = await store.saveTab(current.id)
        if (!saved || current.isDirty) return
      }
    }

    store.closeTab(current.id)
    viewStateCache.delete(current.id)
  }
}

function closeTab(tab: EditorTab) {
  void closeTabsWithPrompt([tab])
}

function closeCurrentTab() {
  closeTabsActionMenu()
  if (!activeTab.value) return
  void closeTabsWithPrompt([activeTab.value])
}

function closeSavedTabs() {
  const savedIds = visibleTabs.value.filter((tab) => !tab.isDirty).map((tab) => tab.id)
  for (const id of savedIds) store.closeTab(id)
  for (const id of savedIds) viewStateCache.delete(id)
}

function closeAllTabs() {
  closeTabsActionMenu()
  void closeTabsWithPrompt([...visibleTabs.value])
}

function addSelectionToChat() {
  const text = selectedText.value.trim()
  const tab = activeTab.value
  if (!text || !tab) return
  const selection = editor?.getSelection()
  const source = selection
    ? formatCodePreviewSelectionSourceForRange(tab.path, selection)
    : `查看选取内容 ${tab.path}`
  window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', {
    detail: { source, text },
  }))
  editor?.focus()
}

function handlePluginEditorInsert(event: Event) {
  const detail = (event as CustomEvent<{ text?: string }>).detail
  const value = detail?.text
  if (value == null || !editor) return
  const selection = editor.getSelection()
  if (!selection) {
    editor.trigger('keyboard', 'type', { text: value })
    return
  }
  editor.executeEdits('superhigh-plugin', [{
    range: selection,
    text: value,
    forceMoveMarkers: true,
  }])
  editor.focus()
}

// 普通 HTML 预览长按：把当前文件绝对路径插入 CLI 输入框。
async function handleHtmlPreviewMessage(event: MessageEvent) {
  const frame = htmlPreviewFrame.value
  const tab = activeTab.value
  if (!frame || event.source !== frame.contentWindow) return
  if (tab && persistHtmlPreviewStorage(tab.path, event.data)) return
  if (tab && event.data?.type === HTML_PREVIEW_OPEN_FILE_MESSAGE) {
    const path = resolveHtmlPreviewResourcePath(tab.path, String(event.data.path ?? ''), store.workspace?.rootPath)
    if (path) await store.openFile(path)
    return
  }
  if (isHtmlPreviewLongPressMessage(event.data) && tab) {
    sendHtmlPreviewPathToChat(tab.path)
    return
  }
  if (event.data?.type === HTML_PREVIEW_DOWNLOAD_MESSAGE && tab) {
    try {
      await saveHtmlPreviewDownload(tab.path, event.data, backend)
    } catch (error) {
      store.showErrorMessage(`HTML 下载失败：${String(error)}`)
    }
    return
  }
  if (!event.data || typeof event.data !== 'object' || event.data.type !== HTML_PREVIEW_RESOURCE_MESSAGE || typeof event.data.requestId !== 'string' || !tab) return
  try {
    const path = resolveHtmlPreviewResourcePath(tab.path, typeof event.data.path === 'string' ? event.data.path : '', store.workspace?.rootPath, event.data.kind === 'media')
    if (!path) throw new Error('HTML 预览资源不在当前工作区内。')
    const payload = event.data.kind === 'text' ? { text: await backend.readFile(path) } : { dataUrl: await backend.readMediaAsDataUrl(path) }
    // A late resource reply must not reach another tab's iframe.
    if (tab !== activeTab.value || frame !== htmlPreviewFrame.value) return
    const response = { type: HTML_PREVIEW_RESOURCE_RESULT_MESSAGE, requestId: event.data.requestId, ...payload }
    if (!replyMobileHtml(response)) frame.contentWindow?.postMessage(response, '*')
  } catch (error) {
    if (tab !== activeTab.value || frame !== htmlPreviewFrame.value) return
    const response = { type: HTML_PREVIEW_RESOURCE_ERROR_MESSAGE, requestId: event.data.requestId, error: error instanceof Error ? error.message : String(error) }
    if (!replyMobileHtml(response)) frame.contentWindow?.postMessage(response, '*')
  }
}

function moveEditorTab(direction: -1 | 1) {
  const tabs = visibleTabs.value
  const index = tabs.findIndex((tab) => tab.id === store.activeTabId)
  if (!tabs.length || index < 0) return
  const nextIndex = (index + direction + tabs.length) % tabs.length
  void store.setActiveTab(tabs[nextIndex].id)
}

function onEditorTabNavigationKeydown(event: KeyboardEvent) {
  const target = event.target
  if (!(target instanceof Element) || !target.closest('.editor-panel') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .tabs-actions, .editor-breadcrumb-strip button')) return
  const focusedControl = target.closest('button, a, [role="button"]')
  if (focusedControl && !focusedControl.classList.contains('editor-tab-main')) return
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && target.closest('.editor-code-region, .image-preview-shell')) return
  const key = event.key.toLowerCase()
  if (key === 'arrowleft' || key === 'a') {
    event.preventDefault()
    moveEditorTab(-1)
  } else if (key === 'arrowright' || key === 'd') {
    event.preventDefault()
    moveEditorTab(1)
  }
}

function pluginPreviewTab(tab: EditorTab) {
  return { path: tab.path, content: tab.content, isDirty: tab.isDirty }
}

function disposePluginPreview() {
  const current = pluginPreview
  pluginPreview = null
  try {
    current?.instance?.dispose?.()
  } catch (error) {
    console.error('[plugin-preview] dispose failed', error)
  }
  current?.host.replaceChildren()
}

// 插件预览：提供者、文件或容器变化时重新挂载，内容变化只通知 update。
function syncPluginPreview() {
  const provider = showPluginPreview.value ? activePluginPreviewProvider.value : null
  const host = pluginPreviewHost.value
  const tab = activeTab.value
  if (!provider || !host || !tab) {
    disposePluginPreview()
    return
  }
  if (pluginPreview?.provider === provider && pluginPreview.path === tab.path && pluginPreview.host === host) {
    pluginPreview.instance?.update?.(pluginPreviewTab(tab))
    return
  }
  disposePluginPreview()
  try {
    pluginPreview = { provider, path: tab.path, host, instance: provider.mount(host, pluginPreviewTab(tab)) || null }
  } catch (error) {
    pluginPreview = { provider, path: tab.path, host, instance: null }
    host.textContent = `预览加载失败：${error instanceof Error ? error.message : String(error)}`
  }
}

watch(
  () => [activePluginPreviewProvider.value, showPluginPreview.value, pluginPreviewHost.value, activeTab.value?.path, activeTab.value?.content],
  () => { void nextTick(syncPluginPreview) },
)

function handlePluginEditorReplaceSelection(event: Event) {
  const detail = (event as CustomEvent<{ text?: string }>).detail
  const value = detail?.text ?? ''
  if (!editor) return
  const selection = editor.getSelection()
  if (!selection) return
  editor.executeEdits('superhigh-plugin', [{
    range: selection,
    text: value,
    forceMoveMarkers: true,
  }])
  editor.focus()
}

let stopMobileHtml: (() => void) | null = null
onMounted(async () => {
  void appDataDirectory().catch(() => undefined)
  stopMobileHtml = registerMobileHtmlPreview(
    () => showHtmlPreview.value && !activeTabIsSuperhighEditorHtml.value ? activeTab.value?.path : undefined,
    () => ({ document: htmlPreviewDocument.value, contextMessages: [] }),
    data => handleHtmlPreviewMessage({ source: htmlPreviewFrame.value?.contentWindow, data } as MessageEvent),
  )
  await nextTick()
  await mountEditor()
  syncEditor()
  syncTheme()
  if (typeof ResizeObserver !== 'undefined' && editorPanel.value) {
    tabsMenuLayoutObserver = new ResizeObserver(() => {
      if (tabsListMenuOpen.value) positionTabsListMenu()
    })
    tabsMenuLayoutObserver.observe(editorPanel.value)
  }
  window.addEventListener('superhigh:editor-menu-command', handleEditorMenuCommand)
  window.addEventListener('superhigh:editor-action', handleEditorAction)
  window.addEventListener('superhigh:reveal-editor-position', handleRevealEditorPosition)
  window.addEventListener('superhigh:plugin-editor-insert', handlePluginEditorInsert)
  window.addEventListener('message', handleHtmlPreviewMessage)
  window.addEventListener('superhigh:plugin-editor-replace-selection', handlePluginEditorReplaceSelection)
  window.addEventListener('superhigh:editor-close-current', handleEditorCloseRequest)
  window.addEventListener('mousedown', onTabsActionWindowMouseDown)
  window.addEventListener('resize', closeTabsListOnResize)
  window.addEventListener('keydown', onTabsActionWindowKeydown)
  window.addEventListener('mousedown', onEditorBreadcrumbWindowClick)
})

watch(() => activeTab.value?.id ?? null, async () => {
  stopImagePreviewDrag()
  imageZoom.value = 1
  imageNaturalSize.value = null
  await nextTick()
  scrollActiveEditorTabIntoView()
  if (showMonacoEditor.value) {
    await mountEditor()
    syncEditor()
    syncTheme()
  } else {
    disposeEditor()
  }
})

watch(() => [activeTab.value?.id, activeTab.value?.content, activeTab.value?.path] as const, ([id, content, path], [previousId, , previousPath]) => {
  if (id !== previousId) return
  // The workspace watcher can reload the current tab without changing its id.
  // Monaco owns its own model, so explicitly apply only disk-originated changes.
  if (!showMonacoEditor.value || !editor || (syncedEditorContent === content && path === previousPath)) return
  syncEditor()
})

watch(showMonacoEditor, async (enabled) => {
  const preserveMarkdownScroll = activeTab.value?.language === 'markdown'
  if (preserveMarkdownScroll) captureMarkdownScrollProgress()
  await nextTick()
  if (enabled) {
    await mountEditor()
    syncEditor()
    syncTheme()
  } else {
    disposeEditor()
  }
  if (preserveMarkdownScroll) await restoreMarkdownScrollProgress()
})

watch(() => store.tabs.map(tab => tab.id), async () => {
  pruneFileModels()
  await nextTick()
  scrollActiveEditorTabIntoView()
})

watch(currentThemeId, () => {
  syncTheme()
})

watch(currentFontStyleId, () => {
  editor?.updateOptions({ fontFamily: getCurrentMonoFontFamily(), fontWeight: getCurrentMonoFontWeight() })
})

watch(() => store.settings.scrollSpeedPercent, (percent) => {
  editor?.updateOptions({ mouseWheelScrollSensitivity: scrollSpeedMultiplier(percent) })
})

watch(renderColorCodesEnabled, () => {
  updateColorCodePreviewDecorations()
})

onBeforeUnmount(() => {
  tabsMenuLayoutObserver?.disconnect()
  stopMobileHtml?.()
  window.removeEventListener('superhigh:editor-menu-command', handleEditorMenuCommand)
  window.removeEventListener('superhigh:editor-action', handleEditorAction)
  window.removeEventListener('superhigh:reveal-editor-position', handleRevealEditorPosition)
  window.removeEventListener('superhigh:plugin-editor-insert', handlePluginEditorInsert)
  window.removeEventListener('message', handleHtmlPreviewMessage)
  disposePluginPreview()
  window.removeEventListener('superhigh:plugin-editor-replace-selection', handlePluginEditorReplaceSelection)
  window.removeEventListener('superhigh:editor-close-current', handleEditorCloseRequest)
  window.removeEventListener('mousedown', onTabsActionWindowMouseDown)
  window.removeEventListener('resize', closeTabsListOnResize)
  window.removeEventListener('keydown', onTabsActionWindowKeydown)
  window.removeEventListener('mousedown', onEditorBreadcrumbWindowClick)
  stopImagePreviewDrag()
  stopYamlTopLevelPanelDrag()
  if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = null }
  store.cancelAutoSave()
  answerSaveDialog('cancel')
  disposeEditor()
  for (const entry of fileModels.values()) entry.model.dispose()
  fileModels.clear()
  viewStateCache.clear()
  panelEntriesCache.clear()
})
</script>

<template>
  <section ref="editorPanel" class="panel editor-panel" :class="{ 'is-tab-preview': previewingTab }" @keydown="onEditorTabNavigationKeydown">
    <div class="tabs-strip">
      <div ref="tabsList" class="editor-tabs-list" @wheel="handleEditorTabsWheel">
        <EditorFileTab
          v-for="(tab, index) in visibleTabs"
          :key="tab.id"
          :tab="tab"
          :class="{ active: store.activeTabId === tab.id, 'drag-over': dragOverTabIndex === index }"
          :draggable="!codePreviewScopePath"
          @contextmenu="openTabContextMenu(tab, $event)"
          @dragstart="onTabDragStart($event, index)"
          @dragover="onTabDragOver($event, index)"
          @dragleave="onTabDragLeave"
          @drop="onTabDrop($event, index)"
          @dragend="onTabDragEnd"
          @select="store.setActiveTab(tab.id)"
          @close="closeTab(tab)"
        />
      </div>
      <div
        v-if="tabContextMenu"
        class="menu-dropdown tab-context-menu"
        :style="tabContextMenuStyle"
        @mousedown.stop
        @click.stop
      >
        <button
          class="menu-item"
          type="button"
          data-testid="tab-copy-relative-path"
          @click="copyTabRelativePath"
        >
          <span><Copy :size="13" /></span>
          <span>复制相对路径</span>
        </button>
        <button
          class="menu-item"
          type="button"
          data-testid="tab-copy-absolute-path"
          @click="copyTabAbsolutePath"
        >
          <span><Copy :size="13" /></span>
          <span>复制完整路径</span>
        </button>
        <button
          class="menu-item"
          type="button"
          data-testid="tab-open-in-explorer"
          @click="openTabInExplorer"
        >
          <span><FolderSearch :size="13" /></span>
          <span>在文件资源管理器中打开</span>
        </button>
        <button
          class="menu-item"
          type="button"
          data-testid="tab-add-relative-path-to-chat"
          @click="addTabRelativePathToChat"
        >
          <span><MessageSquarePlus :size="13" /></span>
          <span>添加到对话框</span>
        </button>
      </div>
      <div ref="tabsActionMenuRoot" class="tabs-actions">
        <button
          v-if="!changePreview && (activeTabIsHtml || activeTabIsSuperhighUi || activePluginPreviewProvider)"
          class="icon-button tabs-html-preview-button"
          :class="{ active: previewEnabled }"
          type="button"
          :aria-pressed="previewEnabled"
          :title="previewEnabled ? `关闭${previewToggleLabel}，切换到代码` : `开启${previewToggleLabel}`"
          @click="togglePreview()"
        >
          <FileCode2 :size="16" />
        </button>
        <button
          class="icon-button tabs-more-button"
          type="button"
          title="文件操作"
          :disabled="!visibleTabs.length"
          @click="toggleTabsActionMenu"
        >
          <Ellipsis :size="17" />
        </button>
        <div v-if="tabsActionMenuOpen" class="menu-dropdown tabs-more-menu">
          <button class="menu-item" type="button" :disabled="!activeTab || !activeTab.isDirty" @click="store.saveActiveTab(); closeTabsActionMenu()">
            <span><Save :size="13" /></span>
            <span>保存</span>
            <span class="context-shortcut">Ctrl+S</span>
          </button>
          <button class="menu-item" type="button" :disabled="!dirtyTabCount" @click="store.saveAllTabs(); closeTabsActionMenu()">
            <span><SaveAll :size="13" /></span>
            <span>保存全部</span>
            <span v-if="dirtyTabCount" class="context-shortcut">{{ dirtyTabCount }}</span>
          </button>
          <button class="menu-item" type="button" :disabled="!activeTabIsText" @click="store.saveTabAs(activeTab!.id); closeTabsActionMenu()">
            <span><Save :size="13" /></span>
            <span>另存为...</span>
          </button>
          <button class="menu-item" type="button" :disabled="!canChangeEncoding" @click="openEncodingMenuFromActions">
            <span />
            <span>文件编码</span>
            <span class="context-shortcut">{{ editorEncodingLabel }}</span>
          </button>
          <div class="file-context-separator" />
          <button class="menu-item" type="button" :disabled="!activeTab" @click="closeCurrentTab">
            <span />
            <span>关闭当前文件</span>
          </button>
          <button class="menu-item" type="button" :disabled="!visibleTabs.length" @click="closeAllTabs">
            <span />
            <span>关闭所有打开文件</span>
          </button>
        </div>
      </div>
      <Teleport to="body">
        <div v-if="tabsListMenuOpen" ref="tabsListMenuEl" class="menu-dropdown tabs-open-list-menu" role="menu" aria-label="已打开的文件" :style="tabsListMenuStyle" @mouseleave="hoveredTabId = null">
          <EditorFileTab
            v-for="tab in visibleTabs"
            :key="tab.id"
            :tab="tab"
            :closable="false"
            listed
            class="tabs-open-list-item"
            :class="{ active: store.activeTabId === tab.id }"
            @mouseenter="hoveredTabId = tab.id"
            @focusin="hoveredTabId = tab.id"
            @select="selectTabFromList(tab)"
          />
        </div>
      </Teleport>
    </div>
    <!-- breadcrumb bar -->
    <div v-if="activeTab" class="editor-breadcrumb-strip">
      <div ref="breadcrumbDropdownRef" class="editor-breadcrumb-inner">
        <template v-for="(crumb, crumbIdx) in editorBreadcrumbs" :key="crumb.path">
          <span v-if="crumbIdx > 0" class="breadcrumb-sep">&rsaquo;</span>
          <button
            class="breadcrumb-segment"
            :class="{ active: breadcrumbDropdownPath === crumb.path }"
            @click.stop="toggleEditorBreadcrumb(crumb.path, $event)"
          >
            {{ crumb.label }}
          </button>
        </template>
        <div
          v-if="breadcrumbDropdownPath"
          ref="breadcrumbDropdownMenuRef"
          class="breadcrumb-dropdown"
          :style="breadcrumbDropdownStyle"
          @click.stop
        >
          <div v-if="breadcrumbDropdownLoading && !breadcrumbDropdownRows.length" class="breadcrumb-dropdown-empty">加载中…</div>
          <template v-else>
            <BreadcrumbFileTreeNode
              v-for="row in breadcrumbDropdownRows"
              :key="`${row.depth}:${row.entry.path}`"
              :entry="row.entry"
              :depth="row.depth"
              :active-path="breadcrumbDropdownActivePath"
              :expanded="row.expanded"
              @directory-open="toggleBreadcrumbDirectoryEntry"
              @file-open="openBreadcrumbFile"
            />
            <div v-if="!breadcrumbDropdownRows.length" class="breadcrumb-dropdown-empty">
              目录为空
            </div>
          </template>
        </div>
      </div>
      <div class="editor-breadcrumb-actions">
        <div v-if="showMarkdownSwitch" ref="mdConfigRoot" class="editor-md-config">
          <button class="editor-md-config-button" type="button" aria-haspopup="menu" :aria-expanded="mdConfigMenuOpen" title="Markdown 配置" @click.stop="mdConfigMenuOpen = !mdConfigMenuOpen">
            <span>MD配置</span><ChevronDown :size="12" />
          </button>
          <div v-if="mdConfigMenuOpen" class="menu-dropdown editor-md-config-menu" role="menu">
            <button
              class="editor-md-config-item"
              :class="{ active: store.markdownPreviewEnabled }"
              type="button"
              role="menuitemcheckbox"
              :aria-checked="store.markdownPreviewEnabled"
              @click="store.toggleMarkdownPreview()"
            >
              <span>渲染</span><i aria-hidden="true" />
            </button>
            <button
              class="editor-md-config-item"
              :class="{ active: store.settings.yamlKeyValuePanelEnabled }"
              type="button"
              role="menuitemcheckbox"
              :aria-checked="store.settings.yamlKeyValuePanelEnabled"
              @click="toggleKeyValuePanel"
            >
              <span>键值</span><i aria-hidden="true" />
            </button>
          </div>
        </div>
        <button
          v-if="showKeyValueSwitch && !showMarkdownSwitch"
          class="editor-mode-switch editor-key-value-switch"
          :class="{ active: store.settings.yamlKeyValuePanelEnabled }"
          type="button"
          role="switch"
          :aria-checked="store.settings.yamlKeyValuePanelEnabled"
          :title="`${store.settings.yamlKeyValuePanelEnabled ? '关闭' : '打开'} ${keyValuePanelLabel}`"
          @click="toggleKeyValuePanel"
        >
          <span>{{ keyValuePanelLabel }}</span><i aria-hidden="true" />
        </button>
        <div v-if="activeTab && (showEncodingBadge || encodingMenuOpen)" ref="encodingControlRoot" class="editor-encoding-control">
          <button
            class="editor-encoding-button"
            type="button"
            :aria-expanded="encodingMenuOpen"
            :title="`文件编码：${editorEncodingLabel}`"
            @click.stop="toggleEncodingMenu()"
          >{{ editorEncodingLabel }}</button>
          <div v-if="encodingMenuOpen" class="menu-dropdown editor-encoding-menu" role="menu">
            <div class="editor-encoding-menu-actions">
              <button type="button" :class="{ active: encodingMenuMode === 'reopen' }" @click="openEncodingMenu('reopen')">重新打开</button>
              <button type="button" :disabled="activeTab.contentType !== 'text'" :class="{ active: encodingMenuMode === 'save' }" @click="openEncodingMenu('save')">按编码保存</button>
            </div>
            <button
              v-for="option in editorEncodingOptions"
              :key="option.value"
              class="menu-item"
              type="button"
              role="menuitem"
              :class="{ active: activeTab.encoding === option.value }"
              :disabled="encodingMenuMode === 'save' && activeTab.contentType !== 'text'"
              @click="chooseEditorEncoding(option.value)"
            >
              <span />
              <span>{{ option.label }}</span>
              <span v-if="activeTab.encoding === option.value" class="context-shortcut">当前</span>
            </button>
          </div>
        </div>
        <button
          ref="tabsListButton"
          class="icon-button tabs-open-list-button"
          type="button"
          title="打开文件标签列表"
          aria-label="打开文件标签列表"
          :aria-expanded="tabsListMenuOpen"
          :disabled="!visibleTabs.length"
          @click="toggleTabsListMenu"
        >
          <List :size="14" />
        </button>
      </div>
    </div>

    <div v-if="changePreview" class="change-view-toolbar" aria-label="文件查看方式">
      <button v-if="changeHasUiPreview" type="button" :aria-pressed="!showChangeDiff && !changePreview.sourceOnly" @click="changePreview.showingDiff = false; changePreview.sourceOnly = false; store.superhighUiPreviewEnabled = true">界面预览</button>
      <button type="button" :aria-pressed="!showChangeDiff && !!changePreview.sourceOnly" @click="showCurrentSource">当前源码</button>
      <button type="button" :aria-pressed="showChangeDiff" @click="changePreview.showingDiff = true">改动差异</button>
      <button v-if="showChangeDiff && !changePreview.loading && !changePreview.reason && !changePreview.error" type="button" :aria-pressed="showUnchangedCode" @click="showUnchangedCode = !showUnchangedCode">{{ showUnchangedCode ? '折叠未改动代码' : '展开全部代码' }}</button>
    </div>
    <div v-if="!activeTab" class="empty-editor">
      <div>从左侧文件树或顶部搜索打开文件。</div>
    </div>

    <div v-else-if="showChangeDiff && changePreview" class="editor-change-preview">
      <div v-if="changePreview.loading" class="change-preview-message">正在读取改动差异…</div>
      <div v-else-if="changePreview.error || changePreview.reason" class="change-preview-message" role="status">{{ changePreview.error || changePreview.reason }}</div>
      <GitDiffViewer v-else :key="changePreview.requestId" :path="activeTab.path" :old-text="changePreview.oldText" :new-text="changePreview.newText" :show-unchanged="showUnchangedCode" />
    </div>
    <div v-else-if="activeTabIsImage" class="image-preview-shell">
      <div class="image-preview-toolbar">
        <button
          v-for="zoom in imageZoomPresets"
          :key="zoom"
          class="image-zoom-button"
          :class="{ active: imageZoom === zoom }"
          type="button"
          @click="setImageZoom(zoom)"
        >
          {{ Math.round(zoom * 100) }}%
        </button>
        <span v-if="imageNaturalSize" class="image-size-label">
          {{ imageNaturalSize.width }} × {{ imageNaturalSize.height }}
        </span>
      </div>
      <div
        ref="imagePreviewStage"
        class="image-preview-stage"
        :class="{ dragging: imagePreviewDragging }"
        @wheel="onImagePreviewWheel"
      >
        <img
          :src="activeTab.content"
          :alt="activeTab.name"
          class="image-preview-img"
          :style="imageStyle"
          draggable="false"
          @load="onImageLoad"
          @error="activeTab.contentType = 'unsupported'; activeTab.content = '图片无法解码，请选择其他应用打开。'"
          @pointerdown="startImagePreviewDrag"
        />
      </div>
    </div>
    <EditorMediaPreview v-else-if="activeTab.contentType === 'media'" :key="activeTab.id" :path="activeTab.path" :source="activeTab.content" />
    <PdfPreview v-else-if="activeTab.contentType === 'office' && extensionFromPath(activeTab.path) === '.pdf'" :key="activeTab.id" :path="activeTab.path" :content="activeTab.content" />
    <PresentationPreview v-else-if="activeTab.contentType === 'office' && isPresentationDocument(activeTab.path)" :key="activeTab.id" :path="activeTab.path" :content="activeTab.content" />
    <OfficePreview v-else-if="activeTab.contentType === 'office'" :key="activeTab.id" :path="activeTab.path" :content="activeTab.content" />
    <div v-else-if="showMarkdownPreview" class="editor-code-region markdown-key-value-region">
      <MarkdownFilePreview ref="markdownPreview" :html="renderedMarkdown" @navigate="handleMarkdownClick" />
      <div
        v-if="keyValuePanelEntries.length"
        class="yaml-top-level-panel"
        :class="{ 'markdown-heading-panel': activeTab?.language === 'markdown' }"
        :style="yamlTopLevelPanelStyle"
        @wheel.stop
      >
        <div
          class="yaml-top-level-drag-handle"
          :title="`拖动 ${keyValuePanelLabel} 键值面板`"
          @pointerdown="startYamlTopLevelPanelDrag"
        >
          <GripHorizontal :size="15" />
        </div>
        <div class="yaml-top-level-search">
          <Search :size="12" aria-hidden="true" />
          <input
            v-model="keyValuePanelQuery"
            type="text"
            :placeholder="`搜索${keyValuePanelLabel}`"
            :aria-label="`搜索${keyValuePanelLabel}`"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="yaml-top-level-list" :role="activeTab?.language === 'markdown' ? 'tree' : undefined">
          <div v-if="!filteredKeyValuePanelEntries.length" class="yaml-top-level-empty">无匹配项</div>
          <button
            v-for="key in filteredKeyValuePanelEntries"
            :key="`${key.lineNumber}:${key.startColumn}:${key.keyName}`"
            type="button"
            class="yaml-top-level-key"
            :class="{ 'markdown-heading-key': isMarkdownHeadingEntry(key) }"
            :style="keyValuePanelEntryStyle(key)"
            :aria-level="isMarkdownHeadingEntry(key) ? key.level : undefined"
            :role="isMarkdownHeadingEntry(key) ? 'treeitem' : undefined"
            :title="`第 ${key.lineNumber} 行：${key.keyName}`"
            @click="revealKeyValuePanelEntry(key)"
          >
            <span class="markdown-heading-title">{{ key.keyName }}</span>
          </button>
        </div>
      </div>
    </div>
    <SuperhighHtmlPreview v-else-if="showHtmlPreview && activeTabIsSuperhighEditorHtml && activeTab" :tab="activeTab" />
    <div v-else-if="showHtmlPreview" class="html-preview-shell">
      <iframe v-if="htmlPreviewDocument" ref="htmlPreviewFrame" class="html-preview-frame" :srcdoc="htmlPreviewDocument" sandbox="allow-scripts allow-downloads allow-modals" title="HTML 预览" />
    </div>
    <SuperhighUiPreview v-else-if="showSuperhighUiPreview && activeTab" :tab="activeTab" />
    <div v-else-if="showPluginPreview" ref="pluginPreviewHost" class="html-preview-shell plugin-preview-shell" />
    <div v-else-if="activeTabIsUnsupported" class="unsupported-preview-shell">
      <div class="unsupported-preview-panel">
        <div class="unsupported-preview-title">无法预览此文件</div>
        <div class="unsupported-preview-path">{{ activeTab.path }}</div>
        <div class="unsupported-preview-message">{{ activeTab.content }}</div>
        <FileOpenActions :key="activeTab.path" :path="activeTab.path" />
      </div>
    </div>
    <div v-else class="editor-host-shell">
      <div v-if="activeTabHasConflict" class="file-conflict-banner">
        <AlertTriangle :size="14" />
        <span>磁盘上的文件已更改。保存可覆盖磁盘版本，关闭再重新打开可获取最新内容。</span>
        <button type="button" class="conflict-action-btn" @click="store.saveActiveTab()">
          <Save :size="12" />
          <span>覆盖磁盘</span>
        </button>
        <button type="button" class="conflict-action-btn" @click="store.reloadActiveTabFromDisk()">
          <span>重新读取</span>
        </button>
      </div>
      <button
        v-if="yamlSyntaxIssues.length"
        type="button"
        class="yaml-error-banner"
        @click="revealYamlSyntaxIssue(yamlSyntaxIssues[0])"
      >
        <AlertTriangle :size="14" />
        <span>{{ yamlSyntaxIssues[0].message }}</span>
        <strong v-if="yamlSyntaxIssues.length > 1">还有 {{ yamlSyntaxIssues.length - 1 }} 个错误</strong>
      </button>
      <div class="editor-code-region">
        <div
          v-if="keyValuePanelEntries.length"
          class="yaml-top-level-panel"
          :class="{ 'markdown-heading-panel': activeTab?.language === 'markdown' }"
          :style="yamlTopLevelPanelStyle"
          @wheel.stop
        >
          <div
            class="yaml-top-level-drag-handle"
            :title="`拖动 ${keyValuePanelLabel} 键值面板`"
            @pointerdown="startYamlTopLevelPanelDrag"
          >
            <GripHorizontal :size="15" />
          </div>
          <div class="yaml-top-level-search">
            <Search :size="12" aria-hidden="true" />
            <input
              v-model="keyValuePanelQuery"
              type="text"
              :placeholder="`搜索${keyValuePanelLabel}`"
              :aria-label="`搜索${keyValuePanelLabel}`"
              spellcheck="false"
              autocomplete="off"
            />
          </div>
          <div class="yaml-top-level-list" :role="activeTab?.language === 'markdown' ? 'tree' : undefined">
            <div v-if="!filteredKeyValuePanelEntries.length" class="yaml-top-level-empty">无匹配项</div>
            <button
              v-for="key in filteredKeyValuePanelEntries"
              :key="`${key.lineNumber}:${key.startColumn}:${key.keyName}`"
              type="button"
              class="yaml-top-level-key"
              :class="{ 'markdown-heading-key': isMarkdownHeadingEntry(key) }"
              :style="keyValuePanelEntryStyle(key)"
              :aria-level="isMarkdownHeadingEntry(key) ? key.level : undefined"
              :role="isMarkdownHeadingEntry(key) ? 'treeitem' : undefined"
              :title="`第 ${key.lineNumber} 行：${key.keyName}`"
              @click="revealKeyValuePanelEntry(key)"
            >
              <span class="markdown-heading-title">{{ key.keyName }}</span>
            </button>
          </div>
        </div>
        <div ref="editorHost" class="monaco-host" />
        <button
          v-if="selectedText.trim()"
          type="button"
          class="add-selection-button"
          @click="addSelectionToChat"
        >
          <MessageSquarePlus :size="13" />
          <span>添加到对话框</span>
        </button>
      </div>
    </div>

    <EditorFindDialog
      ref="findDialog"
      v-model:open="findDialogOpen"
      :mode="findDialogMode"
      :get-editor="findDialogEditor"
      :tabs="store.tabs"
      :workspace-root="store.workspace?.rootPath ?? null"
      :active-path="activeTab?.path ?? null"
      :apply-tab-content="applyFindDialogTabContent"
      @navigate="navigateFromFindDialog"
    />

    <div v-if="saveDialogTab" class="save-dialog-backdrop">
      <div class="save-dialog" role="dialog" aria-modal="true" aria-labelledby="save-dialog-title">
        <div class="save-dialog-titlebar">
          <span id="save-dialog-title">保存</span>
          <button class="save-dialog-window-close" type="button" @click="answerSaveDialog('cancel')">
            <X :size="15" />
          </button>
        </div>
        <div class="save-dialog-body">
          <div class="save-dialog-icon">?</div>
          <div class="save-dialog-message">
            是否保存文件 "{{ saveDialogTab.path }}"？
          </div>
        </div>
        <div class="save-dialog-actions">
          <button type="button" class="save-dialog-button primary" @click="answerSaveDialog('save')">
            <Save :size="13" />
            <span>是(Y)</span>
          </button>
          <button type="button" class="save-dialog-button" @click="answerSaveDialog('discard')">
            <X :size="13" />
            <span>否(N)</span>
          </button>
          <button type="button" class="save-dialog-button" @click="answerSaveDialog('cancel')">
            <X :size="13" />
            <span>取消</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor-change-preview { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.change-preview-message { padding: 10px; color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.change-view-toolbar { display: flex; flex: none; align-items: center; gap: 4px; min-width: 0; padding: 4px 8px; overflow-x: auto; border-bottom: 1px solid var(--color-border); }
.change-view-toolbar button { flex: none; height: 25px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-secondary); color: var(--color-text-secondary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.change-view-toolbar button:hover, .change-view-toolbar button[aria-pressed="true"] { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.editor-breadcrumb-strip {
  flex: none;
  position: relative;
  display: flex;
  align-items: center;
  padding: 4px 10px;
  min-height: 28px;
  border-bottom: 1px solid var(--surface-divider-muted);
  background: var(--color-bg-primary);
}

.editor-breadcrumb-inner {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 1px;
  position: relative;
}

.editor-breadcrumb-inner :deep(.breadcrumb-segment) {
  height: 20px;
  max-width: 190px;
  padding: 0 5px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: var(--sh-weight-emphasis);
  outline: 0;
}

.editor-breadcrumb-inner :deep(.breadcrumb-segment:hover),
.editor-breadcrumb-inner :deep(.breadcrumb-segment.active) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.editor-breadcrumb-inner :deep(.breadcrumb-sep) {
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: var(--sh-weight-heading);
  opacity: 0.72;
}

.editor-breadcrumb-actions { display: inline-flex; align-items: center; gap: 6px; flex: none; margin-left: 8px; }
.editor-mode-switch { display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: none; width: 74px; height: 21px; padding: 0 6px; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); background: var(--color-bg-secondary); cursor: pointer; font: inherit; font-size: 10px; z-index: 1; }
.editor-mode-switch:hover, .editor-mode-switch.active { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.editor-mode-switch i, .editor-md-config-item i { position: relative; display: block; width: 18px; height: 10px; flex: none; border-radius: 5px; background: var(--color-border); }
.editor-mode-switch i::after, .editor-md-config-item i::after { position: absolute; top: 2px; left: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--color-text-secondary); content: ''; transition: transform 120ms ease; }
.editor-mode-switch.active i, .editor-md-config-item.active i { background: var(--color-accent-blue); }
.editor-mode-switch.active i::after, .editor-md-config-item.active i::after { transform: translateX(8px); background: var(--color-bg-primary); }
.editor-encoding-control { position: relative; flex: none; }
.editor-md-config { position: relative; flex: none; }
.editor-md-config-button { display: inline-flex; align-items: center; justify-content: center; gap: 3px; flex: none; height: 21px; padding: 0 6px; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); background: var(--color-bg-secondary); cursor: pointer; font: inherit; font-size: 10px; }
.editor-md-config-button:hover, .editor-md-config-button[aria-expanded="true"] { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.editor-md-config-menu { position: absolute; top: calc(100% + 4px); right: 0; left: auto; width: max-content; min-width: 112px; z-index: 95; }
.editor-md-config-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 26px; padding: 0 8px; border: 0; background: transparent; color: var(--color-text-primary); cursor: pointer; font: inherit; font-size: 12px; text-align: left; }
.editor-md-config-item:hover { background: var(--color-bg-hover); }
.editor-encoding-button { min-height: 26px; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--surface-panel-soft); color: var(--color-text-secondary); font-size: 11px; cursor: pointer; }
.editor-encoding-button:hover, .editor-encoding-button[aria-expanded="true"] { background: var(--surface-panel-strong); color: var(--color-text-primary); }
.editor-encoding-menu { position: absolute; top: calc(100% + 4px); right: 0; left: auto; width: max-content; min-width: 214px; max-width: min(320px, calc(100vw - 48px)); max-height: min(420px, 70vh); overflow-y: auto; z-index: 95; }
.editor-encoding-menu-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 6px; border-bottom: 1px solid var(--surface-divider-soft); }
.editor-encoding-menu-actions button { min-height: 27px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--color-text-secondary); font-size: 11px; cursor: pointer; }
.editor-encoding-menu-actions button.active { border-color: var(--color-border); background: var(--surface-panel-strong); color: var(--color-text-primary); }
.editor-encoding-menu-actions button:disabled { opacity: .45; cursor: default; }
</style>
