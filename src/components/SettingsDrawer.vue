<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Component } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  ChartColumn,
  BookOpen,
  CheckSquare,
  Clock3,
  Copy,
  ChevronDown,
  Database,
  FileCode2,
  FolderOpen,
  Github,
  KeyRound,
  Keyboard,
  LogIn,
  SlidersHorizontal,
  Settings,
  Palette,
  Power,
  PowerOff,
  Puzzle,
  RadioTower,
  RefreshCw,
  Search,
  Smartphone,
  TerminalSquare,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-vue-next'

import { CLI_PROVIDER_OPTIONS } from '@/lib/cliProviders'
import {
  agentCliCommandCatalogError,
  agentCliCommandCatalogPath,
  ensureAgentCliCommandCatalogFile,
  loadAgentCliCommandCatalog,
} from '@/lib/agentCliCommands'
import { SCROLL_SPEED_STEPS } from '@/lib/scrollSpeed'
import { SOURCE_SCOPE_DESCRIPTIONS } from '@/lib/sourceScopes'
import { FONT_ROLE_LABELS, BUILTIN_FONT_ASSETS, getFontStyle, getFontStyleOptions, inferFontRole, readFontFile, type FontRole } from '@/lib/fontStyles'
import { applyTheme, getTheme, getThemeIds, registerCustomThemes, THEME_GROUPS, themeGroupId } from '@/lib/theme'
import { renderMarkdown } from '@/lib/markdown'
import { backend, type ExtensionProject, type GlobalInstructionFile, type ImageViewerRegistration } from '@/lib/tauri'
import {
  appDataDirectory,
  EDITOR_SCOPE_LABELS,
  EDITOR_SCOPE_ORDER,
  globalEditorDirectory,
  loadEditorCatalog,
  openEditor,
  projectEditorDirectory,
  systemEditorDirectory,
  type EditorCatalogEntry,
} from '@/lib/editorCatalog'
import AppUpdatePanel from '@/components/AppUpdatePanel.vue'
import SourceBadge from '@/components/SourceBadge.vue'
import type { SettingsSection } from '@/lib/settingsSections'
import { useWorkspaceStore } from '@/stores/workspace'
import type { AppSettings, GitHubAccountStatus, PluginRuntimeStatus, SkillScopeOrder } from '@/types'

const ChannelProbePanel = defineAsyncComponent(() => import('./ChannelProbePanel.vue'))
const UsageStatsPanel = defineAsyncComponent(() => import('./UsageStatsPanel.vue'))
const ScriptUsagePanel = defineAsyncComponent(() => import('./ScriptUsagePanel.vue'))
const AutomationTasksPanel = defineAsyncComponent(() => import('./AutomationTasksPanel.vue'))

const props = withDefaults(defineProps<{ preview?: boolean; simulated?: boolean; initialSection?: SettingsSection }>(), { initialSection: 'general' })
const emit = defineEmits<{ sectionChange: [section: SettingsSection] }>()
const store = useWorkspaceStore()
const activeSection = ref<SettingsSection>(props.initialSection)
const search = ref('')
const imageViewer = ref<ImageViewerRegistration | null>(null)
const imageViewerBusy = ref(false)
const imageViewerError = ref('')
const githubAccount = ref<GitHubAccountStatus | null>(null)
const githubAccountLoading = ref(false)
const githubAccountError = ref('')
const githubLoginStarting = ref(false)
const globalInstructionFiles = ref<GlobalInstructionFile[]>([])
const globalInstructionsLoading = ref(false)
const globalInstructionsError = ref('')

interface GlobalInstructionDraft {
  content: string
  encoding: string
  lineEnding: '\r\n' | '\n'
  savedContent: string
  loaded: boolean
  rendered: boolean
  editing: boolean
  dirty: boolean
  error: string
}

const globalInstructionDrafts = reactive<Record<string, GlobalInstructionDraft>>({})
const globalInstructionSaveTimers = new Map<string, number>()
const globalInstructionSaves = new Map<string, Promise<boolean>>()

function globalInstructionDraft(path: string) {
  return globalInstructionDrafts[path] ??= { content: '', encoding: 'utf-8', lineEnding: '\n', savedContent: '', loaded: false, rendered: true, editing: false, dirty: false, error: '' }
}

async function loadGlobalInstruction(file: GlobalInstructionFile) {
  const draft = globalInstructionDraft(file.filePath)
  if (!file.exists || draft.dirty || globalInstructionSaves.has(file.filePath)) return
  try {
    const loaded = await backend.readEditorFile(file.filePath)
    if (draft.dirty) return
    draft.content = loaded.content
    draft.encoding = loaded.encoding
    draft.lineEnding = loaded.content.includes('\r\n') ? '\r\n' : '\n'
    draft.savedContent = loaded.content.replace(/\r\n/g, '\n')
    draft.loaded = true
    draft.error = ''
  } catch (error) {
    draft.loaded = false
    draft.error = `读取失败：${errorText(error)}`
  }
}

async function refreshGlobalInstructions() {
  if (props.preview || props.simulated || globalInstructionsLoading.value) return
  globalInstructionsLoading.value = true
  globalInstructionsError.value = ''
  try {
    const files = await backend.discoverGlobalInstructionFiles()
    files.forEach((file) => globalInstructionDraft(file.filePath))
    globalInstructionFiles.value = files
    await Promise.all(files.map(loadGlobalInstruction))
  } catch (error) {
    globalInstructionsError.value = `无法读取全局指令文件：${errorText(error)}`
  } finally {
    globalInstructionsLoading.value = false
  }
}

async function refreshTerminalSettings() {
  await Promise.allSettled([store.refreshCliEnvironments(), refreshGlobalInstructions(), loadAgentCliCommandCatalog(true)])
}

async function openAgentCliCommandCatalog() {
  try {
    const path = await ensureAgentCliCommandCatalogFile()
    const opened = await store.openFile(path, { revealInExplorer: false, createUnsupportedTabOnError: false })
    if (!opened) return
    store.setWorkspaceSurface('project')
    store.setPreviewMode('code')
    store.setSettingsOpen(false)
  } catch (error) {
    store.showErrorMessage(`打开 Agent CLI 命令配置失败：${errorText(error)}`)
  }
}

function samePath(left: string, right: string) {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()
}

function updateGlobalInstruction(path: string, event: Event) {
  const draft = globalInstructionDraft(path)
  draft.content = (event.target as HTMLTextAreaElement).value
  draft.dirty = true
  const timer = globalInstructionSaveTimers.get(path)
  if (timer != null) window.clearTimeout(timer)
  globalInstructionSaveTimers.set(path, window.setTimeout(() => void flushGlobalInstruction(path), 400))
}

async function flushGlobalInstruction(path: string): Promise<boolean> {
  const timer = globalInstructionSaveTimers.get(path)
  if (timer != null) window.clearTimeout(timer)
  globalInstructionSaveTimers.delete(path)
  const pending = globalInstructionSaves.get(path)
  if (pending) await pending
  const draft = globalInstructionDrafts[path]
  if (!draft?.dirty) return !draft?.error
  draft.dirty = false
  // Textareas report LF only; skip unchanged text and write back the file's own line endings.
  const normalized = draft.content.replace(/\r\n/g, '\n')
  if (normalized === draft.savedContent) return true
  const content = draft.lineEnding === '\n' ? normalized : normalized.replace(/\n/g, draft.lineEnding)
  const save = backend.writeEditorFile(path, content, draft.encoding)
    .then(() => {
      draft.error = ''
      draft.savedContent = normalized
      // Keep an unmodified code preview tab of the same file in step with inline edits.
      const tab = store.tabs.find((item) => samePath(item.path, path))
      if (tab && tab.contentType === 'text' && !tab.isDirty) {
        tab.content = content
        tab.lastKnownDiskContent = content
      }
      return true
    })
    .catch((error: unknown) => {
      draft.dirty = true
      draft.error = `保存失败：${errorText(error)}`
      return false
    })
    .finally(() => globalInstructionSaves.delete(path))
  globalInstructionSaves.set(path, save)
  return save
}

function flushGlobalInstructions() {
  return Promise.all(Object.keys(globalInstructionDrafts).map(flushGlobalInstruction))
}

async function startGlobalInstructionEdit(file: GlobalInstructionFile, event: MouseEvent) {
  // Rendered links must not navigate the app window; clicking anywhere enters editing.
  if ((event.target as HTMLElement | null)?.closest('a')) event.preventDefault()
  const draft = globalInstructionDraft(file.filePath)
  draft.editing = true
  await nextTick()
  document.querySelector<HTMLTextAreaElement>(`textarea[data-global-instruction="${CSS.escape(file.filePath)}"]`)?.focus()
}

function finishGlobalInstructionEdit(path: string) {
  globalInstructionDraft(path).editing = false
  void flushGlobalInstruction(path)
}

async function openGlobalInstruction(file: GlobalInstructionFile) {
  await flushGlobalInstruction(file.filePath)
  const opened = await store.openFile(file.filePath, { revealInExplorer: false, createUnsupportedTabOnError: false })
  if (!opened) return
  const render = globalInstructionDraft(file.filePath).rendered
  if (store.markdownPreviewEnabled !== render) store.toggleMarkdownPreview()
  store.setWorkspaceSurface('project')
  store.setPreviewMode('code')
  store.setSettingsOpen(false)
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function refreshGitHubAccount() {
  if (props.preview || props.simulated || githubAccountLoading.value) return
  githubAccountLoading.value = true
  githubAccountError.value = ''
  try {
    githubAccount.value = await backend.githubAccountStatus()
  } catch (error) {
    githubAccountError.value = `无法读取 GitHub 登录状态：${errorText(error)}`
  } finally {
    githubAccountLoading.value = false
  }
}

async function startGitHubLogin() {
  if (props.preview || props.simulated || githubLoginStarting.value) return
  if (!githubAccount.value?.installed) return
  githubLoginStarting.value = true
  githubAccountError.value = ''
  try {
    const cwd = githubAccount.value.homeDirectory || store.workspace?.rootPath
    if (!cwd) throw new Error('找不到可用的登录目录')
    const session = await store.createTerminalSession('local', { cwd, name: 'GitHub 登录' })
    if (!session) throw new Error('无法创建登录终端')
    await store.writeTerminalInput('gh auth login --hostname github.com --git-protocol https --web --clipboard\r', session.id)
    store.setWorkspaceSurface('project')
    store.setPreviewMode('local_terminal')
    store.setSettingsOpen(false)
    store.showActivityMessage('请在终端完成 GitHub 登录，完成后回到设置刷新账户状态')
  } catch (error) {
    githubAccountError.value = `启动 GitHub 登录失败：${errorText(error)}`
  } finally {
    githubLoginStarting.value = false
  }
}

async function refreshImageViewer() {
  if (props.preview || imageViewerBusy.value) return
  imageViewerBusy.value = true
  imageViewerError.value = ''
  try {
    imageViewer.value = await backend.getImageViewerRegistration()
  } catch (error) {
    imageViewerError.value = `无法读取图片查看器状态：${String(error)}`
  } finally {
    imageViewerBusy.value = false
  }
}

async function toggleImageViewer() {
  if (props.preview || imageViewerBusy.value || !imageViewer.value?.supported) return
  imageViewerBusy.value = true
  imageViewerError.value = ''
  try {
    imageViewer.value = await backend.setImageViewerRegistration(!imageViewer.value.enabled)
  } catch (error) {
    imageViewerError.value = `图片查看器设置失败：${String(error)}`
    try { imageViewer.value = await backend.getImageViewerRegistration() } catch { /* Keep the last confirmed state. */ }
  } finally {
    imageViewerBusy.value = false
  }
}

const themeGroups = computed(() => {
  const themes = getThemeIds().map((id) => getTheme(id))
  return THEME_GROUPS
    .map(group => ({ ...group, themes: themes.filter(theme => themeGroupId(theme) === group.id) }))
    .filter(group => group.themes.length)
})
// 键盘上下移动按分组展示顺序。
const themeOptions = computed(() => themeGroups.value.flatMap(group => group.themes))
const themePickerRoot = ref<HTMLElement | null>(null)
const themeMenuOpen = ref(false)
const themePreviewId = ref<string | null>(null)
const themePreviewBaseId = ref<string | null>(null)
const themeActiveIndex = ref(0)
const themeImportInput = ref<HTMLInputElement | null>(null)
const fontImportInput = ref<HTMLInputElement | null>(null)
const currentTheme = computed(() => getTheme(themePreviewId.value ?? store.settings.themeId))
const selectedTheme = computed(() => getTheme(themePreviewBaseId.value ?? store.settings.themeId))
const fontStyleOptions = computed(() => getFontStyleOptions(store.settings.customFontStyles ?? []))
const fontAssets = computed(() => [...BUILTIN_FONT_ASSETS, ...(store.settings.customFonts ?? [])])
const selectedFontStyle = computed(() => getFontStyle(store.settings.fontStyleId, store.settings.customFontStyles ?? []))
const selectedCustomFontStyle = computed(() => (store.settings.customFontStyles ?? []).find((style) => style.id === selectedFontStyle.value.id) ?? null)
const themePalette = computed(() => [
  {
    label: '背景',
    colors: [
      { label: '主背景', value: currentTheme.value.colors.bg.primary },
      { label: '面板', value: currentTheme.value.colors.bg.secondary },
      { label: '悬停', value: currentTheme.value.colors.bg.hover },
    ],
  },
  {
    label: '文字',
    colors: [
      { label: '主文字', value: currentTheme.value.colors.text.primary },
      { label: '次文字', value: currentTheme.value.colors.text.secondary },
      { label: '弱文字', value: currentTheme.value.colors.text.muted },
    ],
  },
  {
    label: '强调色',
    colors: [
      { label: '蓝', value: currentTheme.value.colors.accent.blue },
      { label: '绿', value: currentTheme.value.colors.accent.green },
      { label: '黄', value: currentTheme.value.colors.accent.yellow },
      { label: '红', value: currentTheme.value.colors.accent.red },
      { label: '紫', value: currentTheme.value.colors.accent.purple },
    ],
  },
  {
    label: '终端',
    colors: [
      { label: '黑', value: currentTheme.value.terminal.black },
      { label: '红', value: currentTheme.value.terminal.red },
      { label: '绿', value: currentTheme.value.terminal.green },
      { label: '黄', value: currentTheme.value.terminal.yellow },
      { label: '蓝', value: currentTheme.value.terminal.blue },
      { label: '洋红', value: currentTheme.value.terminal.magenta },
      { label: '青', value: currentTheme.value.terminal.cyan },
      { label: '白', value: currentTheme.value.terminal.white },
    ],
  },
  ...(currentTheme.value.effects
    ? [{ label: '动效', colors: currentTheme.value.effects.gradient.map((value, index) => ({ label: `渐变 ${index + 1}`, value })) }]
    : []),
])

function setThemePreview(themeId: string | null) {
  if (themeId && !themePreviewBaseId.value) themePreviewBaseId.value = store.settings.themeId
  themePreviewId.value = themeId
  if (themeId) {
    if (store.settings.themeId !== themeId) store.settings.themeId = themeId
    applyTheme(themeId)
    return
  }
  const restoreId = themePreviewBaseId.value ?? store.settings.themeId
  themePreviewBaseId.value = null
  if (store.settings.themeId !== restoreId) store.settings.themeId = restoreId
  applyTheme(restoreId)
}

function openThemePicker() {
  const selectedIndex = themeOptions.value.findIndex(theme => theme.id === store.settings.themeId)
  themeActiveIndex.value = selectedIndex >= 0 ? selectedIndex : 0
  themeMenuOpen.value = true
}

function closeThemePicker() {
  themeMenuOpen.value = false
  setThemePreview(null)
}

function toggleThemePicker() {
  if (themeMenuOpen.value) closeThemePicker()
  else openThemePicker()
}

function previewTheme(themeId: string) {
  const index = themeOptions.value.findIndex(theme => theme.id === themeId)
  if (index >= 0) themeActiveIndex.value = index
  setThemePreview(themeId)
}

function chooseTheme(themeId: string) {
  closeThemePicker()
  void store.setTheme(themeId)
}

function exportThemes() {
  const themes = store.settings.customThemes ?? []
  const payload = JSON.stringify(themes, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'superhigh-themes.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function exportThemeTemplate() {
  const theme = getTheme('dark')
  const template = { ...theme, id: 'my-theme', name: '我的主题' }
  const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'superhigh-theme-template.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function openThemeImport() {
  themeImportInput.value?.click()
}

async function importThemes(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    const incoming = Array.isArray(parsed) ? parsed : [parsed]
    const merged = registerCustomThemes([...(store.settings.customThemes ?? []), ...incoming])
    store.settings.customThemes = merged
    await store.saveSettings()
    store.showActivityMessage(`已导入 ${merged.length} 个自定义主题`)
  } catch (error) {
    store.showErrorMessage(`主题导入失败：${String(error)}`)
  }
}

function moveThemeHighlight(index: number) {
  const options = themeOptions.value
  themeActiveIndex.value = Math.max(0, Math.min(index, options.length - 1))
  previewTheme(options[themeActiveIndex.value].id)
}

function onThemePickerKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (themeMenuOpen.value) {
      event.preventDefault()
      closeThemePicker()
    }
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!themeMenuOpen.value) {
      openThemePicker()
      return
    }
    chooseTheme(themeOptions.value[themeActiveIndex.value].id)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (!themeMenuOpen.value) openThemePicker()
  const currentIndex = themeActiveIndex.value
  const nextIndex = event.key === 'ArrowDown'
    ? currentIndex + 1
    : event.key === 'ArrowUp'
      ? currentIndex - 1
      : event.key === 'Home'
        ? 0
        : themeOptions.value.length - 1
  moveThemeHighlight(nextIndex)
}

function onThemePickerFocusOut(event: FocusEvent) {
  const nextTarget = event.relatedTarget as Node | null
  if (!nextTarget || !themePickerRoot.value?.contains(nextTarget)) closeThemePicker()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (themeMenuOpen.value && !themePickerRoot.value?.contains(event.target as Node)) closeThemePicker()
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  setThemePreview(null)
  void flushGlobalInstructions()
})
const pluginSearch = ref('')
const pluginSource = ref('all')
const filteredPlugins = computed(() => store.pluginStatuses.filter(plugin =>
  (pluginSource.value === 'all' || plugin.source === pluginSource.value)
  && `${plugin.name} ${plugin.id}`.toLocaleLowerCase().includes(pluginSearch.value.trim().toLocaleLowerCase()),
))
const storageLocations = computed(() => [
  { label: '当前项目根目录', path: store.workspace?.rootPath, empty: '未打开项目' },
  { label: '应用数据目录', path: store.appStorageInfo?.dataDir, empty: '未读取' },
  { label: '数据库', path: store.appStorageInfo?.databasePath, empty: '未读取' },
  { label: 'Super High 根目录', path: store.appStorageInfo?.superHighRoot, empty: '未读取' },
])
const storageSize = computed(() => formatBytes(store.appStorageInfo?.databaseSizeBytes ?? 0))
const mobileHostUrls = computed(() => store.mobileHostStatus?.urls ?? [])
const mobilePrimaryUrl = computed(() => mobileHostUrls.value.find((url) => !url.includes('127.0.0.1')) ?? mobileHostUrls.value[0] ?? '')
const mobileHostToken = computed(() => store.mobileHostConfig?.token ?? store.settings.mobileHost.token)
const mobileWebUrl = computed(() => mobilePrimaryUrl.value ? `${mobilePrimaryUrl.value}/mobile/` : '')

async function previewMobile() {
  const port = store.mobileHostStatus?.port
  if (!port || !store.mobileHostStatus?.running) return
  await backend.openUrl(`http://127.0.0.1:${port}/mobile/`)
}
const editorCatalog = ref<EditorCatalogEntry[]>([])
const editorCatalogLoading = ref(false)
const editorDataDirectory = ref('')
const extensionProjects = ref<ExtensionProject[]>([])
const extensionProjectsBusy = ref(false)
const extensionProjectsError = ref('')
const extensionFeatures = [
  { key: 'commands', label: '项目指令' },
  { key: 'scriptTools', label: '脚本工具' },
  { key: 'editors', label: '编辑器' },
] as const

async function loadExtensionProjects() {
  const root = store.workspace?.rootPath
  extensionProjects.value = []
  extensionProjectsError.value = ''
  if (!root || props.preview) return
  try {
    const projects = await backend.getExtensionProjects(root)
    if (root === store.workspace?.rootPath) extensionProjects.value = projects
  } catch (error) {
    if (root === store.workspace?.rootPath) extensionProjectsError.value = String(error)
  }
}

async function saveExtensionProjects(projects: ExtensionProject[]) {
  const root = store.workspace?.rootPath
  if (!root || extensionProjectsBusy.value) return
  extensionProjectsBusy.value = true
  extensionProjectsError.value = ''
  try {
    await backend.saveExtensionProjects(root, projects)
    if (root !== store.workspace?.rootPath) return
    extensionProjects.value = projects
    window.dispatchEvent(new Event('superhigh:extension-projects-changed'))
    await refreshEditorCatalog()
  } catch (error) {
    extensionProjectsError.value = String(error)
  } finally {
    extensionProjectsBusy.value = false
  }
}

async function addExtensionProject() {
  const root = store.workspace?.rootPath
  try {
    const path = await backend.selectDirectory(root)
    if (!path || root !== store.workspace?.rootPath) return
    await saveExtensionProjects([...extensionProjects.value, { path, commands: true, scriptTools: true, editors: true }])
  } catch (error) { extensionProjectsError.value = String(error) }
}

function toggleExtensionFeature(index: number, key: 'commands' | 'scriptTools' | 'editors') {
  void saveExtensionProjects(extensionProjects.value.map((project, i) => i === index ? { ...project, [key]: !project[key] } : project))
}

watch(() => store.workspace?.rootPath, () => { void loadExtensionProjects(); void refreshEditorCatalog() })
const editorGroups = computed(() => EDITOR_SCOPE_ORDER.map((scope) => {
  const root = store.workspace?.rootPath
  const directory = scope === 'project'
    ? (root ? projectEditorDirectory(root) : '')
    : editorDataDirectory.value && (scope === 'global' ? globalEditorDirectory(editorDataDirectory.value) : systemEditorDirectory(editorDataDirectory.value))
  const empty = scope === 'project' && !root ? '未打开项目' : scope === 'system' ? '没有系统编辑器' : '未登记编辑器'
  return { scope, label: EDITOR_SCOPE_LABELS[scope], directory, empty, items: editorCatalog.value.filter((editor) => editor.scope === scope) }
}))

async function refreshEditorCatalog() {
  if (props.preview || editorCatalogLoading.value) return
  const root = store.workspace?.rootPath
  editorCatalogLoading.value = true
  try {
    editorDataDirectory.value = await appDataDirectory().catch(() => '')
    const entries = await loadEditorCatalog(root)
    if (root === store.workspace?.rootPath) editorCatalog.value = entries
  } catch (error) {
    editorCatalog.value = []
    extensionProjectsError.value = String(error)
  } finally {
    editorCatalogLoading.value = false
    if (root !== store.workspace?.rootPath) void refreshEditorCatalog()
  }
}

async function openCatalogEditor(editor: EditorCatalogEntry) {
  try {
    if (!await openEditor(store, editor)) store.showErrorMessage(`无法打开编辑器：${editor.id}`)
  } catch (error) {
    store.showErrorMessage(`编辑器打开失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function openEditorDirectory(directory: string) {
  // 全局清单目录可能尚未创建，打开前先建好。
  await backend.createDirectory(directory).catch(() => undefined)
  await store.openPath(directory)
}

watch(activeSection, (section) => { if (section === 'editors') { void loadExtensionProjects(); void refreshEditorCatalog() } }, { immediate: true })

const settingSections: Array<{ id: SettingsSection; label: string; icon: Component }> = [
  { id: 'account', label: '账户', icon: UserRound },
  { id: 'general', label: '常规', icon: Settings },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'config', label: '配置', icon: SlidersHorizontal },
  { id: 'editors', label: '脚本与编辑器', icon: FileCode2 },
  { id: 'automation', label: '自动任务', icon: Clock3 },
  { id: 'shortcuts', label: '键盘快捷键', icon: Keyboard },
  { id: 'mobile', label: '手机端', icon: Smartphone },
  { id: 'cli', label: '终端', icon: TerminalSquare },
  { id: 'storage', label: '数据', icon: Database },
  { id: 'usage', label: '使用统计', icon: ChartColumn },
  { id: 'updates', label: '应用', icon: RefreshCw },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'channels', label: '渠道检测', icon: RadioTower },
]
const filteredSections = computed(() => settingSections.filter(section =>
  section.label.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
))

const sectionGroups = computed(() => [
  { label: '个人', sections: filteredSections.value.filter(section => !['plugins', 'channels'].includes(section.id)) },
  { label: '集成', sections: filteredSections.value.filter(section => ['plugins', 'channels'].includes(section.id)) },
].filter(group => group.sections.length))
const editorShortcuts = [
  { label: '保存当前文件', keys: 'Ctrl + S' },
  { label: '撤销', keys: 'Ctrl + Z' },
  { label: '重做', keys: 'Ctrl + Y' },
  { label: '剪切', keys: 'Ctrl + X' },
  { label: '复制', keys: 'Ctrl + C' },
  { label: '粘贴', keys: 'Ctrl + V' },
  { label: '全选', keys: 'Ctrl + A' },
  { label: '切换行注释', keys: 'Ctrl + /' },
  { label: '查找', keys: 'Ctrl + F' },
  { label: '替换', keys: 'Ctrl + H' },
  { label: '转到行', keys: 'Ctrl + G' },
  { label: '转到符号', keys: 'Ctrl + Shift + O' },
]

function replayTutorial() {
  window.dispatchEvent(new Event('superhigh:replay-onboarding'))
}


function pluginStatusLabel(status: PluginRuntimeStatus) {
  if (status === 'loaded') return '已加载'
  if (status === 'matched') return '已匹配'
  if (status === 'notMatched') return '未匹配'
  if (status === 'disabled') return '已停用'
  if (status === 'manifestError') return '配置错误'
  if (status === 'failed') return '加载失败'
  return status
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

async function openStoragePath(path: string | undefined) {
  if (!path) return
  await store.openPath(path)
}

async function copyText(text: string) {
  if (!text) return
  await navigator.clipboard.writeText(text)
  store.showActivityMessage('已复制')
}

function onMobilePortInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  void store.updateMobileHostConfig({ port: Number.isFinite(value) ? value : 10320 })
}

function onMobileTokenInput(event: Event) {
  void store.updateMobileHostConfig({ token: (event.target as HTMLInputElement).value })
}

function toggleRenderColorCodes() {
  void store.setRenderColorCodes(!store.settings.renderColorCodes)
}

function toggleYamlKeyValueCodexColors() {
  void store.setYamlKeyValueCodexColors(!store.settings.yamlKeyValueCodexColors)
}

function openFontImport() {
  fontImportInput.value?.click()
}

function fontAssetName(fontId: string | undefined) {
  return fontAssets.value.find((font) => font.id === fontId)?.name ?? '系统字体回退'
}

async function importFonts(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  try {
    const imported = await Promise.all(files.map(readFontFile))
    const roles: Partial<Record<FontRole, string>> = {}
    imported.forEach((font, index) => {
      const role = inferFontRole(files[index].name)
      if (!roles[role]) roles[role] = font.id
    })
    const isAnthropic = files.every((file) => file.name.toLocaleLowerCase().includes('anthropic'))
    const style: NonNullable<AppSettings['customFontStyles']>[number] = {
      id: `font-style-${crypto.randomUUID()}`,
      name: isAnthropic ? 'Anthropic 字体风格' : `${imported[0].name} 字体风格`,
      roles,
    }
    await store.setCustomFonts([...(store.settings.customFonts ?? []), ...imported], [...(store.settings.customFontStyles ?? []), style])
    await store.setFontStyle(style.id)
    store.showActivityMessage(`已导入 ${imported.length} 个字体文件`)
  } catch (error) {
    store.showErrorMessage(`字体导入失败：${String(error)}`)
  }
}

async function setFontRole(role: FontRole, fontId: string) {
  const style = selectedCustomFontStyle.value
  if (!style) return
  const styles = (store.settings.customFontStyles ?? []).map((item) => item.id === style.id
    ? { ...item, roles: { ...item.roles, [role]: fontId || undefined } }
    : item)
  await store.setCustomFonts(store.settings.customFonts, styles)
}

async function removeSelectedFontStyle() {
  const style = selectedCustomFontStyle.value
  if (!style) return
  const styles = (store.settings.customFontStyles ?? []).filter((item) => item.id !== style.id)
  await store.setCustomFonts(store.settings.customFonts, styles)
  await store.setFontStyle('anthropic')
}

watch(activeSection, (section) => {
  emit('sectionChange', section)
  if (section === 'account') void refreshGitHubAccount()
  if (section === 'config') void refreshImageViewer()
  if (section === 'cli') void refreshTerminalSettings()
  if (section === 'storage') void store.refreshAppStorageInfo()
  if (section === 'plugins') void store.refreshPlugins()
  if (section === 'mobile') void store.refreshMobileHostStatus()
  if (section !== 'cli') void flushGlobalInstructions()
}, { immediate: true })
watch(() => store.settingsOpen, (open) => {
  if (!open) void flushGlobalInstructions()
  else if (activeSection.value === 'cli') void refreshGlobalInstructions()
})
watch(() => props.initialSection, section => { activeSection.value = section })
watch(() => store.settings, () => {
  if (props.simulated && activeSection.value === 'config') void refreshImageViewer()
})
</script>

<template>
  <section v-if="store.settingsOpen" class="settings-workspace-panel" aria-label="设置">
    <div class="settings-page-body">
      <nav class="settings-nav" aria-label="设置分类">
        <button class="settings-nav-button settings-back" @click="store.setSettingsOpen(false)">
          <ArrowLeft :size="15" /><span>返回工作区</span>
        </button>
        <label class="settings-search">
          <Search :size="14" />
          <input v-model="search" type="search" aria-label="搜索设置分类" placeholder="搜索设置分类…" />
        </label>
        <template v-for="group in sectionGroups" :key="group.label">
        <div class="settings-nav-label">{{ group.label }}</div>
        <button
          v-for="section in group.sections"
          :key="section.id"
          class="settings-nav-button"
          :class="{ active: activeSection === section.id }"
          :aria-current="activeSection === section.id ? 'page' : undefined"
          @click="activeSection = section.id"
        >
          <component :is="section.icon" :size="15" />
          <span>{{ section.label }}</span>
        </button>
        </template>
        <p v-if="!filteredSections.length" class="settings-nav-empty">没有匹配的分类</p>
      </nav>

      <main class="settings-content">
        <fieldset class="settings-controls" :disabled="preview && !['appearance', 'plugins', 'config', 'shortcuts', 'automation'].includes(activeSection)">
        <section v-if="activeSection === 'account'" class="settings-content-section">
          <div class="settings-section-heading"><div class="section-title">账户</div></div>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle settings-account-title"><Github :size="15" /><span>GitHub</span></div>
                <div class="settings-path">
                  <template v-if="preview || simulated">请在桌面应用中查看 GitHub 登录状态。</template>
                  <template v-else-if="githubAccountLoading">正在读取 GitHub CLI 状态…</template>
                  <template v-else-if="!githubAccount?.installed">未检测到 GitHub CLI。安装 gh 后可在此登录 GitHub。</template>
                  <template v-else-if="githubAccount?.authenticated">已连接 @{{ githubAccount.login }}，凭据由 GitHub CLI 保存在系统密钥环。</template>
                  <template v-else>尚未登录。登录会在本地终端打开 GitHub CLI 的浏览器授权流程。</template>
                </div>
                <div v-if="githubAccountError" class="settings-path" role="alert">{{ githubAccountError }}</div>
              </div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" :disabled="preview || simulated || githubAccountLoading" @click="refreshGitHubAccount">
                  <RefreshCw :size="13" /><span>刷新</span>
                </button>
                <button class="primary-button small" :disabled="preview || simulated || !githubAccount?.installed || githubLoginStarting" @click="startGitHubLogin">
                  <LogIn :size="13" /><span>{{ githubLoginStarting ? '正在启动…' : (githubAccount?.authenticated ? '重新登录' : '登录 GitHub') }}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
        <section v-else-if="activeSection === 'general'" class="settings-content-section">
          <div class="settings-section-heading"><div class="section-title">常规</div></div>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">新手教程</div><div class="settings-path">重新了解项目、对话、文件和终端的日常用法。</div></div>
              <button class="ghost-button small" @click="replayTutorial"><BookOpen :size="14" /><span>再次播放新手教程</span></button>
            </div>
          </div>
        </section>
        <section v-else-if="activeSection === 'config'" class="settings-content-section">
          <div class="settings-section-heading"><div><div class="section-title">配置</div></div></div>
          <h3 class="settings-group-title">滚动</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><label for="settings-scroll-speed" class="settings-subtitle">默认滚动速度</label><div class="settings-path">以各区域当前速度为 100%，按倍率加速；每档 25%，最高 250%。</div></div>
              <select id="settings-scroll-speed" class="settings-input settings-theme-select" :value="store.settings.scrollSpeedPercent" @change="store.setScrollSpeedPercent(Number(($event.target as HTMLSelectElement).value))">
                <option v-for="percent in SCROLL_SPEED_STEPS" :key="percent" :value="percent">{{ percent }}%</option>
              </select>
            </div>
          </div>
          <h3 class="settings-group-title">CLI 指令菜单</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><label for="settings-skill-scope-order" class="settings-subtitle">全局 Skill 位置</label><div class="settings-path">输入 / 唤起的指令列表中，全局 Skill 排在项目 Skill 之前或之后；SuperHigh 指令始终置顶。</div></div>
              <select id="settings-skill-scope-order" class="settings-input settings-theme-select" :value="store.settings.skillScopeOrder" @change="store.setSkillScopeOrder(($event.target as HTMLSelectElement).value as SkillScopeOrder)"><option value="globalFirst">最上面</option><option value="globalLast">最下面</option></select>
            </div>
          </div>
          <h3 class="settings-group-title">图片查看器</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">系统图片查看器</div>
                <div class="settings-path">启用后可在图片的“打开方式”中选择 Super High，不更改默认应用。</div>
                <div v-if="preview" class="settings-path">请在桌面应用中启用。</div>
                <div v-else-if="imageViewerBusy" class="settings-path" role="status">正在更新状态…</div>
                <div v-else-if="imageViewer && !imageViewer.supported" class="settings-path">仅支持 Windows。</div>
                <div v-if="imageViewer?.defaultSelected" class="settings-path">当前默认应用为 Super High，可在 Windows 设置中更换。</div>
                <div v-if="imageViewerError" class="settings-path" role="alert">{{ imageViewerError }}</div>
              </div>
              <div class="settings-inline-actions">
                <button v-if="imageViewerError" class="ghost-button small" :disabled="imageViewerBusy" @click="refreshImageViewer">重试</button>
                <button class="toggle-button settings-switch" type="button" role="switch" aria-label="系统图片查看器"
                  :aria-checked="imageViewer?.enabled ?? false" :class="{ active: imageViewer?.enabled }"
                  :disabled="preview || imageViewerBusy || !imageViewer?.supported" @click="toggleImageViewer"><span /></button>
              </div>
            </div>
          </div>
          <h3 class="settings-group-title">文件保存</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><label for="settings-autosave" class="settings-subtitle">自动保存</label><div class="settings-path">选择编辑后自动保存文件的时机</div></div>
              <select id="settings-autosave" class="settings-input settings-theme-select" :value="store.settings.autoSave" @change="store.setAutoSave(($event.target as HTMLSelectElement).value as AppSettings['autoSave'])"><option value="off">关闭</option><option value="afterDelay">延迟后保存</option><option value="onFocusChange">失去焦点时保存</option></select>
            </div>
            <div v-if="store.settings.autoSave === 'afterDelay'" class="settings-option-row">
              <div class="settings-main"><label for="settings-autosave-delay" class="settings-subtitle">保存延迟</label><div class="settings-path">停止输入后等待的时间，单位为毫秒</div></div>
              <input id="settings-autosave-delay" class="settings-input settings-port" type="number" min="200" max="60000" step="100" :value="store.settings.autoSaveDelay" @change="store.setAutoSaveDelay(Number(($event.target as HTMLInputElement).value) || 1000)" />
            </div>
          </div>
        </section>
        <section v-else-if="activeSection === 'editors'" class="settings-content-section">
          <div class="settings-section-heading">
            <div><div class="section-title">脚本与编辑器</div></div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="editorCatalogLoading" @click="refreshEditorCatalog()"><RefreshCw :size="13" /><span>{{ editorCatalogLoading ? '刷新中' : '刷新' }}</span></button>
            </div>
          </div>
          <h3 class="settings-group-title">项目引用</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><span class="settings-subtitle">当前工作区</span><span class="settings-path">{{ store.workspace?.rootPath || '未打开项目' }}</span><span class="settings-path">按项目选择共用的指令、脚本工具和编辑器。当前项目优先，其次按引用顺序；仅当前工作区生效。</span></div>
              <button class="ghost-button small" :disabled="preview || extensionProjectsBusy || !store.workspace" @click="addExtensionProject"><FolderOpen :size="13" /><span>添加项目</span></button>
            </div>
            <div v-for="(project, index) in extensionProjects" :key="project.path" class="settings-option-row extension-project-row">
              <div class="settings-main"><span class="settings-subtitle">{{ project.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() }}</span><span class="settings-path">{{ project.path }}</span>
                <div class="settings-inline-actions extension-project-features">
                  <button v-for="feature in extensionFeatures" :key="feature.key" class="ghost-button small" :class="{ active: project[feature.key] }" :aria-pressed="project[feature.key]" :disabled="preview || extensionProjectsBusy" @click="toggleExtensionFeature(index, feature.key)"><CheckSquare v-if="project[feature.key]" :size="13" /><span>{{ feature.label }}</span></button>
                </div>
              </div>
              <button class="ghost-button small" title="移除项目引用" aria-label="移除项目引用" :disabled="preview || extensionProjectsBusy" @click="saveExtensionProjects(extensionProjects.filter((_, i) => i !== index))"><Trash2 :size="13" /></button>
            </div>
            <div v-if="extensionProjectsError" class="settings-option-row"><span class="settings-path" role="alert">{{ extensionProjectsError }}</span></div>
          </div>
          <template v-for="group in editorGroups" :key="group.scope">
            <h3 class="settings-group-title">{{ group.label }} · {{ group.items.length }}</h3>
            <div class="settings-block settings-row-group">
              <div v-if="group.directory" class="settings-option-row">
                <div class="settings-main"><span class="settings-subtitle">{{ SOURCE_SCOPE_DESCRIPTIONS[group.scope] }}</span><span class="settings-path">{{ group.scope === 'system' ? group.directory : `${group.directory}/editor.json` }}</span></div>
                <button v-if="group.scope !== 'system'" class="ghost-button small" title="打开所在目录" aria-label="打开所在目录" :disabled="preview" @click="openEditorDirectory(group.directory)"><FolderOpen :size="13" /></button>
              </div>
              <div v-for="editor in group.items" :key="editor.path" class="settings-option-row">
                <div class="settings-main"><span class="settings-subtitle">{{ editor.id }}</span><span class="settings-path">{{ editor.scope === 'project' ? editor.path : editor.entry }}</span></div>
                <button class="ghost-button small" :disabled="preview" @click="openCatalogEditor(editor)"><FileCode2 :size="13" /><span>打开</span></button>
              </div>
              <div v-if="!group.items.length" class="settings-option-row"><span class="settings-path">{{ group.empty }}</span></div>
            </div>
          </template>
        </section>
        <section v-else-if="activeSection === 'shortcuts'" class="settings-content-section">
          <div class="settings-section-heading"><div><div class="section-title">键盘快捷键</div></div></div>
          <h3 class="settings-group-title">SuperHigh 管家</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row"><div class="settings-main"><span class="settings-subtitle">显示 / 隐藏管家与宠物</span><span class="settings-path">应用窗口内有效</span></div><kbd class="settings-shortcut-keys">&#96;（反引号）</kbd></div>
            <div class="settings-option-row"><span class="settings-subtitle">展开 / 收起管家面板</span><kbd class="settings-shortcut-keys">右击宠物</kbd></div>
            <div class="settings-option-row">
              <div class="settings-main"><span class="settings-subtitle">` 唤起时默认展开面板</span><span class="settings-path">开启后每次用 ` 唤起管家都直接显示展开样式</span></div>
              <button class="toggle-button settings-switch" type="button" role="switch" aria-label="` 唤起时默认展开管家面板"
                :class="{ active: store.settings.petAutoExpand }" :aria-checked="store.settings.petAutoExpand"
                :disabled="preview" @click="store.setPetAutoExpand(!store.settings.petAutoExpand)"><span /></button>
            </div>
          </div>
          <h3 class="settings-group-title">工作区</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row"><span class="settings-subtitle">显示 / 隐藏资源管理器</span><kbd class="settings-shortcut-keys">F1</kbd></div>
            <div class="settings-option-row"><div class="settings-main"><span class="settings-subtitle">打开 / 关闭编辑器选择</span><span class="settings-path">包括项目、全局和系统编辑器</span></div><kbd class="settings-shortcut-keys">F4</kbd></div>
          </div>
          <h3 class="settings-group-title">编辑器</h3>
          <div class="settings-block settings-row-group">
            <div v-for="shortcut in editorShortcuts" :key="shortcut.keys" class="settings-option-row"><span class="settings-subtitle">{{ shortcut.label }}</span><kbd class="settings-shortcut-keys">{{ shortcut.keys }}</kbd></div>
          </div>
        </section>
        <section v-else-if="activeSection === 'mobile'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">手机端</div>
            </div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="store.mobileHostLoading" @click="store.refreshMobileHostStatus()">
                <RefreshCw :size="13" />
                <span>{{ store.mobileHostLoading ? '刷新中' : '刷新状态' }}</span>
              </button>
            </div>
          </div>

          <h3 class="settings-group-title">连接</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">手机连接服务</div><div class="settings-path">{{ preview ? '运行状态请在桌面应用查看' : store.mobileHostStatus?.running ? '运行中' : '未启动' }}</div></div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" :disabled="store.mobileHostLoading || store.mobileHostStatus?.running" @click="store.startMobileHost()"><Power :size="13" /><span>启动</span></button>
                <button class="ghost-button small" :disabled="store.mobileHostLoading || !store.mobileHostStatus?.running" @click="store.stopMobileHost()"><PowerOff :size="13" /><span>停止</span></button>
              </div>
            </div>
            <div class="settings-option-row">
              <div class="settings-main"><label class="settings-subtitle" for="mobile-port">监听端口</label><div class="settings-path">手机与电脑通过此端口连接</div></div>
              <input id="mobile-port" class="settings-input settings-port" type="number" min="1024" max="65535" :value="store.mobileHostConfig?.port ?? store.settings.mobileHost.port" @change="onMobilePortInput" />
            </div>
            <div class="settings-option-row">
              <div class="settings-main"><label class="settings-subtitle" for="mobile-token">连接令牌</label><div class="settings-path">在手机端输入此令牌</div></div>
              <div class="settings-inline-actions settings-token-control">
                <input id="mobile-token" class="settings-input" type="text" :value="mobileHostToken" @change="onMobileTokenInput" />
                <button class="ghost-button small" title="生成新令牌" aria-label="生成新令牌" :disabled="store.mobileHostLoading" @click="store.regenerateMobileHostToken()"><KeyRound :size="13" /></button>
                <button class="ghost-button small" title="复制令牌" aria-label="复制令牌" :disabled="!mobileHostToken" @click="copyText(mobileHostToken)"><Copy :size="13" /></button>
              </div>
            </div>
            <div v-for="url in mobileHostUrls" :key="url" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">{{ url === mobilePrimaryUrl ? '推荐地址' : '备用地址' }}</div><code class="settings-path">{{ url }}</code></div>
              <button class="ghost-button small" @click="copyText(url)">复制</button>
            </div>
            <div v-if="!mobileHostUrls.length" class="settings-option-row"><span class="settings-path">{{ preview ? '连接地址请在桌面应用查看。' : '启动服务后显示可连接地址。' }}</span></div>
          </div>
          <h3 class="settings-group-title">手机网页</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">预览手机界面</div><div class="settings-path">{{ mobileWebUrl || '启动服务后可打开手机网页' }}</div></div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" :disabled="!mobileWebUrl" @click="copyText(mobileWebUrl)">复制地址</button>
                <button class="ghost-button small" :disabled="!store.mobileHostStatus?.running" @click="previewMobile">打开</button>
              </div>
            </div>
          </div>
          <p class="settings-footnote">手机界面由电脑提供，更新后刷新网页即可。首次启动时，请允许 Windows 专用网络访问。</p>
        </section>

        <section v-else-if="activeSection === 'cli'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">终端</div>
            </div>
            <button class="ghost-button small" :disabled="store.cliEnvironmentsLoading || globalInstructionsLoading" @click="refreshTerminalSettings()">
              <RefreshCw :size="13" />
              <span>{{ store.cliEnvironmentsLoading ? '检测中' : '刷新' }}</span>
            </button>
          </div>

          <div class="settings-block">
            <div v-for="provider in CLI_PROVIDER_OPTIONS" :key="provider.id" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">{{ provider.name }}</div></div>
              <button class="toggle-button settings-switch" type="button" role="switch"
                :class="{ active: store.isCliProviderVisible(provider.id) }"
                :aria-checked="store.isCliProviderVisible(provider.id)"
                :aria-label="`显示 ${provider.name} 启动入口`"
                :title="store.isCliProviderVisible(provider.id) ? '隐藏启动入口' : '显示启动入口'"
                @click="store.setCliProviderVisible(provider.id, !store.isCliProviderVisible(provider.id))"
              ><span /></button>
            </div>
          </div>
          <div class="settings-block">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">Agent CLI 命令中文翻译</div>
                <div class="settings-path">开启后显示命令的中文说明；关闭时显示 CLI 原始英文。</div>
                <div class="settings-path">配置：{{ agentCliCommandCatalogPath || '应用数据目录/agent-cli-commands.json' }}</div>
                <div v-if="agentCliCommandCatalogError" class="cli-env-issue">{{ agentCliCommandCatalogError }}</div>
              </div>
              <div class="settings-heading-actions">
                <button class="ghost-button small" type="button" @click="openAgentCliCommandCatalog">编辑配置</button>
                <button class="toggle-button settings-switch" type="button" role="switch"
                  :class="{ active: store.settings.agentCliCommandTranslation !== false }"
                  :aria-checked="store.settings.agentCliCommandTranslation !== false"
                  aria-label="Agent CLI 命令中文翻译"
                  :title="store.settings.agentCliCommandTranslation !== false ? '关闭中文翻译' : '开启中文翻译'"
                  @click="store.setAgentCliCommandTranslation(store.settings.agentCliCommandTranslation === false)"
                ><span /></button>
              </div>
            </div>
          </div>
          <div class="settings-block">
            <div class="settings-option-row"><span class="settings-subtitle">全局指令文件</span></div>
            <div v-for="file in globalInstructionFiles" :key="file.filePath" class="settings-option-row global-instruction-row">
              <div class="global-instruction-head">
                <div class="settings-main">
                  <div class="settings-subtitle">{{ file.provider }} · {{ file.fileName }}</div>
                  <div class="settings-path">{{ file.filePath }}</div>
                  <div v-if="!file.exists" class="settings-path">未创建</div>
                </div>
                <div v-if="file.exists" class="settings-heading-actions">
                  <span class="settings-label">渲染</span>
                  <button class="toggle-button settings-switch" type="button" role="switch"
                    :class="{ active: globalInstructionDraft(file.filePath).rendered }"
                    :aria-checked="globalInstructionDraft(file.filePath).rendered"
                    :aria-label="`渲染 ${file.provider} ${file.fileName}`"
                    @click="globalInstructionDraft(file.filePath).rendered = !globalInstructionDraft(file.filePath).rendered"
                  ><span /></button>
                  <button class="ghost-button small" type="button" :aria-label="`在代码预览打开 ${file.provider} ${file.fileName}`" @click="openGlobalInstruction(file)">代码预览</button>
                </div>
              </div>
              <template v-if="file.exists && globalInstructionDraft(file.filePath).loaded">
                <textarea
                  v-if="!globalInstructionDraft(file.filePath).rendered || globalInstructionDraft(file.filePath).editing"
                  :value="globalInstructionDraft(file.filePath).content"
                  class="global-instruction-body global-instruction-input"
                  :data-global-instruction="file.filePath"
                  :aria-label="`${file.provider} ${file.fileName} 内容`"
                  spellcheck="false"
                  @input="updateGlobalInstruction(file.filePath, $event)"
                  @blur="finishGlobalInstructionEdit(file.filePath)"
                />
                <div
                  v-else
                  class="global-instruction-body markdown-body"
                  title="点击编辑"
                  @click="startGlobalInstructionEdit(file, $event)"
                  v-html="renderMarkdown(globalInstructionDraft(file.filePath).content)"
                />
              </template>
              <span v-if="globalInstructionDraft(file.filePath).error" class="cli-env-issue">{{ globalInstructionDraft(file.filePath).error }}</span>
            </div>
            <div v-if="globalInstructionsError" class="settings-option-row"><span class="cli-env-issue">{{ globalInstructionsError }}</span></div>
            <div v-else-if="!globalInstructionFiles.length" class="settings-option-row"><span class="settings-path">{{ preview || simulated ? '请在桌面应用中查看全局指令文件。' : globalInstructionsLoading ? '正在读取全局指令文件…' : '未读取全局指令文件。' }}</span></div>
          </div>
          <div class="settings-list">
            <article v-for="environment in store.cliEnvironments" :key="environment.providerKind" class="settings-row cli-env-row">
              <div class="settings-main">
                <div class="cli-env-title-line">
                  <div class="settings-name">{{ environment.name }}</div>
                  <span class="cli-env-status" :class="{ available: environment.available }">
                    <CheckSquare v-if="environment.available" :size="12" />
                    <AlertTriangle v-else :size="12" />
                    <span>{{ environment.available ? '可用' : '未找到' }}</span>
                  </span>
                </div>
                <div class="settings-path">{{ environment.launcher }}</div>
                <div v-if="environment.source" class="settings-path">{{ environment.source }}</div>
                <div v-if="environment.issue" class="cli-env-issue">{{ environment.issue }}</div>
              </div>
            </article>
            <div v-if="!store.cliEnvironments.length && !store.cliEnvironmentsLoading" class="empty-hint">未返回 CLI 检测结果。</div>
          </div>
        </section>


        <AutomationTasksPanel v-else-if="activeSection === 'automation'" :preview="preview" />
        <UsageStatsPanel v-else-if="activeSection === 'usage'" />
        <ChannelProbePanel v-else-if="activeSection === 'channels'" class="settings-content-section settings-channel-panel" :preview="preview" />
        <section v-else-if="activeSection === 'plugins'" class="settings-content-section">
          <div class="settings-section-heading">
            <div><div class="section-title">插件</div></div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="preview || !store.pluginEnvironment" @click="store.openPath(store.pluginEnvironment?.pluginRoot ?? '')">全局目录</button>
              <button class="ghost-button small" :disabled="preview || !store.pluginEnvironment?.projectPluginRoot" @click="store.openPath(store.pluginEnvironment?.projectPluginRoot ?? '')">项目目录</button>
              <button class="ghost-button small" :disabled="preview || store.pluginsLoading" @click="store.refreshPlugins()"><RefreshCw :size="13" /><span>{{ store.pluginsLoading ? '刷新中' : '刷新' }}</span></button>
            </div>
          </div>
          <div class="settings-plugin-toolbar">
            <div class="settings-plugin-filters" aria-label="插件来源">
              <button v-for="source in (['all', 'global', 'project'] as const)" :key="source" class="ghost-button small" :class="{ selected: pluginSource === source }" :aria-pressed="pluginSource === source" @click="pluginSource = source"><SourceBadge v-if="source !== 'all'" :kind="source" /><template v-else>全部</template> <span>{{ store.pluginStatuses.filter(plugin => source === 'all' || plugin.source === source).length }}</span></button>
            </div>
            <label class="settings-search settings-plugin-search"><Search :size="14" /><input v-model="pluginSearch" aria-label="搜索插件" placeholder="搜索插件…" type="search" /></label>
          </div>
          <p v-if="store.pluginEnvironment?.allDisabled" class="settings-footnote">所有插件已禁用：{{ store.pluginEnvironment.disabledReason }}</p>
          <div class="settings-plugin-list">
            <article v-for="plugin in filteredPlugins" :key="`${plugin.source}:${plugin.id}`" class="settings-plugin-item">
              <div class="settings-plugin-summary">
                <span class="settings-plugin-icon"><Puzzle :size="22" /></span>
                <div class="settings-main"><div class="settings-name">{{ plugin.name }}</div><div class="settings-path"><SourceBadge :kind="plugin.source" /> · {{ plugin.version }} · {{ pluginStatusLabel(plugin.status) }}</div></div>
                <button class="toggle-button settings-switch" type="button" role="switch" :aria-label="`启用 ${plugin.name}`" :aria-checked="!store.settings.disabledPluginIds.includes(plugin.id) && plugin.status !== 'disabled'" :class="{ active: !store.settings.disabledPluginIds.includes(plugin.id) && plugin.status !== 'disabled' }" :disabled="preview" @click="store.settings.disabledPluginIds.includes(plugin.id) || plugin.status === 'disabled' ? store.enablePlugin(plugin.id) : store.disablePlugin(plugin.id)"><span /></button>
              </div>
              <p v-if="plugin.error || plugin.disabledReason" class="settings-plugin-issue">{{ plugin.error || plugin.disabledReason }}</p>
              <details class="settings-plugin-details">
                <summary>详情</summary>
                <div class="settings-path">{{ plugin.id }} · {{ plugin.rootPath }}</div>
                <div v-if="plugin.mainPath" class="settings-path">入口：{{ plugin.mainPath }}</div>
                <div v-if="plugin.stylePath" class="settings-path">样式：{{ plugin.stylePath }}</div>
                <div v-if="plugin.matchReason" class="settings-path">{{ plugin.matchReason }}</div>
                <div class="settings-inline-actions">
                  <button class="ghost-button small" :disabled="preview" @click="store.openPath(plugin.rootPath)">目录</button>
                  <button class="ghost-button small" :disabled="preview || plugin.status === 'disabled'" @click="store.reloadPlugin(plugin.id)">重载</button>
                </div>
              </details>
            </article>
            <p v-if="!filteredPlugins.length" class="settings-footnote">{{ preview ? '浏览器预览不读取本机插件，请在桌面应用查看已安装列表。' : store.pluginsLoading ? '正在读取插件…' : store.pluginStatuses.length ? '没有匹配的插件。' : '还没有发现全局或当前项目插件。' }}</p>
          </div>
          <details v-if="store.pluginEnvironment" class="settings-plugin-details">
            <summary>目录与诊断</summary>
            <div class="settings-path">全局目录：{{ store.pluginEnvironment.pluginRoot }}</div>
            <div class="settings-path">项目目录：{{ store.pluginEnvironment.projectPluginRoot || '未打开项目' }}</div>
            <div class="settings-path">禁用标记：{{ store.pluginEnvironment.disableFlagPath }}</div>
            <div class="settings-path">日志：{{ store.pluginEnvironment.logPath }}</div>
          </details>
          <ScriptUsagePanel :preview="preview" />
        </section>

        <section v-else-if="activeSection === 'storage'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">数据</div>
            </div>
            <button class="ghost-button small" :disabled="store.appStorageInfoLoading" @click="store.refreshAppStorageInfo()">
              <RefreshCw :size="13" />
              <span>{{ store.appStorageInfoLoading ? '读取中' : '刷新' }}</span>
            </button>
          </div>

          <h3 class="settings-group-title">文件位置</h3>
          <div class="settings-block settings-row-group">
            <div v-for="location in storageLocations" :key="location.label" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">{{ location.label }}</div><div class="settings-path" :title="location.path">{{ location.path || location.empty }}</div></div>
              <button class="ghost-button small" :disabled="!location.path" @click="openStoragePath(location.path)">打开</button>
            </div>
          </div>
          <h3 class="settings-group-title">本机数据</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row"><span class="settings-subtitle">数据库大小</span><span class="settings-value">{{ store.appStorageInfo ? storageSize : '未读取' }}</span></div>
            <div class="settings-option-row"><span class="settings-subtitle">历史工作区</span><span class="settings-value">{{ preview ? '未读取' : store.recentProjects.length }}</span></div>
          </div>
        </section>

        <AppUpdatePanel v-else-if="activeSection === 'updates'" />
        <section v-else class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">外观</div>
            </div>
          </div>
          <h3 class="settings-group-title">主题</h3>
          <div class="settings-block settings-row-group">
            <input ref="themeImportInput" class="visually-hidden" type="file" accept="application/json,.json" @change="importThemes" />
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">自定义主题</div><div class="settings-path">导入主题 JSON；主题会同步应用到界面、编辑器和终端。</div></div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" type="button" @click="openThemeImport"><Palette :size="13" /><span>导入</span></button>
                <button class="ghost-button small" type="button" :disabled="!(store.settings.customThemes?.length)" @click="exportThemes"><Copy :size="13" /><span>导出</span></button>
                <button class="ghost-button small" type="button" @click="exportThemeTemplate"><Copy :size="13" /><span>模板</span></button>
              </div>
            </div>
            <div class="settings-option-row">
              <div class="settings-main"><label class="settings-subtitle" for="settings-theme">界面主题</label><div class="settings-path">统一应用到界面、编辑器和终端</div></div>
              <div ref="themePickerRoot" class="settings-theme-picker" @focusout="onThemePickerFocusOut">
                <button
                  id="settings-theme"
                  class="settings-input settings-theme-trigger"
                  type="button"
                  role="combobox"
                  aria-haspopup="listbox"
                  :aria-expanded="themeMenuOpen"
                  aria-controls="settings-theme-options"
                  @click="toggleThemePicker"
                  @keydown="onThemePickerKeydown"
                >
                  <span>{{ currentTheme.name }}</span>
                  <ChevronDown :size="14" aria-hidden="true" />
                </button>
                <div v-if="themeMenuOpen" id="settings-theme-options" class="settings-theme-menu" role="listbox" aria-label="界面主题选项" @mouseleave="setThemePreview(null)">
                  <div v-for="group in themeGroups" :key="group.id" class="settings-theme-group" role="group" :aria-label="group.label">
                    <div class="settings-theme-group-label">{{ group.label }}</div>
                    <button
                      v-for="theme in group.themes"
                      :id="`settings-theme-option-${theme.id}`"
                      :key="theme.id"
                      class="settings-theme-option"
                      :class="{ selected: theme.id === selectedTheme.id, active: theme.id === themePreviewId }"
                      type="button"
                      role="option"
                      :data-theme-id="theme.id"
                      :aria-selected="theme.id === selectedTheme.id"
                      @mouseenter="previewTheme(theme.id)"
                      @focus="previewTheme(theme.id)"
                      @click="chooseTheme(theme.id)"
                    >
                      <span class="settings-theme-swatch" :style="{ background: theme.colors.bg.primary, borderColor: theme.colors.border }" aria-hidden="true"><i :style="{ background: theme.effects ? `linear-gradient(135deg, ${theme.effects.gradient.join(', ')})` : theme.colors.accent.blue }" /></span>
                      <span>{{ theme.name }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-option-row settings-theme-palette-row">
              <div class="settings-main"><div class="settings-subtitle">完整调色板</div><div class="settings-path">界面、编辑器和终端使用的全部主要颜色</div></div>
              <div class="settings-theme-palette">
                <div v-for="group in themePalette" :key="group.label" class="settings-theme-palette-group">
                  <span class="settings-theme-palette-label">{{ group.label }}</span>
                  <div class="settings-theme-palette-swatches">
                    <span v-for="color in group.colors" :key="`${group.label}-${color.label}`" class="settings-theme-palette-swatch" :title="`${color.label} ${color.value}`">
                      <i :style="{ background: color.value }" aria-hidden="true" />
                      <b>{{ color.label }}</b>
                    </span>
                  </div>
                </div>
                <span v-if="currentTheme.surfaceOpacity" class="settings-theme-opacity">表面透明度 {{ Math.round(currentTheme.surfaceOpacity * 100) }}%</span>
              </div>
            </div>
          </div>
          <h3 class="settings-group-title">字体</h3>
          <div class="settings-block settings-row-group">
            <input ref="fontImportInput" class="visually-hidden" type="file" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" multiple @change="importFonts" />
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">字体风格</div><div class="settings-path">一个风格包可以包含界面、正文和等宽字体；缺少的用途会使用系统字体。</div></div>
              <div class="settings-inline-actions">
                <select id="settings-font-style" class="settings-input settings-theme-select" :value="store.settings.fontStyleId" aria-label="字体风格" @change="store.setFontStyle(($event.target as HTMLSelectElement).value)">
                  <option v-for="style in fontStyleOptions" :key="style.id" :value="style.id">{{ style.name }}</option>
                </select>
                <button class="ghost-button small" type="button" @click="openFontImport"><Upload :size="13" /><span>导入字体</span></button>
              </div>
            </div>
            <div class="settings-option-row settings-font-role-row" v-for="role in (['ui', 'content', 'mono'] as FontRole[])" :key="role">
              <div class="settings-main"><div class="settings-subtitle">{{ FONT_ROLE_LABELS[role] }}</div><div class="settings-path">{{ fontAssetName(selectedFontStyle.roles[role]) }}</div></div>
              <select class="settings-input settings-theme-select" :disabled="!selectedCustomFontStyle" :aria-label="FONT_ROLE_LABELS[role]" :value="selectedFontStyle.roles[role] ?? ''" @change="setFontRole(role, ($event.target as HTMLSelectElement).value)">
                <option value="">系统字体回退</option>
                <option v-for="font in fontAssets" :key="font.id" :value="font.id">{{ font.name }}</option>
              </select>
            </div>
            <div v-if="selectedCustomFontStyle" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">导入风格管理</div><div class="settings-path">删除风格不会删除已导入的字体文件。</div></div>
              <button class="ghost-button small" type="button" @click="removeSelectedFontStyle"><Trash2 :size="13" /><span>删除风格</span></button>
            </div>
          </div>
          <h3 class="settings-group-title">偏好设置</h3>
          <div class="settings-block">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">外部 CMD 全屏启动</div>
                <div class="settings-path">开启后，外部启动 CLI 和移到外部继续对话时，CMD 窗口默认最大化。</div>
              </div>
              <button class="toggle-button settings-switch" type="button" role="switch" aria-label="外部 CMD 全屏启动"
                :class="{ active: store.settings.externalCmdMaximized }" :aria-checked="store.settings.externalCmdMaximized"
                @click="store.setExternalCmdMaximized(!store.settings.externalCmdMaximized)"><span /></button>
            </div>
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">聊天侧栏</div>
                <div class="settings-path">显示聊天模式的会话历史侧栏。</div>
              </div>
              <button class="toggle-button settings-switch" type="button" role="switch" aria-label="聊天侧栏"
                :class="{ active: store.settings.conversationSidebarVisible }" :aria-checked="store.settings.conversationSidebarVisible"
                @click="store.setConversationSidebarVisible(!store.settings.conversationSidebarVisible)"><span /></button>
            </div>
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">侧边活动栏</div>
                <div class="settings-path">隐藏左侧活动栏图标；仍可从顶部“文件”菜单打开设置。</div>
              </div>
              <button class="toggle-button settings-switch" type="button" role="switch" aria-label="侧边活动栏"
                :class="{ active: store.settings.activityBarVisible }" :aria-checked="store.settings.activityBarVisible"
                @click="store.setActivityBarVisible(!store.settings.activityBarVisible)"><span /></button>
            </div>
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">代码预览颜色渲染</div>
                <div class="settings-path">开启后，&amp;7、§7、§#d3d3d3 这类颜色符号会按实际颜色显示。</div>
              </div>
              <button
                class="toggle-button settings-switch"
                :class="{ active: store.settings.renderColorCodes }"
                type="button"
                role="switch"
                :aria-checked="store.settings.renderColorCodes"
                :title="store.settings.renderColorCodes ? '关闭颜色渲染' : '开启颜色渲染'"
                @click="toggleRenderColorCodes"
              >
                <span />
              </button>
            </div>
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">RGBA 标题配色</div>
                <div class="settings-path">开启后，Markdown 渲染标题按标题文字分配稳定的 RGBA 标题色，同名标题同色；关闭后使用主题文字色。</div>
              </div>
              <button
                class="toggle-button settings-switch"
                :class="{ active: store.settings.markdownHeadingColorsEnabled }"
                type="button"
                role="switch"
                aria-label="RGBA 标题配色"
                :aria-checked="store.settings.markdownHeadingColorsEnabled"
                :title="store.settings.markdownHeadingColorsEnabled ? '关闭 RGBA 标题配色' : '开启 RGBA 标题配色'"
                @click="store.setMarkdownHeadingColorsEnabled(!store.settings.markdownHeadingColorsEnabled)"
              >
                <span />
              </button>
            </div>
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">YAML 键值 RGBA 标题配色</div>
                <div class="settings-path">开启后，键值面板中的每个键按 RGBA 标题配色规律分配稳定颜色；编辑器正文仍使用常规键值配色。</div>
              </div>
              <button
                class="toggle-button settings-switch"
                :class="{ active: store.settings.yamlKeyValueCodexColors }"
                type="button"
                role="switch"
                aria-label="YAML 键值 RGBA 标题配色"
                :aria-checked="store.settings.yamlKeyValueCodexColors"
                :title="store.settings.yamlKeyValueCodexColors ? '关闭 RGBA 标题配色' : '开启 RGBA 标题配色'"
                @click="toggleYamlKeyValueCodexColors"
              >
                <span />
              </button>
            </div>
          </div>

        </section>
        </fieldset>
      </main>
    </div>
  </section>
</template>
