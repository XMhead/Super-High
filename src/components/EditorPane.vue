<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { loadMonaco, getMonaco, type Monaco } from '@/lib/monaco'
import type * as MonacoTypes from 'monaco-editor'
import { AlertTriangle, Copy, Ellipsis, FileCode2, GripHorizontal, MessageSquarePlus, Save, SaveAll, TerminalSquare, X } from 'lucide-vue-next'

import { buildColorCodePreviewRanges, colorCodePreviewClassName, colorCodePreviewStyleRule } from '@/lib/colorCodePreview'
import { buildExternalLinkBridgeScript } from '@/lib/externalLinks'
import { renderMarkdown } from '@/lib/markdown'
import { buildWorkspaceBreadcrumbs, extensionFromPath, inferLanguage, normalizePath } from '@/lib/path'
import { formatCodePreviewSelectionSourceForRange } from '@/lib/selectionChat'
import { registerEditorTabCompletion } from '@/lib/tabCompletion'
import { toMonacoThemeDefinition } from '@/lib/theme'
import {
  buildYamlKeyIndex,
  findYamlKeyValueLine,
  nextKeyOccurrence,
  parseYamlSyntaxIssues,
  scanYamlTopLevelKeys,
  type YamlKeySpan,
  type YamlSyntaxIssue,
} from '@/lib/yamlPreview'
import type { EditorTab, FileEntry } from '@/types'
import BreadcrumbFileTreeNode from './BreadcrumbFileTreeNode.vue'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'
import OfficePreview from './OfficePreview.vue'
import EditorMediaPreview from './EditorMediaPreview.vue'
import FileOpenActions from './FileOpenActions.vue'
const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'))

import { useWorkspaceStore } from '@/stores/workspace'

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
const imagePreviewDragging = ref(false)
const saveDialogTab = ref<EditorTab | null>(null)
const tabsActionMenuOpen = ref(false)
const tabsActionMenuRoot = ref<HTMLElement | null>(null)
const tabContextMenu = ref<{ tab: EditorTab; x: number; y: number } | null>(null)
const dragOverTabIndex = ref<number | null>(null)
const yamlSyntaxIssues = ref<YamlSyntaxIssue[]>([])
const yamlTopLevelPanelOffset = ref({ x: 0, y: 0 })
let editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null
let syncing = false
let lastSyncedTabId: string | null = null
let saveDialogResolve: ((choice: SaveCloseChoice) => void) | null = null
let revealTimer: number | null = null
let yamlTopLevelPanelDrag: { startX: number; startY: number; originX: number; originY: number; moved: boolean } | null = null
let imagePreviewDrag: { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null = null
const viewStateCache = new Map<string, MonacoTypes.editor.ICodeEditorViewState>()

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
	if (breadcrumbDropdownRef.value?.contains(event.target as Node)) return
	closeEditorBreadcrumbDropdown()
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

const EDITOR_ACTIONS: Record<EditorActionCommand, string> = {
  find: 'actions.find',
  replace: 'editor.action.startFindReplaceAction',
  gotoLine: 'editor.action.gotoLine',
  symbols: 'editor.action.quickOutline',
}

const activeTab = computed(() => store.activeTab)
const codePreviewScopePath = computed(() => store.codePreviewScopePath)
const visibleTabs = computed(() => {
  const scopePath = codePreviewScopePath.value?.replace(/\/+$/, '').toLowerCase()
  if (!scopePath) return store.tabs
  return store.tabs.filter((tab) => {
    const path = normalizePath(tab.path).toLowerCase()
    return path.startsWith(`${scopePath}/`)
  })
})
const currentThemeId = computed(() => store.currentThemeId)
const renderColorCodesEnabled = computed(() => store.settings.renderColorCodes)
const imageZoomPresets = [0.25, 0.5, 0.75, 1, 2, 4]
const activeTabIsText = computed(() => activeTab.value?.contentType === 'text')
const activeTabIsImage = computed(() => activeTab.value?.contentType === 'image')
const activeTabIsUnsupported = computed(() => activeTab.value?.contentType === 'unsupported')
const showMarkdownPreview = computed(() => activeTabIsText.value && store.markdownPreviewEnabled && activeTab.value?.language === 'markdown')
const activeTabIsHtml = computed(() => activeTabIsText.value && extensionFromPath(activeTab.value?.path ?? '') === '.html')
const activeTabIsSuperhighEditorHtml = computed(() => {
  const path = normalizePath(activeTab.value?.path ?? '').toLowerCase()
  return activeTabIsHtml.value && path.includes('/.superhigh/editor/')
})
const showHtmlPreview = computed(() => activeTabIsHtml.value && store.settings.htmlPreviewEnabled)
const showMonacoEditor = computed(() => activeTabIsText.value && !showMarkdownPreview.value && !showHtmlPreview.value)
const showDragonCoreQuickCliButton = computed(() => store.activeWorkspaceSurface === 'minecraft' && store.dragonCoreModeOpen)
const activeTabHasConflict = computed(() => {
  if (!activeTab.value) return false
  return !!store.fileConflictPaths[normalizePath(activeTab.value.path).toLowerCase()]
})
const dirtyTabCount = computed(() => visibleTabs.value.filter((tab) => tab.contentType === 'text' && tab.isDirty).length)
const renderedMarkdown = computed(() => renderMarkdown(activeTab.value?.content))
const htmlPreviewDocument = computed(() => buildHtmlPreviewDocument(activeTab.value?.content ?? ''))
const tabContextMenuStyle = computed<CSSProperties>(() => ({
  left: `${tabContextMenu.value?.x ?? 0}px`,
  top: `${tabContextMenu.value?.y ?? 0}px`,
}))
const yamlTopLevelKeys = computed(() => {
  if (!store.settings.yamlKeyValuePanelEnabled || !activeTabIsText.value || activeTab.value?.language !== 'yaml') return []
  return scanYamlTopLevelKeys(activeTab.value.content)
})
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
const MONACO_THEME_ID = 'super-high-dynamic'
/** 代码预览区底部至少多出的可滚动行数（与 lineHeight 相乘），便于最后一行滚到视野上方 */
const MONACO_EXTRA_BOTTOM_SCROLL_LINES = 50
const MONACO_LINE_HEIGHT_PX = 20
const YAML_MARKER_OWNER = 'super-high-yaml'
let yamlDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let yamlSyntaxDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let colorCodeDecorations: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let colorCodeStyleElement: HTMLStyleElement | null = null

// 给普通 HTML 预览注入外链桥接脚本，让网页链接交给系统浏览器。
function buildHtmlPreviewDocument(source: string): string {
  const bridge = `<script id="superhigh-external-link-bridge">${buildExternalLinkBridgeScript()}<\/script>`
  return /<\/body\s*>/i.test(source)
    ? source.replace(/<\/body\s*>/i, `${bridge}</body>`)
    : `${source}${bridge}`
}

async function mountEditor() {
  if (!editorHost.value || editor) return
  const monaco = await loadMonaco()
  if (!editorHost.value || editor) return
  registerEditorTabCompletion(monaco)
  monaco.editor.defineTheme(MONACO_THEME_ID, toMonacoThemeDefinition(currentThemeId.value))
  editor = monaco.editor.create(editorHost.value, {
    value: activeTab.value?.content ?? '',
    language: editorLanguageForTab(activeTab.value),
    theme: MONACO_THEME_ID,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: MONACO_LINE_HEIGHT_PX,
    roundedSelection: false,
    scrollBeyondLastLine: false,
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
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void store.saveActiveTab()
  })
  yamlDecorations = editor.createDecorationsCollection()
  yamlSyntaxDecorations = editor.createDecorationsCollection()
  colorCodeDecorations = editor.createDecorationsCollection()
  editor.onDidChangeModelContent(() => {
    if (syncing) return
    store.updateActiveTabContent(editor?.getValue() ?? '')
    updateEditorDecorations()
  })
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
    if (activeTab.value?.language !== 'yaml') return
    const model = editor?.getModel()
    if (!model) return
    const line = model.getLineContent(target.position.lineNumber)
    const column = target.position.column - 1
    // Find which key span this column falls under
    const index = buildYamlKeyIndex(model.getValue())
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

function editorLanguageForTab(tab: EditorTab | null): string {
  if (!tab) return 'plaintext'
  return tab.contentType === 'text' ? inferLanguage(tab.path) : tab.language
}

function buildYamlKeyValueDecorations(model: MonacoTypes.editor.ITextModel): MonacoTypes.editor.IModelDeltaDecoration[] {
  const monaco = getMonaco()
  if (!monaco) return []
  const decorations: MonacoTypes.editor.IModelDeltaDecoration[] = []
  let activeBlockParentIndent: number | null = null

  for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
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
  updateYamlSyntaxMarkers(model)
}

function updateYamlSyntaxMarkers(model: MonacoTypes.editor.ITextModel) {
  const monaco = getMonaco()
  if (!monaco) return

  const issues = parseYamlSyntaxIssues(model.getValue())
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

  const ranges = buildColorCodePreviewRanges(model.getValue())
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

function updateEditorDecorations() {
  updateYamlKeyValueDecorations()
  updateColorCodePreviewDecorations()
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
  saveCurrentViewState()
  syncing = true
  try {
    const model = editor.getModel()
    const language = editorLanguageForTab(activeTab.value)
    if (model) {
      monaco.editor.setModelLanguage(model, language)
      if (model.getValue() !== activeTab.value.content) {
        model.setValue(activeTab.value.content)
      }
    }
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
  monaco.editor.defineTheme(MONACO_THEME_ID, toMonacoThemeDefinition(currentThemeId.value))
  monaco.editor.setTheme(MONACO_THEME_ID)
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
  instance.setPosition({ lineNumber: issue.lineNumber, column: issue.column })
  instance.revealLineInCenter(issue.lineNumber)
  instance.focus()
}

async function revealYamlTopLevelKey(key: YamlKeySpan) {
  const instance = await ensureEditorReady()
  const model = instance?.getModel()
  if (!instance || !model) return

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
  if (tabsActionMenuOpen.value) {
    if (tabsActionMenuRoot.value?.contains(event.target as Node)) return
    closeTabsActionMenu()
  }
}

function onTabsActionWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeTabsActionMenu()
    closeTabContextMenu()
    closeEditorBreadcrumbDropdown()
  }
}

function scrollActiveEditorTabIntoView() {
  const list = tabsList.value
  if (!list || !store.activeTabId) return
  const active = list.querySelector<HTMLElement>('.editor-tab.active')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function handleEditorTabsWheel(event: WheelEvent) {
  const list = tabsList.value
  if (!list || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  if (list.scrollWidth <= list.clientWidth) return
  event.preventDefault()
  list.scrollLeft += event.deltaY
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
        if (!saved) return
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

function openDragonCoreQuickCliDialog() {
  window.dispatchEvent(new CustomEvent('superhigh:open-dragoncore-cli-dialog'))
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

onMounted(async () => {
  await nextTick()
  await mountEditor()
  syncEditor()
  syncTheme()
  window.addEventListener('superhigh:editor-menu-command', handleEditorMenuCommand)
  window.addEventListener('superhigh:editor-action', handleEditorAction)
  window.addEventListener('superhigh:reveal-editor-position', handleRevealEditorPosition)
  window.addEventListener('superhigh:plugin-editor-insert', handlePluginEditorInsert)
  window.addEventListener('superhigh:plugin-editor-replace-selection', handlePluginEditorReplaceSelection)
  window.addEventListener('superhigh:editor-close-current', handleEditorCloseRequest)
  window.addEventListener('mousedown', onTabsActionWindowMouseDown)
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

watch(() => activeTab.value?.content, (content) => {
  // The workspace watcher can reload the current tab without changing its id.
  // Monaco owns its own model, so explicitly apply only disk-originated changes.
  if (!showMonacoEditor.value || !editor || editor.getValue() === content) return
  syncEditor()
})

watch(showMonacoEditor, async (enabled) => {
  await nextTick()
  if (enabled) {
    await mountEditor()
    syncEditor()
    syncTheme()
  } else {
    disposeEditor()
  }
})

watch(() => store.tabs.length, async () => {
  await nextTick()
  scrollActiveEditorTabIntoView()
})

watch(currentThemeId, () => {
  syncTheme()
})

watch(renderColorCodesEnabled, () => {
  updateColorCodePreviewDecorations()
})

onBeforeUnmount(() => {
  window.removeEventListener('superhigh:editor-menu-command', handleEditorMenuCommand)
  window.removeEventListener('superhigh:editor-action', handleEditorAction)
  window.removeEventListener('superhigh:reveal-editor-position', handleRevealEditorPosition)
  window.removeEventListener('superhigh:plugin-editor-insert', handlePluginEditorInsert)
  window.removeEventListener('superhigh:plugin-editor-replace-selection', handlePluginEditorReplaceSelection)
  window.removeEventListener('superhigh:editor-close-current', handleEditorCloseRequest)
  window.removeEventListener('mousedown', onTabsActionWindowMouseDown)
  window.removeEventListener('keydown', onTabsActionWindowKeydown)
  window.removeEventListener('mousedown', onEditorBreadcrumbWindowClick)
  stopImagePreviewDrag()
  stopYamlTopLevelPanelDrag()
  if (revealTimer) { window.clearTimeout(revealTimer); revealTimer = null }
  store.cancelAutoSave()
  answerSaveDialog('cancel')
  disposeEditor()
})
</script>

<template>
  <section class="panel editor-panel">
    <div class="tabs-strip">
      <div ref="tabsList" class="editor-tabs-list" @wheel="handleEditorTabsWheel">
        <div
          v-for="(tab, index) in visibleTabs"
          :key="tab.id"
          class="editor-tab"
          :class="{ active: store.activeTabId === tab.id, 'drag-over': dragOverTabIndex === index }"
          :draggable="!codePreviewScopePath"
          @contextmenu="openTabContextMenu(tab, $event)"
          @dragstart="onTabDragStart($event, index)"
          @dragover="onTabDragOver($event, index)"
          @dragleave="onTabDragLeave"
          @drop="onTabDrop($event, index)"
          @dragend="onTabDragEnd"
        >
          <button class="editor-tab-main" :title="tab.path" @click="store.setActiveTab(tab.id)">
            <span class="tab-file-icon" aria-hidden="true" />
            <span class="tab-name">{{ tab.name }}</span>
            <span v-if="tab.isDirty" class="dirty-dot" />
          </button>
          <button class="tab-close" type="button" title="关闭" @click.stop="closeTab(tab)">×</button>
        </div>
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
          data-testid="tab-add-relative-path-to-chat"
          @click="addTabRelativePathToChat"
        >
          <span><MessageSquarePlus :size="13" /></span>
          <span>添加到对话框</span>
        </button>
      </div>
      <div ref="tabsActionMenuRoot" class="tabs-actions">
        <button
          v-if="activeTabIsHtml"
          class="icon-button tabs-html-preview-button"
          :class="{ active: store.settings.htmlPreviewEnabled }"
          type="button"
          :aria-pressed="store.settings.htmlPreviewEnabled"
          :title="store.settings.htmlPreviewEnabled ? '关闭 HTML 预览，切换到代码' : '开启 HTML 预览'"
          @click="store.toggleHtmlPreview()"
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
        <button
          v-if="showDragonCoreQuickCliButton"
          class="icon-button tabs-dragoncore-cli-button"
          type="button"
          title="打开 DragonCore 快捷 CLI"
          aria-label="打开 DragonCore 快捷 CLI"
          data-testid="dragoncore-quick-cli-button"
          @click="openDragonCoreQuickCliDialog"
        >
          <TerminalSquare :size="16" />
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
    </div>

    <div v-if="!activeTab" class="empty-editor">
      <div>从左侧文件树或顶部搜索打开文件。</div>
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
    <OfficePreview v-else-if="activeTab.contentType === 'office'" :key="activeTab.id" :path="activeTab.path" :content="activeTab.content" />
    <div v-else-if="showMarkdownPreview" class="markdown-preview markdown-body" v-html="renderedMarkdown" />
    <SuperhighHtmlPreview v-else-if="showHtmlPreview && activeTabIsSuperhighEditorHtml && activeTab" :tab="activeTab" />
    <div v-else-if="showHtmlPreview" class="html-preview-shell">
      <iframe class="html-preview-frame" :srcdoc="htmlPreviewDocument" sandbox="allow-scripts" title="HTML 预览" />
    </div>
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
          v-if="yamlTopLevelKeys.length"
          class="yaml-top-level-panel"
          :style="yamlTopLevelPanelStyle"
          @wheel.stop
        >
          <div
            class="yaml-top-level-drag-handle"
            title="拖动 YAML 键值面板"
            @pointerdown="startYamlTopLevelPanelDrag"
          >
            <GripHorizontal :size="15" />
          </div>
          <div class="yaml-top-level-list">
            <button
              v-for="key in yamlTopLevelKeys"
              :key="`${key.lineNumber}:${key.startColumn}:${key.keyName}`"
              type="button"
              class="yaml-top-level-key"
              :title="`第 ${key.lineNumber} 行：${key.keyName}`"
              @click="revealYamlTopLevelKey(key)"
            >
              {{ key.keyName }}
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
            是否保存文件 “{{ saveDialogTab.path }}”？
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
.editor-breadcrumb-strip {
  flex: none;
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
  font-weight: 600;
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
  font-weight: 700;
  opacity: 0.72;
}
</style>
