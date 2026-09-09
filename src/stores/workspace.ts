import { acceptHMRUpdate, defineStore } from 'pinia'

import { createPluginRuntime, type PluginRuntime } from '@/lib/pluginRuntime'
import { getMonaco } from '@/lib/monaco'
import { backend, isTauri, onProjectServiceStatus, onTerminalExit, onTerminalOutput, onWorkspaceFilesChanged } from '@/lib/tauri'
import { extractPlanBlock, parsePlanDecisions, PLAN_MARKER_END, PLAN_MARKER_START } from '@/lib/planParser'
import { applyTheme, DEFAULT_THEME_ID, getTheme, THEME_IDS } from '@/lib/theme'
import { fileNameFromPath, inferLanguage, isMediaFile, isOfficeDocument, isPlayableMedia, isPreviewableImage, normalizePath } from '@/lib/path'
import type {
  AppSettings,
  AppStorageInfo,
  CliConversationMessage,
  CliHistoryPathCandidate,
  CliNativeConversationDetail,
  CliNativeConversationSummary,
  CliProviderEnvironment,
  DialogueMapPosition,
  DialogueMapViewport,
  DialogueMapWorkspaceState,
  DirectoryListing,
  EditorTab,
  MemoWindowFrame,
  MobileHostConfig,
  MobileHostStatus,
  PlanProposal,
  PluginCommandContribution,
  PluginDescriptor,
  PluginEnvironment,
  ProjectInstructionFileKind,
  ProjectInstructionFiles,
  ProjectServiceRunState,
  ProjectServiceStatus,
  ProjectServiceStatusEvent,
  ProjectServicesStartResult,
  ProjectSearchOptions,
  ProjectStartupInfo,
  ProjectTerminalAction,
  ProjectSearchResult,
  QuickPhrase,
  RecentProject,
  TerminalSession,
  TerminalProviderKind,
  WorkspaceSurfaceKind,
  WorkspaceFilesChangedEvent,
  WorkspaceWatchTarget,
  VitePressDocsInfo,
  VitePressDocWorkspace,
  WorkspaceTabDescriptor,
  Workspace,
} from '@/types'

interface WorkspaceScopedState {
  workspace: Workspace
  directoryCache: Record<string, DirectoryListing>
  expandedPaths: string[]
  loadingDirectories: string[]
  tabs: EditorTab[]
  activeTabId: string | null
  searchQuery: string
  searchResults: ProjectSearchResult | null
  searchOpen: boolean
  searchLoading: boolean
  terminalSessions: TerminalSession[]
  activeTerminalSessionId: string | null
  activeCliSessionId: string | null
  activeLocalTerminalSessionId: string | null
  terminalDrafts?: Record<string, string>
  terminalConversation?: Record<string, CliConversationMessage[]>
  terminalConversationReplyPending?: Record<string, boolean>
  terminalExitCodes?: Record<string, number | null>
  activeWorkspaceSurface: WorkspaceSurfaceKind
  projectEditorEntryPath?: string | null
}

interface DirtyTextTabRef {
  scope: 'current' | 'snapshot'
  workspaceKey: string
  tab: EditorTab
}

interface OpenFileOptions {
  createUnsupportedTabOnError?: boolean
  preserveCodePreviewScope?: boolean
  revealInExplorer?: boolean
  skipWorkspaceWatchSync?: boolean
  verifyExistingFile?: boolean
}

async function readEditorFile(path: string): Promise<Pick<EditorTab, 'content' | 'contentType' | 'language'>> {
  if (isPreviewableImage(path)) {
    return { content: await backend.readImageAsDataUrl(path), contentType: 'image', language: 'image' }
  }
  if (isOfficeDocument(path)) {
    return { content: await backend.readOfficeFileBase64(path), contentType: 'office', language: 'office' }
  }
  if (isPlayableMedia(path)) {
    return { content: await backend.readMediaAsDataUrl(path), contentType: 'media', language: 'media' }
  }
  return { content: await backend.readFile(path), contentType: 'text', language: inferLanguage(path) }
}

interface PersistedTerminalState {
  version: 1
  savedAt: string
  terminalSessions: TerminalSession[]
  activeTerminalSessionId: string | null
  activeCliSessionId: string | null
  activeLocalTerminalSessionId: string | null
  terminalDrafts: Record<string, string>
  terminalConversation: Record<string, CliConversationMessage[]>
  terminalExitCodes: Record<string, number | null>
}

interface TerminalStateSource {
  terminalSessions: TerminalSession[]
  activeTerminalSessionId: string | null
  activeCliSessionId: string | null
  activeLocalTerminalSessionId: string | null
  terminalDrafts: Record<string, string>
  terminalConversation: Record<string, CliConversationMessage[]>
  terminalConversationReplyPending: Record<string, boolean>
  terminalExitCodes: Record<string, number | null>
}

const COMPACT_EXPLORER_WIDTH = 192
const LEGACY_DEFAULT_EXPLORER_WIDTH = 240
const DEFAULT_MEMO_WINDOW_WIDTH = 760
const DEFAULT_MEMO_WINDOW_HEIGHT = 620
const MIN_MEMO_WINDOW_WIDTH = 520
const MIN_MEMO_WINDOW_HEIGHT = 360

function normalizeMemoWindowFrame(frame?: Partial<MemoWindowFrame> | null): MemoWindowFrame {
  const finitePosition = (value: unknown) => (
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
  )
  const finiteSize = (value: unknown, fallback: number, minimum: number) => (
    typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, value) : fallback
  )
  return {
    left: finitePosition(frame?.left),
    top: finitePosition(frame?.top),
    width: finiteSize(frame?.width, DEFAULT_MEMO_WINDOW_WIDTH, MIN_MEMO_WINDOW_WIDTH),
    height: finiteSize(frame?.height, DEFAULT_MEMO_WINDOW_HEIGHT, MIN_MEMO_WINDOW_HEIGHT),
  }
}

function defaultSettings(): AppSettings {
  return {
    themeId: DEFAULT_THEME_ID,
    disabledPluginIds: [],
    hiddenProjectPaths: [],
    projectNicknames: {},
    projectCategories: {},
    quickPhrases: [],
    activePreviewMode: 'local_terminal',
    multiTerminalMode: false,
    dialogueMapMode: false,
    dialogueMapByWorkspace: {},
    projectLayoutMode: 'default',
    renderColorCodes: false,
    yamlKeyValuePanelEnabled: false,
    htmlPreviewEnabled: true,
    autoSave: 'off',
    autoSaveDelay: 1000,
    mobileHost: {
      port: 10320,
      token: '',
    },
    memoWindowFrame: normalizeMemoWindowFrame(),
    panelLayout: {
      conversationWidth: 520,
      explorerWidth: COMPACT_EXPLORER_WIDTH,
      previewWidth: 520,
      terminalHeight: 250,
    },
  }
}

function defaultDialogueMapWorkspaceState(): DialogueMapWorkspaceState {
  return {
    viewport: { x: 72, y: 72, zoom: 1 },
    positions: {},
  }
}

function normalizeDialogueMapViewport(viewport?: Partial<DialogueMapViewport> | null): DialogueMapViewport {
  const numberOr = (value: unknown, fallback: number) => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  )
  return {
    x: numberOr(viewport?.x, 72),
    y: numberOr(viewport?.y, 72),
    zoom: Math.max(0.45, Math.min(2.2, numberOr(viewport?.zoom, 1))),
  }
}

function normalizeDialogueMapState(value?: Partial<DialogueMapWorkspaceState> | null): DialogueMapWorkspaceState {
  const positions: Record<string, DialogueMapPosition> = {}
  for (const [id, position] of Object.entries(value?.positions ?? {})) {
    if (!position || typeof position !== 'object') continue
    const x = Number((position as DialogueMapPosition).x)
    const y = Number((position as DialogueMapPosition).y)
    if (Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y }
  }
  return {
    viewport: normalizeDialogueMapViewport(value?.viewport),
    positions,
  }
}

function normalizeDialogueMapStates(value: unknown): Record<string, DialogueMapWorkspaceState> {
  if (!value || typeof value !== 'object') return {}
  return Object.entries(value as Record<string, Partial<DialogueMapWorkspaceState>>)
    .reduce<Record<string, DialogueMapWorkspaceState>>((states, [key, state]) => {
      if (key.trim()) states[key] = normalizeDialogueMapState(state)
      return states
    }, {})
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function randomId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })
}

// 终端动作等待工作区退出或客户端窗口释放时使用，保持调用链可读。
function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)))
}

function parentDirectoryOf(path: string): string {
  const normalized = normalizeFilePath(path).replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index === 2 && normalized[1] === ':') return normalized.slice(0, 3)
  return index > 0 ? normalized.slice(0, index) : normalized
}

function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, '/')
}

// 本地终端动作写入控制台命令时统一补 CR，兼容 Windows PTY。
function terminalInputLine(input: string): string {
  const value = input.trim() || 'stop'
  return value.endsWith('\r') || value.endsWith('\n') ? value : `${value}\r`
}

function normalizeDirectorySettingPath(path: string): string {
  const normalized = normalizeFilePath(path.trim())
  if (!normalized || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, '')
}


function joinWorkspacePath(rootPath: string | null | undefined, relativePath: string): string {
  const cleanRelativePath = normalizeFilePath(relativePath).replace(/^\/+/, '')
  if (!rootPath) return cleanRelativePath
  return joinPath(rootPath, cleanRelativePath)
}

function joinPath(parent: string, name: string): string {
  const cleanParent = normalizeFilePath(parent).replace(/\/+$/, '')
  const cleanName = normalizeFilePath(name).replace(/^\/+/, '')
  return `${cleanParent}/${cleanName}`
}

function isSameOrChildPath(path: string, target: string): boolean {
  const normalized = normalizeFilePath(path).replace(/\/+$/, '').toLowerCase()
  const normalizedTarget = normalizeFilePath(target).replace(/\/+$/, '').toLowerCase()
  return normalized === normalizedTarget || normalized.startsWith(`${normalizedTarget}/`)
}

function relativePathInWorkspace(path: string, rootPath: string): string {
  const normalizedPath = normalizeFilePath(path)
  const normalizedRoot = normalizeFilePath(rootPath).replace(/\/+$/, '')
  if (normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }
  return normalizedPath
}

function replacePathPrefix(path: string, currentPrefix: string, nextPrefix: string): string {
  const normalized = normalizeFilePath(path)
  const current = normalizeFilePath(currentPrefix).replace(/\/+$/, '')
  const next = normalizeFilePath(nextPrefix).replace(/\/+$/, '')
  const lowerPath = normalized.toLowerCase()
  const lowerCurrent = current.toLowerCase()
  if (lowerPath === lowerCurrent) return next
  if (lowerPath.startsWith(`${lowerCurrent}/`)) {
    return `${next}${normalized.slice(current.length)}`
  }
  return normalized
}

function directoryChainBetween(rootPath: string, directoryPath: string): string[] {
  const root = normalizeFilePath(rootPath).replace(/\/+$/, '')
  const directory = normalizeFilePath(directoryPath).replace(/\/+$/, '')
  if (!isSameOrChildPath(directory, root)) return []
  if (workspaceKey(directory) === workspaceKey(root)) return [root]

  const relative = directory.slice(root.length).replace(/^\/+/, '')
  if (!relative) return [root]
  const paths = [root]
  let cursor = root
  for (const segment of relative.split('/').filter(Boolean)) {
    cursor = joinPath(cursor, segment)
    paths.push(cursor)
  }
  return paths
}

const GENERIC_PROJECT_NAMES = new Set(['plugin', 'plugins', 'node_modules', 'dist', 'src'])
const WORKSPACE_FILE_REFRESH_DELAY_MS = 120
const SEARCH_DEBOUNCE_MS = 120
const METADATA_REFRESH_THROTTLE_MS = 5000
const directoryLoadTasks = new Map<string, Promise<void>>()
let workspaceSwitchToken = 0
let searchDebounceTimer: number | null = null
let pluginRuntime: PluginRuntime | null = null
let pluginRuntimeOwner: object | null = null
let pluginRefreshSequence = 0
let activityMessageTimer: number | null = null
let errorMessageTimer: number | null = null
const ACTIVITY_MESSAGE_DURATION_MS = 3000
const ERROR_MESSAGE_DURATION_MS = 8000
// Plan 检测：每个 CLI 会话累积一个滑动 buffer，检测到完整标记块后 debounce 再解析。
const PLAN_DETECTION_DELAY_MS = 600
const PLAN_MARKER_BUFFER_LENGTH = 8000
const planDetectionTimers = new Map<string, number>()
const planMarkerBuffers = new Map<string, string>()
// terminal-output 也由 xterm 直接消费；工作区只需低频汇总对话和 Plan，避免每个 PTY 分片都阻塞渲染线程。
const TERMINAL_OUTPUT_BATCH_DELAY_MS = 80
const TERMINAL_OUTPUT_BACKLOG_DELAY_MS = 16
const TERMINAL_OUTPUT_BATCH_MAX_LENGTH = 64 * 1024
const terminalOutputBuffers = new Map<string, string[]>()
const terminalOutputBufferLengths = new Map<string, number>()
const terminalOutputFlushTimers = new Map<string, number>()
const terminalOutputPendingExits = new Map<string, number | null>()
const TERMINAL_STATE_FILE_NAME = 'terminal-state.json'
const TERMINAL_STATE_PERSIST_DELAY_MS = 500
const TERMINAL_CONVERSATION_MESSAGE_LIMIT = 160
const TERMINAL_MESSAGE_CONTENT_LIMIT = 20000
const TERMINAL_REPLY_IDLE_MS = 1800
const WORKSPACE_WATCH_SYNC_DELAY_MS = 120
const terminalStatePersistTimers = new Map<string, number>()
const terminalReplyIdleTimers = new Map<string, number>()
let workspaceWatchSyncTimer: number | null = null
let lastWorkspaceWatchTargetsKey = ''
let workspaceWatchSyncQueue: Promise<unknown> = Promise.resolve()
let searchDebounceResolve: (() => void) | null = null
let searchRequestToken = 0
let projectStartupConfigRefreshToken = 0
let projectTerminalActionsRefreshToken = 0
let backendEventUnlisteners: Array<() => void> = []
let backendEventListenersDisposed = false

function workspaceKey(rootPath: string): string {
  return normalizeFilePath(rootPath).replace(/\/+$/, '').toLowerCase()
}

function terminalStateFilePath(rootPath: string): string {
  return `${normalizeFilePath(rootPath).replace(/\/+$/, '')}/.superhigh/${TERMINAL_STATE_FILE_NAME}`
}

function terminalStateDirectory(rootPath: string): string {
  return `${normalizeFilePath(rootPath).replace(/\/+$/, '')}/.superhigh`
}

function truncateTerminalMessageContent(content: string): string {
  if (content.length <= TERMINAL_MESSAGE_CONTENT_LIMIT) return content
  return `${content.slice(0, TERMINAL_MESSAGE_CONTENT_LIMIT).trimEnd()}\n...`
}

function normalizeTerminalMessages(messages: CliConversationMessage[] | undefined): CliConversationMessage[] {
  return (messages ?? [])
    .filter((message) => message && typeof message.id === 'string' && typeof message.sessionId === 'string')
    .slice(-TERMINAL_CONVERSATION_MESSAGE_LIMIT)
    .map((message) => ({
      ...message,
      content: truncateTerminalMessageContent(String(message.content ?? '')),
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString(),
      role: message.role === 'user' ? 'user' : 'system',
    }))
}

function normalizeTerminalConversation(
  conversation: Record<string, CliConversationMessage[]>,
): Record<string, CliConversationMessage[]> {
  const next: Record<string, CliConversationMessage[]> = {}
  for (const [sessionId, messages] of Object.entries(conversation)) {
    const normalized = normalizeTerminalMessages(messages)
    if (normalized.length) next[sessionId] = normalized
  }
  return next
}

function emptyTerminalStateSource(): TerminalStateSource {
  return {
    terminalSessions: [],
    activeTerminalSessionId: null,
    activeCliSessionId: null,
    activeLocalTerminalSessionId: null,
    terminalDrafts: {},
    terminalConversation: {},
    terminalConversationReplyPending: {},
    terminalExitCodes: {},
  }
}

function terminalSessionIsLive(session: TerminalSession | null | undefined): session is TerminalSession {
  return !!session && !session.restoredFromDisk
}

function isProjectManagedTerminalSessionKind(kind: string): boolean {
  return kind === 'project-startup' || kind === 'project-service'
}

function isLocalTerminalSessionKind(kind: string): boolean {
  return kind === 'local' || isProjectManagedTerminalSessionKind(kind)
}

function deriveProjectServiceChainStatus(services: ProjectServiceRunState['services']): ProjectServiceRunState['chainStatus'] {
  const values = Object.values(services)
  if (!values.length) return 'idle'
  if (values.some((service) => service.status === 'failed')) return 'failed'
  if (values.some((service) => service.status === 'starting')) return 'starting'
  if (values.every((service) => service.status === 'running' || service.status === 'externalRunning')) return 'running'
  if (values.some((service) => service.status === 'running' || service.status === 'externalRunning' || service.status === 'exited')) return 'partial'
  return 'idle'
}

function terminalSessionShouldPersist(
  session: TerminalSession,
  conversation: Record<string, CliConversationMessage[]>,
  drafts: Record<string, string>,
): boolean {
  if (isProjectManagedTerminalSessionKind(session.providerKind)) {
    return true
  }
  if (isLocalTerminalSessionKind(session.providerKind)) {
    return !!conversation[session.id]?.length || !!drafts[session.id]?.trim()
  }
  return true
}

function buildPersistedTerminalStateFromSource(source: TerminalStateSource): PersistedTerminalState {
  const terminalSessions = source.terminalSessions
    .filter((session) => terminalSessionShouldPersist(session, source.terminalConversation, source.terminalDrafts))
  const sessionIds = new Set(terminalSessions.map((session) => session.id))
  const terminalConversation: Record<string, CliConversationMessage[]> = {}
  for (const session of terminalSessions) {
    const messages = normalizeTerminalMessages(source.terminalConversation[session.id])
    if (messages.length) terminalConversation[session.id] = messages
  }
  const terminalDrafts: Record<string, string> = {}
  for (const [sessionId, draft] of Object.entries(source.terminalDrafts)) {
    if (sessionIds.has(sessionId) && draft) terminalDrafts[sessionId] = draft
  }
  const terminalExitCodes: Record<string, number | null> = {}
  for (const [sessionId, exitCode] of Object.entries(source.terminalExitCodes)) {
    if (sessionIds.has(sessionId)) terminalExitCodes[sessionId] = exitCode
  }
  const activeTerminalSessionId = source.activeTerminalSessionId && sessionIds.has(source.activeTerminalSessionId)
    ? source.activeTerminalSessionId
    : null
  const activeCliSessionId = source.activeCliSessionId && sessionIds.has(source.activeCliSessionId)
    ? source.activeCliSessionId
    : null
  const activeLocalTerminalSessionId = source.activeLocalTerminalSessionId && sessionIds.has(source.activeLocalTerminalSessionId)
    ? source.activeLocalTerminalSessionId
    : null

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    terminalSessions,
    activeTerminalSessionId,
    activeCliSessionId,
    activeLocalTerminalSessionId,
    terminalDrafts,
    terminalConversation,
    terminalExitCodes,
  }
}

function clearTerminalSessionRuntimeState(sessionId: string) {
  const outputTimer = terminalOutputFlushTimers.get(sessionId)
  if (outputTimer) window.clearTimeout(outputTimer)
  terminalOutputFlushTimers.delete(sessionId)
  terminalOutputBuffers.delete(sessionId)
  terminalOutputBufferLengths.delete(sessionId)
  terminalOutputPendingExits.delete(sessionId)

  const planTimer = planDetectionTimers.get(sessionId)
  if (planTimer) window.clearTimeout(planTimer)
  planDetectionTimers.delete(sessionId)
  planMarkerBuffers.delete(sessionId)

  const replyTimer = terminalReplyIdleTimers.get(sessionId)
  if (replyTimer) window.clearTimeout(replyTimer)
  terminalReplyIdleTimers.delete(sessionId)
}

function stableWorkspaceWatchTargetsKey(targets: WorkspaceWatchTarget[]): string {
  return JSON.stringify(targets.map((target) => ({
    rootPath: normalizeFilePath(target.rootPath),
    directories: normalizedUniquePaths(target.directories).sort(),
  })).sort((left, right) => left.rootPath.localeCompare(right.rootPath)))
}

function hasDirtyTextTabs(tabs: EditorTab[]): boolean {
  return tabs.some((tab) => tab.contentType === 'text' && tab.isDirty)
}

function normalizedUniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(normalizeFilePath).filter(Boolean)))
}

function normalizedUniquePathKeys(paths: string[]): Set<string> {
  return new Set(normalizedUniquePaths(paths).map((path) => path.toLowerCase()))
}

function findLastMessageIndex(messages: CliConversationMessage[], role: CliConversationMessage['role']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) return index
  }
  return -1
}

function summarizeTerminalReply(value: string, lastUserMessage = ''): string {
  const text = normalizeTerminalDialogueLine(stripTerminalAnsi(value))
  if (!text || text === lastUserMessage.trim()) return ''
  return text
}

function normalizeTerminalDialogueLine(value: string): string {
  return value.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
}

function mergeTerminalReplyText(current: string, addition: string): string {
  if (!addition || current.endsWith(addition)) return current
  return current ? `${current}\n${addition}` : addition
}

function stripTerminalAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><~])/g, '')
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function shouldRefreshDirectory(
  directory: string,
  cache: Record<string, DirectoryListing>,
  expandedPaths: string[],
  rootPath: string,
  includeExpanded: boolean,
): boolean {
  const normalized = normalizeFilePath(directory)
  if (!isSameOrChildPath(normalized, rootPath)) return false
  return workspaceKey(normalized) === workspaceKey(rootPath)
    || Object.keys(cache).some((path) => workspaceKey(path) === workspaceKey(normalized))
    || (includeExpanded && expandedPaths.some((path) => workspaceKey(path) === workspaceKey(normalized)))
}

function directoriesToRefreshForWorkspaceChanges(
  events: WorkspaceFilesChangedEvent[],
  cache: Record<string, DirectoryListing>,
  expandedPaths: string[],
  rootPath: string,
  includeExpanded: boolean,
): string[] {
  const candidates = new Set<string>()
  for (const event of events) {
    for (const directory of event.affectedDirectories ?? []) {
      candidates.add(normalizeFilePath(directory))
    }
    for (const changedPath of event.changedPaths ?? []) {
      candidates.add(parentDirectoryOf(changedPath))
    }
  }
  return Array.from(candidates).filter((directory) => (
    shouldRefreshDirectory(directory, cache, expandedPaths, rootPath, includeExpanded)
  ))
}

function pruneDirectoryCacheForChangedPaths(
  cache: Record<string, DirectoryListing>,
  changedPaths: string[],
  preservedDirectories: string[] = [],
) {
  const normalizedChangedPaths = normalizedUniquePaths(changedPaths)
  const preservedKeys = new Set(preservedDirectories.map((path) => workspaceKey(normalizeFilePath(path))))
  if (!normalizedChangedPaths.length) return
  for (const cachedPath of Object.keys(cache)) {
    if (preservedKeys.has(workspaceKey(cachedPath))) continue
    if (normalizedChangedPaths.some((changedPath) => {
      const parentDirectory = parentDirectoryOf(changedPath)
      return cachedPath === parentDirectory || isSameOrChildPath(cachedPath, changedPath)
    })) {
      delete cache[cachedPath]
    }
  }
}

function docsWorkspaceFromInfo(info: VitePressDocsInfo, status?: VitePressDocWorkspace['status']): VitePressDocWorkspace {
  return {
    ...info,
    status: status ?? (info.running ? 'running' : 'detected'),
    error: undefined,
  }
}

function workspaceLabelForPath(
  rootPath: string,
  settings: AppSettings,
  workspace?: Workspace | null,
  recent?: RecentProject | null,
): string {
  const nickname = settings.projectNicknames[rootPath]?.trim()
  if (nickname) return nickname
  const displayName = (workspace?.displayName ?? workspace?.name ?? recent?.name ?? '').trim()
  if (displayName) return displayName
  return fileNameFromPath(rootPath) || '工作区'
}


function nextPluginRefreshSequence(): number {
  pluginRefreshSequence += 1
  return pluginRefreshSequence
}

function isCurrentPluginRefreshSequence(sequence: number): boolean {
  return sequence === pluginRefreshSequence
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    initialized: false,
    startupMediaPath: null as string | null,
    workspace: null as Workspace | null,
    workspaceSnapshots: {} as Record<string, WorkspaceScopedState>,
    openWorkspacePaths: [] as string[],
    docsTabOpenPaths: [] as string[],
    docsWorkspaces: {} as Record<string, VitePressDocWorkspace>,
    activeWorkspaceSurface: 'project' as WorkspaceSurfaceKind,
    scriptToolsOpen: false,
    memoWindowOpen: false,
    recentProjects: [] as RecentProject[],
    settings: defaultSettings(),
    pluginEnvironment: null as PluginEnvironment | null,
    pluginStatuses: [] as PluginDescriptor[],
    pluginCommands: [] as PluginCommandContribution[],
    pluginsLoading: false,
    directoryCache: {} as Record<string, DirectoryListing>,
    expandedPaths: [] as string[],
    loadingDirectories: [] as string[],
    tabs: [] as EditorTab[],
    activeTabId: null as string | null,
    codePreviewScopePath: null as string | null,
    projectEditorEntryPath: null as string | null,
    codePreviewProjectEditorOpen: false,
    searchQuery: '',
    searchResults: null as ProjectSearchResult | null,
    searchOpen: false,
    searchLoading: false,
    projectInstructionFiles: null as ProjectInstructionFiles | null,
    projectInstructionFilesLoading: false,
    settingsOpen: false,
    newConversationDialogOpen: false,
    markdownPreviewEnabled: true,
    autoSaveTimer: null as number | null,
    fileConflictPaths: {} as Record<string, boolean>,
    activityMessage: '',
    errorMessage: '',
    terminalSessions: [] as TerminalSession[],
    activeTerminalSessionId: null as string | null,
    activeCliSessionId: null as string | null,
    activeLocalTerminalSessionId: null as string | null,
    terminalDrafts: {} as Record<string, string>,
    terminalConversation: {} as Record<string, CliConversationMessage[]>,
    cliHistoryMessages: [] as CliConversationMessage[],
    cliHistoryPaths: [] as CliHistoryPathCandidate[],
    nativeCliConversations: [] as CliNativeConversationSummary[],
    nativeCliConversationsLoading: false,
    nativeCliConversationsRootPath: '' as string,
    terminalConversationReplyPending: {} as Record<string, boolean>,
    terminalExitCodes: {} as Record<string, number | null>,
    projectStartupConfig: null as ProjectStartupInfo | null,
    projectStartupConfigRootPath: '' as string,
    projectStartupConfigLoading: false,
    projectTerminalActions: [] as ProjectTerminalAction[],
    projectTerminalActionsRootPath: '' as string,
    projectTerminalActionsLoading: false,
    projectTerminalActionBusy: {} as Record<string, boolean>,
    projectServiceRun: null as ProjectServiceRunState | null,
    projectServicesStarting: false,
    cliEnvironments: [] as CliProviderEnvironment[],
    cliEnvironmentsLoading: false,
    mobileHostConfig: null as MobileHostConfig | null,
    mobileHostStatus: null as MobileHostStatus | null,
    mobileHostLoading: false,
    appStorageInfo: null as AppStorageInfo | null,
    appStorageInfoLoading: false,
    listenersBound: false,
    workspaceFileRefreshTimers: {} as Record<string, number>,
    pendingWorkspaceFileChanges: {} as Record<string, WorkspaceFilesChangedEvent[]>,
    pendingDirectoryRefreshes: {} as Record<string, boolean>,
    pendingWorkspaceCloseRootPath: null as string | null,
    metadataRefreshTimer: null as number | null,
    explorerFocusedPath: null as string | null,
    explorerRevealRequestId: 0,
    cliPlans: {} as Record<string, PlanProposal[]>,
  }),
  getters: {
    rootListing(state) {
      return state.workspace ? state.directoryCache[state.workspace.rootPath] ?? null : null
    },
    activeTab(state) {
      return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
    },
    activeTerminalSession(state) {
      return state.terminalSessions.find((session) => session.id === state.activeTerminalSessionId && terminalSessionIsLive(session)) ?? null
    },
    cliTerminalSessions(state) {
      return state.terminalSessions.filter((session) => !isLocalTerminalSessionKind(session.providerKind))
    },
    localTerminalSessions(state) {
      return state.terminalSessions.filter((session) => terminalSessionIsLive(session) && isLocalTerminalSessionKind(session.providerKind))
    },
    activeCliTerminalSession(state) {
      return state.terminalSessions.find((session) => session.id === state.activeCliSessionId && !isLocalTerminalSessionKind(session.providerKind)) ?? null
    },
    activeLocalTerminalSession(state) {
      return state.terminalSessions.find((session) => session.id === state.activeLocalTerminalSessionId && terminalSessionIsLive(session)) ?? null
    },
    currentThemeId(state) {
      return state.settings.themeId
    },
    currentTheme(state) {
      return getTheme(state.settings.themeId)
    },
    currentProjectTitle(state): string {
      const rootPath = state.workspace?.rootPath ?? ''
      const nickname = rootPath ? state.settings.projectNicknames[rootPath]?.trim() : ''
      if (nickname) return nickname
      const displayName = (state.workspace?.displayName ?? state.workspace?.name ?? '').trim()
      if (!displayName || GENERIC_PROJECT_NAMES.has(displayName.toLowerCase())) return '当前项目'
      return displayName
    },
    recentProjectTitle(state) {
      return (project: RecentProject): string => {
        const nickname = state.settings.projectNicknames[project.path]?.trim()
        return nickname || project.name
      }
    },
    visibleRecentProjects(state): RecentProject[] {
      const hidden = new Set(state.settings.hiddenProjectPaths.map((path) => workspaceKey(path)))
      return state.recentProjects.filter((project) => !hidden.has(workspaceKey(project.path)))
    },
    workspaceTabs(state): WorkspaceTabDescriptor[] {
      const activeKey = workspaceKey(state.workspace?.rootPath ?? '')
      const docsOpenKeys = new Set(state.docsTabOpenPaths.map((path) => workspaceKey(path)))
      return state.openWorkspacePaths.flatMap((rootPath) => {
        const key = workspaceKey(rootPath)
        const workspace = activeKey === key
          ? state.workspace
          : state.workspaceSnapshots[key]?.workspace ?? null
        const recent = state.recentProjects.find((project) => workspaceKey(project.path) === key) ?? null
        const label = workspaceLabelForPath(rootPath, state.settings, workspace, recent)
        const tabs: WorkspaceTabDescriptor[] = [{
          id: `project:${key}`,
          kind: 'project',
          rootPath,
          label,
          title: rootPath,
          active: key === activeKey && state.activeWorkspaceSurface !== 'docs' && !state.settingsOpen,
        }]
        if (docsOpenKeys.has(key)) {
          const docs = state.docsWorkspaces[key]
          tabs.push({
            id: `docs:${key}`,
            kind: 'docs',
            rootPath,
            label: `${label}文档`,
            title: docs?.docsRoot || rootPath,
            active: key === activeKey && state.activeWorkspaceSurface === 'docs' && !state.settingsOpen,
          })
        }
        return tabs
      })
    },
    activeDocWorkspace(state): VitePressDocWorkspace | null {
      const rootPath = state.workspace?.rootPath
      if (!rootPath) return null
      return state.docsWorkspaces[workspaceKey(rootPath)] ?? null
    },
    dirtyTextTabs(state): DirtyTextTabRef[] {
      const refs: DirtyTextTabRef[] = []
      const currentKey = state.workspace?.rootPath ? workspaceKey(state.workspace.rootPath) : ''
      for (const tab of state.tabs) {
        if (tab.contentType === 'text' && tab.isDirty) {
          refs.push({ scope: 'current', workspaceKey: currentKey, tab })
        }
      }
      for (const [key, snapshot] of Object.entries(state.workspaceSnapshots)) {
        if (key === currentKey) continue
        for (const tab of snapshot.tabs) {
          if (tab.contentType === 'text' && tab.isDirty) {
            refs.push({ scope: 'snapshot', workspaceKey: key, tab })
          }
        }
      }
      return refs
    },
    hasDirtyTextTabs(): boolean {
      return this.dirtyTextTabs.length > 0
    },
    currentProjectInstructionFiles(state): ProjectInstructionFiles | null {
      if (!state.workspace?.rootPath || !state.projectInstructionFiles) return null
      return workspaceKey(state.projectInstructionFiles.projectPath) === workspaceKey(state.workspace.rootPath)
        ? state.projectInstructionFiles
        : null
    },
  },
  actions: {

    ensurePluginRuntime() {
      if (pluginRuntime && pluginRuntimeOwner === this) return pluginRuntime

      pluginRuntime?.disposeAll()
      pluginRuntimeOwner = this
      let runtime!: PluginRuntime
      runtime = createPluginRuntime({
        listPlugins: (workspace) => backend.listPlugins(workspace),
        readPluginAsset: (pluginId, relativePath, workspace) => backend.readPluginAsset(pluginId, relativePath, workspace),
        execPluginShell: (request) => backend.execPluginShell(request),
        getUnsafe: () => ({
          window,
          document,
          monaco: getMonaco(),
          store: this,
          backend,
          tauriInvoke: backend,
        }),
        getWorkspaceApi: () => ({
          rootPath: this.workspace?.rootPath ?? '',
          name: this.workspace?.name ?? '',
          exists: async (relativePath: string) => {
            if (!this.workspace) return false
            const path = joinWorkspacePath(this.workspace.rootPath, relativePath)
            try {
              await backend.listDirectory(path)
              return true
            } catch {
              try {
                await backend.readFile(path)
                return true
              } catch {
                return false
              }
            }
          },
          list: async (relativePath = '') => {
            if (!this.workspace) return []
            const path = joinWorkspacePath(this.workspace.rootPath, relativePath)
            const listing = await backend.listDirectory(path)
            return listing.entries ?? listing
          },
          readText: (relativePath: string) => backend.readFile(joinWorkspacePath(this.workspace?.rootPath, relativePath)),
          writeText: (relativePath: string, text: string) => backend.writeFile(joinWorkspacePath(this.workspace?.rootPath, relativePath), text),
          search: (options: { query: string; includeText?: boolean; limit?: number }) => backend.searchProjectFiles(
            options.query,
            this.workspace ? [this.workspace.rootPath] : [],
            {
              includeText: options.includeText,
              limit: options.limit,
            },
          ),
          openFile: (relativePath: string, line?: number) => this.openPluginFile(relativePath, line),
          copyPath: async (relativePath: string, line?: number) => {
            const path = joinWorkspacePath(this.workspace?.rootPath, relativePath).replace(/\\/g, '/')
            await navigator.clipboard?.writeText(line ? `${path}:${line}` : path)
          },
        }),
        getEditorApi: () => ({
          getActiveFile: () => this.activeTab?.path ?? null,
          getText: () => this.activeTab?.contentType === 'text' ? this.activeTab.content : '',
          setText: (text: string) => this.updateActiveTabContent(text),
          insertText: (text: string) => window.dispatchEvent(new CustomEvent('superhigh:plugin-editor-insert', { detail: { text } })),
          replaceSelection: (text: string) => window.dispatchEvent(new CustomEvent('superhigh:plugin-editor-replace-selection', { detail: { text } })),
          registerCompletionProvider: () => () => undefined,
          registerHoverProvider: () => () => undefined,
          registerCodeActionProvider: () => () => undefined,
          registerDecorationProvider: () => () => undefined,
        }),
        showToast: (message) => this.showActivityMessage(message),
        onChanged: () => {
          if (this.isCurrentPluginRuntime(runtime)) {
            this.syncPluginRuntimeState(runtime)
          }
        },
      })
      pluginRuntime = runtime
      return runtime
    },

    isCurrentPluginRuntime(runtime: PluginRuntime | null) {
      return Boolean(runtime && pluginRuntime === runtime && pluginRuntimeOwner === this)
    },

    syncPluginRuntimeState(runtime: PluginRuntime | null = pluginRuntime) {
      if (!runtime || !this.isCurrentPluginRuntime(runtime)) return
      const currentRuntime = runtime
      this.pluginEnvironment = currentRuntime.getEnvironment()
      this.pluginStatuses = currentRuntime.getStatuses()
      this.pluginCommands = currentRuntime.getCommands()
    },

    clearPluginRuntimeState() {
      this.pluginEnvironment = null
      this.pluginStatuses = []
      this.pluginCommands = []
    },

    resetPluginRuntimeState() {
      nextPluginRefreshSequence()
      this.pluginsLoading = false
      const runtime = pluginRuntime
      pluginRuntime = null
      pluginRuntimeOwner = null
      try {
        runtime?.disposeAll()
      } catch {
        // Preserve teardown even if a plugin cleanup hook fails.
      }
      this.clearPluginRuntimeState()
    },

    async refreshPlugins() {
      if (!isTauri()) return
      const refreshSequence = nextPluginRefreshSequence()
      this.pluginsLoading = true
      let runtime: PluginRuntime | null = null
      let operationIsLatest = true
      try {
        runtime = this.ensurePluginRuntime()
        await runtime.refresh(this.workspace, this.settings.disabledPluginIds)
        operationIsLatest = isCurrentPluginRefreshSequence(refreshSequence)
        if (this.isCurrentPluginRuntime(runtime) && operationIsLatest) {
          this.syncPluginRuntimeState(runtime)
        }
      } catch (error) {
        operationIsLatest = isCurrentPluginRefreshSequence(refreshSequence)
        if (this.isCurrentPluginRuntime(runtime) && operationIsLatest) {
          this.resetPluginRuntimeState()
          this.showErrorMessage(`插件刷新失败：${formatError(error)}`)
        }
      } finally {
        if (operationIsLatest) {
          this.pluginsLoading = false
        }
      }
    },

    async runPluginCommand(id: string) {
      try {
        await this.ensurePluginRuntime().runCommand(id)
        this.syncPluginRuntimeState()
      } catch (error) {
        this.showErrorMessage(`插件命令失败：${formatError(error)}`)
      }
    },

    async disablePlugin(id: string) {
      if (!this.settings.disabledPluginIds.includes(id)) {
        this.settings.disabledPluginIds = [...this.settings.disabledPluginIds, id]
        await this.saveSettings()
      }
      await this.refreshPlugins()
    },

    async enablePlugin(id: string) {
      this.settings.disabledPluginIds = this.settings.disabledPluginIds.filter((item) => item !== id)
      await this.saveSettings()
      await this.refreshPlugins()
    },

    async reloadPlugin(id: string) {
      if (this.settings.disabledPluginIds.includes(id)) return
      if (!isTauri()) return
      const refreshSequence = nextPluginRefreshSequence()
      this.pluginsLoading = true
      let runtime: PluginRuntime | null = null
      let operationIsLatest = true
      try {
        runtime = this.ensurePluginRuntime()
        await runtime.refresh(this.workspace, [...this.settings.disabledPluginIds, id])
        operationIsLatest = isCurrentPluginRefreshSequence(refreshSequence)
        if (!operationIsLatest) return
        if (this.isCurrentPluginRuntime(runtime)) {
          this.syncPluginRuntimeState(runtime)
        }
        await runtime.refresh(this.workspace, this.settings.disabledPluginIds)
        operationIsLatest = isCurrentPluginRefreshSequence(refreshSequence)
        if (this.isCurrentPluginRuntime(runtime) && operationIsLatest) {
          this.syncPluginRuntimeState(runtime)
        }
      } catch (error) {
        operationIsLatest = isCurrentPluginRefreshSequence(refreshSequence)
        if (this.isCurrentPluginRuntime(runtime) && operationIsLatest) {
          this.resetPluginRuntimeState()
          this.showErrorMessage(`插件重载失败：${formatError(error)}`)
        }
      } finally {
        if (operationIsLatest) {
          this.pluginsLoading = false
        }
      }
    },

    async openPluginFile(relativePath: string, line?: number) {
      if (!this.workspace) return
      const path = joinWorkspacePath(this.workspace.rootPath, relativePath).replace(/\\/g, '/')
      await this.openFile(path)
      if (line) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('superhigh:reveal-editor-position', {
          detail: { path, lineNumber: line, column: 1 },
        })), 100)
      }
    },

    registerWorkspacePath(rootPath: string) {
      const existing = new Set(this.openWorkspacePaths.map((path) => workspaceKey(path)))
      if (existing.has(workspaceKey(rootPath))) return
      this.openWorkspacePaths = [...this.openWorkspacePaths, rootPath]
      void this.syncWorkspaceWatchTargets()
    },

    registerDocsTab(rootPath: string) {
      const existing = new Set(this.docsTabOpenPaths.map((path) => workspaceKey(path)))
      if (existing.has(workspaceKey(rootPath))) return
      this.docsTabOpenPaths = [...this.docsTabOpenPaths, rootPath]
    },

    async activateProjectWorkspace(rootPath: string) {
      const switched = await this.switchWorkspace(rootPath)
      if (switched) {
        this.activeWorkspaceSurface = 'project'
        this.settingsOpen = false
      }
      return switched
    },

    async activateDocsWorkspaceTab(rootPath: string) {
      const switched = await this.switchWorkspace(rootPath)
      if (!switched) return false
      this.registerDocsTab(rootPath)
      this.settingsOpen = false
      void this.ensureVitePressDocs(rootPath)
      return true
    },

    closeExitedManagedTerminalSessions(replacement: TerminalSession) {
      if (!isProjectManagedTerminalSessionKind(replacement.providerKind)) return
      const obsolete = this.terminalSessions.filter((session) => (
        session.id !== replacement.id
        && session.providerKind === replacement.providerKind
        && workspaceKey(session.cwd) === workspaceKey(replacement.cwd)
        && session.title === replacement.title
        && (session.restoredFromDisk || this.terminalExitCodes[session.id] != null)
      ))
      for (const session of obsolete) void this.closeTerminalSession(session.id)
    },

    stashActiveWorkspaceState() {
      if (!this.workspace) return
      this.workspaceSnapshots[workspaceKey(this.workspace.rootPath)] = {
        workspace: { ...this.workspace },
        directoryCache: this.directoryCache,
        expandedPaths: this.expandedPaths,
        loadingDirectories: [],
        tabs: this.tabs,
        activeTabId: this.activeTabId,
        searchQuery: this.searchQuery,
        searchResults: this.searchResults,
        searchOpen: this.searchOpen,
        searchLoading: this.searchLoading,
        terminalSessions: this.terminalSessions,
        activeTerminalSessionId: this.activeTerminalSessionId,
        activeCliSessionId: this.activeCliSessionId,
        activeLocalTerminalSessionId: this.activeLocalTerminalSessionId,
        terminalDrafts: this.terminalDrafts,
        terminalConversation: this.terminalConversation,
        terminalConversationReplyPending: this.terminalConversationReplyPending,
        terminalExitCodes: this.terminalExitCodes,
        activeWorkspaceSurface: this.activeWorkspaceSurface,
        projectEditorEntryPath: this.projectEditorEntryPath,
      }
    },

    resetWorkspaceScopedState(rootPath: string) {
      this.$patch({
        directoryCache: {},
        expandedPaths: [rootPath],
        loadingDirectories: [],
        pendingDirectoryRefreshes: {},
        explorerFocusedPath: null,
        tabs: [],
        activeTabId: null,
        projectEditorEntryPath: null,
        codePreviewProjectEditorOpen: false,
        searchResults: null,
        searchQuery: '',
        searchOpen: false,
        searchLoading: false,
        terminalSessions: [],
        activeTerminalSessionId: null,
        activeCliSessionId: null,
        activeLocalTerminalSessionId: null,
        terminalDrafts: {},
        terminalConversation: {},
        terminalConversationReplyPending: {},
        terminalExitCodes: {},
        activeWorkspaceSurface: 'project',
      })
    },

    restoreWorkspaceScopedState(workspace: Workspace) {
      this.codePreviewScopePath = null
      const snapshot = this.workspaceSnapshots[workspaceKey(workspace.rootPath)]
      if (!snapshot) {
        this.workspace = workspace
        this.resetWorkspaceScopedState(workspace.rootPath)
        return
      }

      let activeWorkspaceSurface = snapshot.activeWorkspaceSurface ?? 'project'
      if (
        activeWorkspaceSurface === 'docs' &&
        !this.docsTabOpenPaths.some((path) => workspaceKey(path) === workspaceKey(workspace.rootPath))
      ) {
        activeWorkspaceSurface = 'project'
      }

      let activeTerminalSessionId = snapshot.activeTerminalSessionId
      let activeCliSessionId = snapshot.activeCliSessionId
      let activeLocalTerminalSessionId = snapshot.activeLocalTerminalSessionId
      const terminalSessions = snapshot.terminalSessions
      const liveTerminalSessions = terminalSessions.filter(terminalSessionIsLive)
      const cliTerminalSessions = terminalSessions.filter((s) => !isLocalTerminalSessionKind(s.providerKind))

      if (activeTerminalSessionId && !liveTerminalSessions.some((s) => s.id === activeTerminalSessionId)) {
        activeTerminalSessionId = liveTerminalSessions[0]?.id ?? null
      }
      if (activeCliSessionId && !cliTerminalSessions.some((s) => s.id === activeCliSessionId)) {
        activeCliSessionId = cliTerminalSessions[0]?.id ?? null
      }
      if (activeLocalTerminalSessionId && !liveTerminalSessions.some((s) => s.id === activeLocalTerminalSessionId)) {
        activeLocalTerminalSessionId = liveTerminalSessions.filter((s) => isLocalTerminalSessionKind(s.providerKind))[0]?.id ?? null
      }
      this.$patch({
        workspace,
        directoryCache: snapshot.directoryCache,
        expandedPaths: snapshot.expandedPaths,
        loadingDirectories: [],
        pendingDirectoryRefreshes: {},
        explorerFocusedPath: null,
        tabs: snapshot.tabs,
        activeTabId: snapshot.activeTabId,
        searchQuery: snapshot.searchQuery,
        searchResults: snapshot.searchResults,
        searchOpen: snapshot.searchOpen,
        searchLoading: false,
        terminalSessions,
        activeTerminalSessionId,
        activeCliSessionId,
        activeLocalTerminalSessionId,
        terminalDrafts: snapshot.terminalDrafts ?? {},
        terminalConversation: snapshot.terminalConversation ?? {},
        terminalConversationReplyPending: snapshot.terminalConversationReplyPending ?? {},
        terminalExitCodes: snapshot.terminalExitCodes ?? {},
        activeWorkspaceSurface,
        projectEditorEntryPath: snapshot.projectEditorEntryPath ?? null,
        codePreviewProjectEditorOpen: false,
      })
    },

    async switchWorkspace(rootPath: string) {
      const normalizedKey = workspaceKey(rootPath)
      if (this.workspace && workspaceKey(this.workspace.rootPath) === normalizedKey) {
        this.settingsOpen = false
        if (!this.docsWorkspaces[normalizedKey]) this.runBackgroundTask('文档检测', () => this.detectVitePressDocs(rootPath).then(() => undefined))
        return true
      }

      const snapshot = this.workspaceSnapshots[normalizedKey]
      if (!snapshot) {
        return this.openProject(rootPath)
      }

      const switchToken = ++workspaceSwitchToken
      this.stashActiveWorkspaceState()
      this.restoreWorkspaceScopedState({ ...snapshot.workspace })
      this.registerWorkspacePath(rootPath)
      if (switchToken !== workspaceSwitchToken) return true
      const cachedDirectoryKeys = new Set(Object.keys(this.directoryCache).map(workspaceKey))
      const directoriesToLoad = Array.from(new Set([rootPath, ...this.expandedPaths]))
        .map(normalizeFilePath)
        .filter((path) => isSameOrChildPath(path, rootPath) && !cachedDirectoryKeys.has(workspaceKey(path)))
      await Promise.all(directoriesToLoad.map((path) => this.loadDirectory(path).catch(() => undefined)))
      if (switchToken !== workspaceSwitchToken) return true
      void this.refreshStaleWorkspaceAfterActivation(normalizedKey, switchToken)
      void this.syncWorkspaceWatchTargets()
      this.refreshWorkspaceMetadataInBackground(rootPath)
      void this.refreshProjectStartupConfig()
      void this.refreshProjectTerminalActions()
      this.settingsOpen = false
      void this.refreshPlugins()
      return true
    },

    async closeWorkspaceTab(rootPath: string, choice: 'save' | 'discard' | null = null) {
      const key = workspaceKey(rootPath)
      const nextPaths = this.openWorkspacePaths.filter((path) => workspaceKey(path) !== key)
      if (nextPaths.length === this.openWorkspacePaths.length) return
      const wasActive = this.workspace ? workspaceKey(this.workspace.rootPath) === key : false
      const closingTabs = wasActive ? this.tabs : this.workspaceSnapshots[key]?.tabs ?? []
      if (hasDirtyTextTabs(closingTabs)) {
        if (choice === null) {
          this.pendingWorkspaceCloseRootPath = rootPath
          return
        }
        if (choice === 'save') {
          for (const tab of closingTabs) {
            if (tab.contentType === 'text' && tab.isDirty) {
              try {
                await backend.writeFile(tab.path, tab.content)
                tab.isDirty = false
              } catch (error) {
                this.showErrorMessage(`保存失败：${tab.path}\n${formatError(error)}`)
                return
              }
            }
          }
        } else {
          for (const tab of closingTabs) {
            if (tab.contentType === 'text') tab.isDirty = false
          }
        }
      }
      const closingWorkspaceId = wasActive
        ? this.workspace?.id ?? null
        : this.workspaceSnapshots[key]?.workspace.id ?? null
      this.openWorkspacePaths = nextPaths
      void this.syncWorkspaceWatchTargets()
      this.docsTabOpenPaths = this.docsTabOpenPaths.filter((path) => workspaceKey(path) !== key)
      if (this.workspaceFileRefreshTimers[key]) {
        window.clearTimeout(this.workspaceFileRefreshTimers[key])
        delete this.workspaceFileRefreshTimers[key]
      }
      delete this.pendingWorkspaceFileChanges[key]
      void this.stopVitePressDocs(rootPath)
      if (closingWorkspaceId) void this.closeTerminalSessionsForWorkspace(closingWorkspaceId)
      delete this.workspaceSnapshots[key]

      if (!wasActive) return
      const fallbackPath = nextPaths[nextPaths.length - 1] ?? null
      if (!fallbackPath) {
        this.resetPluginRuntimeState()
        this.workspace = null
        this.directoryCache = {}
        this.expandedPaths = []
        this.loadingDirectories = []
        this.pendingDirectoryRefreshes = {}
        this.tabs = []
        this.activeTabId = null
        this.searchResults = null
        this.searchQuery = ''
        this.searchOpen = false
        this.searchLoading = false
        this.terminalSessions = []
        this.activeTerminalSessionId = null
        this.activeCliSessionId = null
        this.activeLocalTerminalSessionId = null
        this.activeWorkspaceSurface = 'project'
        this.settingsOpen = false
        this.memoWindowOpen = false
        void this.syncWorkspaceWatchTargets()
        return
      }

      this.workspace = null
      await this.switchWorkspace(fallbackPath)
    },

    async closeDocsWorkspaceTab(rootPath: string) {
      const key = workspaceKey(rootPath)
      this.docsTabOpenPaths = this.docsTabOpenPaths.filter((path) => workspaceKey(path) !== key)
      await this.stopVitePressDocs(rootPath)
      if (this.workspace && workspaceKey(this.workspace.rootPath) === key && this.activeWorkspaceSurface === 'docs') {
        this.activeWorkspaceSurface = 'project'
      }
    },

    async initialize() {
      if (this.initialized) return
      applyTheme(DEFAULT_THEME_ID)
      if (!isTauri()) {
        this.initialized = true
        return
      }
      try {
        const startupTarget = await backend.takeStartupOpenTarget()
        if (startupTarget?.filePath && isMediaFile(startupTarget.filePath)) {
          this.startupMediaPath = normalizePath(startupTarget.filePath)
          try {
            await withTimeout(this.loadSettings(), 5000, '设置加载')
          } catch (error) {
            this.showErrorMessage(`主题设置加载失败：${formatError(error)}`)
          }
          return
        }
        this.bindBackendEvents()
        const results = await Promise.allSettled([
          withTimeout(this.refreshRecentProjects(), 5000, '最近项目加载'),
          withTimeout(this.loadSettings(), 5000, '设置加载'),
        ])
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed) {
          this.showErrorMessage(`启动初始化部分失败：${formatError(failed.reason)}`)
        }
        if (startupTarget) {
          const opened = await this.openProject(startupTarget.workspacePath, { silent: true })
          if (opened && startupTarget.filePath) {
            await this.openFile(startupTarget.filePath)
            if (isOfficeDocument(startupTarget.filePath)) {
              this.activeWorkspaceSurface = 'project'
              this.settings.activePreviewMode = 'code'
              this.settings.multiTerminalMode = false
              this.settings.dialogueMapMode = false
            }
          }
          if (!opened) await this.restoreLastWorkspace()
        } else {
          await this.restoreLastWorkspace()
        }
        this.refreshStartupMetadataInBackground()
        void this.refreshCliHistory()
      } catch (error) {
        this.showErrorMessage(`启动初始化失败：${formatError(error)}`)
      } finally {
        this.initialized = true
      }
    },

    currentTerminalStateSource(): TerminalStateSource {
      return {
        terminalSessions: this.terminalSessions,
        activeTerminalSessionId: this.activeTerminalSessionId,
        activeCliSessionId: this.activeCliSessionId,
        activeLocalTerminalSessionId: this.activeLocalTerminalSessionId,
        terminalDrafts: this.terminalDrafts,
        terminalConversation: this.terminalConversation,
        terminalConversationReplyPending: this.terminalConversationReplyPending,
        terminalExitCodes: this.terminalExitCodes,
      }
    },

    snapshotTerminalStateSource(snapshot: WorkspaceScopedState): TerminalStateSource {
      return {
        terminalSessions: snapshot.terminalSessions ?? [],
        activeTerminalSessionId: snapshot.activeTerminalSessionId ?? null,
        activeCliSessionId: snapshot.activeCliSessionId ?? null,
        activeLocalTerminalSessionId: snapshot.activeLocalTerminalSessionId ?? null,
        terminalDrafts: snapshot.terminalDrafts ?? {},
        terminalConversation: snapshot.terminalConversation ?? {},
        terminalConversationReplyPending: snapshot.terminalConversationReplyPending ?? {},
        terminalExitCodes: snapshot.terminalExitCodes ?? {},
      }
    },

    terminalStateSourceForRoot(rootPath?: string): TerminalStateSource | null {
      const targetRootPath = rootPath ?? this.workspace?.rootPath
      if (!targetRootPath) return null
      const key = workspaceKey(targetRootPath)
      if (this.workspace && workspaceKey(this.workspace.rootPath) === key) {
        return this.currentTerminalStateSource()
      }
      const snapshot = this.workspaceSnapshots[key]
      return snapshot ? this.snapshotTerminalStateSource(snapshot) : null
    },

    ensureSnapshotTerminalStateSource(snapshot: WorkspaceScopedState): TerminalStateSource {
      snapshot.terminalDrafts ??= {}
      snapshot.terminalConversation ??= {}
      snapshot.terminalConversationReplyPending ??= {}
      snapshot.terminalExitCodes ??= {}
      return this.snapshotTerminalStateSource(snapshot)
    },

    terminalStateTargetForSession(sessionId: string): { rootPath: string; state: TerminalStateSource; current: boolean } | null {
      if (this.workspace && this.terminalSessions.some((session) => session.id === sessionId)) {
        return { rootPath: this.workspace.rootPath, state: this.currentTerminalStateSource(), current: true }
      }
      for (const snapshot of Object.values(this.workspaceSnapshots)) {
        if (!snapshot.terminalSessions.some((session) => session.id === sessionId)) continue
        return {
          rootPath: snapshot.workspace.rootPath,
          state: this.ensureSnapshotTerminalStateSource(snapshot),
          current: false,
        }
      }
      return null
    },

    buildPersistedTerminalState(rootPath?: string, source?: TerminalStateSource): PersistedTerminalState {
      return buildPersistedTerminalStateFromSource(source ?? this.terminalStateSourceForRoot(rootPath) ?? emptyTerminalStateSource())
    },

    async persistTerminalState(rootPath?: string, source?: TerminalStateSource) {
      const targetRootPath = rootPath ?? this.workspace?.rootPath
      if (!isTauri() || !targetRootPath) return
      const state = this.buildPersistedTerminalState(targetRootPath, source)
      try {
        await backend.createDirectory(terminalStateDirectory(targetRootPath))
      } catch {
        // Directory may already exist.
      }
      await backend.writeFile(terminalStateFilePath(targetRootPath), `${JSON.stringify(state, null, 2)}\n`)
    },

    schedulePersistTerminalState(rootPath?: string) {
      const targetRootPath = rootPath ?? this.workspace?.rootPath
      if (!isTauri() || !targetRootPath) return
      const key = workspaceKey(targetRootPath)
      const existing = terminalStatePersistTimers.get(key)
      if (existing) window.clearTimeout(existing)
      terminalStatePersistTimers.set(key, window.setTimeout(() => {
        terminalStatePersistTimers.delete(key)
        void this.persistTerminalState(targetRootPath).catch((error) => {
          this.showErrorMessage(`终端对话保存失败：${formatError(error)}`)
        })
      }, TERMINAL_STATE_PERSIST_DELAY_MS))
    },

    async loadPersistedTerminalState(rootPath: string) {
      if (!isTauri()) return
      let liveSessionIds = new Set<string>()
      try {
        liveSessionIds = new Set(await backend.listLiveTerminalSessionIds())
      } catch {
        // If the backend cannot confirm a session, restore it as ended history.
      }
      let parsed: Partial<PersistedTerminalState>
      try {
        parsed = JSON.parse(await backend.readFile(terminalStateFilePath(rootPath)))
      } catch {
        return
      }
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.terminalSessions)) return
      const existingIds = new Set(this.terminalSessions.map((session) => session.id))
      const restoredSessions = parsed.terminalSessions
        .filter((session): session is TerminalSession => (
          !!session &&
          typeof session.id === 'string' &&
          typeof session.title === 'string' &&
          typeof session.providerKind === 'string' &&
          typeof session.cwd === 'string' &&
          !existingIds.has(session.id)
        ))
        .map((session) => {
          if (!liveSessionIds.has(session.id) && isProjectManagedTerminalSessionKind(session.providerKind)) return null
          if (!liveSessionIds.has(session.id)) return { ...session, restoredFromDisk: true }
          const { restoredFromDisk: _restoredFromDisk, ...liveSession } = session
          return liveSession
        })
        .filter((session): session is TerminalSession => !!session)
      if (!restoredSessions.length && !parsed.terminalConversation) return

      const restoredIds = new Set(restoredSessions.map((session) => session.id))
      this.terminalSessions = [...this.terminalSessions, ...restoredSessions]
      this.terminalConversation = {
        ...normalizeTerminalConversation(parsed.terminalConversation ?? {}),
        ...this.terminalConversation,
      }
      this.terminalDrafts = {
        ...(parsed.terminalDrafts ?? {}),
        ...this.terminalDrafts,
      }
      this.terminalExitCodes = {
        ...(parsed.terminalExitCodes ?? {}),
        ...this.terminalExitCodes,
      }
      for (const sessionId of restoredIds) {
        this.terminalExitCodes[sessionId] = liveSessionIds.has(sessionId) ? null : 0
      }
      const restoredCliSessions = restoredSessions.filter((session) => !isLocalTerminalSessionKind(session.providerKind))
      const restoredLiveSessions = restoredSessions.filter((session) => liveSessionIds.has(session.id))
      const restoredLocalSessions = restoredLiveSessions.filter((session) => isLocalTerminalSessionKind(session.providerKind))
      if (!this.activeTerminalSessionId) {
        const persistedId = parsed.activeTerminalSessionId
        this.activeTerminalSessionId = restoredLiveSessions.some((session) => session.id === persistedId)
          ? persistedId ?? null
          : restoredLiveSessions[0]?.id ?? null
      }
      if (!this.activeCliSessionId) {
        const persistedId = parsed.activeCliSessionId
        this.activeCliSessionId = restoredCliSessions.some((session) => session.id === persistedId)
          ? persistedId ?? null
          : restoredCliSessions[0]?.id ?? null
      }
      if (!this.activeLocalTerminalSessionId) {
        const persistedId = parsed.activeLocalTerminalSessionId
        this.activeLocalTerminalSessionId = restoredLocalSessions.some((session) => session.id === persistedId)
          ? persistedId ?? null
          : restoredLocalSessions[0]?.id ?? null
      }
      this.syncProjectServiceRunFromLiveSessions(rootPath)
    },

    bindBackendEvents() {
      if (this.listenersBound || !isTauri()) return
      this.listenersBound = true
      backendEventListenersDisposed = false
      void onTerminalExit(({ sessionId, exitCode }) => {
        this.finishTerminalOutputForExit(sessionId, exitCode)
      }).then((unlisten) => {
        if (backendEventListenersDisposed) unlisten()
        else backendEventUnlisteners.push(unlisten)
      }).catch((error) => {
        this.listenersBound = false
        this.showErrorMessage(`终端退出监听失败：${formatError(error)}`)
      })
      void onTerminalOutput((event) => {
        this.queueTerminalOutput(event.sessionId, event.chunk)
      }).then((unlisten) => {
        if (backendEventListenersDisposed) unlisten()
        else backendEventUnlisteners.push(unlisten)
      }).catch((error) => {
        this.listenersBound = false
        this.showErrorMessage(`终端输出监听失败：${formatError(error)}`)
      })
      void onWorkspaceFilesChanged((event) => {
        this.scheduleWorkspaceFilesChangedRefresh(event)
      }).then((unlisten) => {
        if (backendEventListenersDisposed) unlisten()
        else backendEventUnlisteners.push(unlisten)
      }).catch((error) => {
        this.listenersBound = false
        this.showErrorMessage(`工作区文件监听失败：${formatError(error)}`)
      })
      void onProjectServiceStatus((event) => {
        this.applyProjectServiceStatus(event)
      }).then((unlisten) => {
        if (backendEventListenersDisposed) unlisten()
        else backendEventUnlisteners.push(unlisten)
      }).catch((error) => {
        this.listenersBound = false
        this.showErrorMessage(`服务链状态监听失败：${formatError(error)}`)
      })
    },

    unbindBackendEvents() {
      backendEventListenersDisposed = true
      for (const unlisten of backendEventUnlisteners) unlisten()
      backendEventUnlisteners = []
      this.listenersBound = false
    },

    workspaceWatchTargetFor(rootPath: string, expandedPaths: string[], tabs: EditorTab[]): WorkspaceWatchTarget | null {
      const normalizedRootPath = normalizeFilePath(rootPath)
      if (!normalizedRootPath) return null
      const rootPathKey = workspaceKey(normalizedRootPath)
      const directories = new Set<string>([normalizedRootPath])
      for (const path of expandedPaths) {
        const normalized = normalizeFilePath(path)
        if (isSameOrChildPath(normalized, normalizedRootPath)) directories.add(normalized)
      }
      for (const tab of tabs) {
        if (isSameOrChildPath(tab.path, normalizedRootPath)) directories.add(parentDirectoryOf(tab.path))
      }
      directories.add(`${normalizedRootPath}/docs/plan`)
      directories.add(`${normalizedRootPath}/.superhigh`)
      return {
        rootPath: normalizedRootPath,
        directories: Array.from(directories),
      }
    },

    workspaceWatchTargets(): WorkspaceWatchTarget[] {
      const paths = this.openWorkspacePaths.length
        ? this.openWorkspacePaths
        : this.workspace?.rootPath ? [this.workspace.rootPath] : []
      const targets: WorkspaceWatchTarget[] = []
      const seen = new Set<string>()
      for (const root of paths) {
        const key = workspaceKey(root)
        if (seen.has(key)) continue
        seen.add(key)
        const isCurrent = this.workspace ? workspaceKey(this.workspace.rootPath) === key : false
        const snapshot = this.workspaceSnapshots[key]
        const target = this.workspaceWatchTargetFor(
          root,
          isCurrent ? this.expandedPaths : snapshot?.expandedPaths ?? [root],
          isCurrent ? this.tabs : snapshot?.tabs ?? [],
        )
        if (target) targets.push(target)
      }
      return targets
    },

    async syncWorkspaceWatchTargets() {
      if (!isTauri()) return
      const targets = this.workspaceWatchTargets()
      const targetsKey = stableWorkspaceWatchTargetsKey(targets)
      if (targetsKey === lastWorkspaceWatchTargetsKey) return
      if (workspaceWatchSyncTimer) window.clearTimeout(workspaceWatchSyncTimer)
      workspaceWatchSyncTimer = window.setTimeout(() => {
        workspaceWatchSyncTimer = null
        void this.syncWorkspaceWatchTargetsNow()
      }, WORKSPACE_WATCH_SYNC_DELAY_MS)
    },

    async syncWorkspaceWatchTargetsNow() {
      if (!isTauri()) return
      if (workspaceWatchSyncTimer) {
        window.clearTimeout(workspaceWatchSyncTimer)
        workspaceWatchSyncTimer = null
      }
      try {
        const targets = this.workspaceWatchTargets()
        const targetsKey = stableWorkspaceWatchTargetsKey(targets)
        if (targetsKey === lastWorkspaceWatchTargetsKey) return
        const task = workspaceWatchSyncQueue
          .catch(() => undefined)
          .then(async () => {
            const nextTargets = this.workspaceWatchTargets()
            const nextKey = stableWorkspaceWatchTargetsKey(nextTargets)
            if (nextKey === lastWorkspaceWatchTargetsKey) return
            await backend.syncWorkspaceWatchTargets(nextTargets)
            lastWorkspaceWatchTargetsKey = nextKey
          })
        workspaceWatchSyncQueue = task
        await task
      } catch (error) {
        this.showErrorMessage(`工作区文件监听同步失败：${formatError(error)}`)
      }
    },

    runBackgroundTask(label: string, task: () => Promise<void>) {
      void task().catch((error) => {
        this.showErrorMessage(`${label}失败：${formatError(error)}`)
      })
    },

    refreshStartupMetadataInBackground() {
      this.runBackgroundTask('CLI 检测', () => this.refreshCliEnvironments())
      if (this.workspace?.rootPath) {
        const rootPath = this.workspace.rootPath
        this.runBackgroundTask('项目指令文件刷新', () => this.refreshProjectInstructionFiles(rootPath))
        this.runBackgroundTask('文档检测', () => this.detectVitePressDocs(rootPath).then(() => undefined))
      }
    },

    refreshWorkspaceMetadataInBackground(rootPath: string) {
      if (this.metadataRefreshTimer) {
        window.clearTimeout(this.metadataRefreshTimer)
        this.metadataRefreshTimer = null
      }
      this.metadataRefreshTimer = window.setTimeout(() => {
        this.metadataRefreshTimer = null
        this.runBackgroundTask('最近项目刷新', () => this.refreshRecentProjects())
        this.runBackgroundTask('项目指令文件刷新', () => this.refreshProjectInstructionFiles(rootPath))
        this.runBackgroundTask('项目启动配置刷新', () => this.refreshProjectStartupConfig())
        this.runBackgroundTask('本地终端动作刷新', () => this.refreshProjectTerminalActions())
        this.runBackgroundTask('文档检测', () => this.detectVitePressDocs(rootPath).then(() => undefined))
      }, 1000)
    },

    scheduleWorkspaceFilesChangedRefresh(event: WorkspaceFilesChangedEvent) {
      const rootPath = normalizeFilePath(event.rootPath)
      const key = workspaceKey(rootPath)
      if (!this.openWorkspacePaths.some((path) => workspaceKey(path) === key)) return

      const normalizedEvent: WorkspaceFilesChangedEvent = {
        ...event,
        rootPath,
        changedPaths: normalizedUniquePaths(event.changedPaths ?? []),
        affectedDirectories: normalizedUniquePaths(event.affectedDirectories ?? []),
      }
      this.pendingWorkspaceFileChanges[key] = [
        ...(this.pendingWorkspaceFileChanges[key] ?? []),
        normalizedEvent,
      ]

      if (this.workspaceFileRefreshTimers[key]) return
      this.workspaceFileRefreshTimers[key] = window.setTimeout(() => {
        delete this.workspaceFileRefreshTimers[key]
        const pending = this.pendingWorkspaceFileChanges[key] ?? []
        delete this.pendingWorkspaceFileChanges[key]
        void this.applyWorkspaceFilesChangedEvents(key, pending)
      }, WORKSPACE_FILE_REFRESH_DELAY_MS)
    },

    async applyWorkspaceFilesChangedEvents(key: string, events: WorkspaceFilesChangedEvent[]) {
      if (!events.length) return
      const allChangedPaths = normalizedUniquePathKeys(events.flatMap((event) => event.changedPaths))
      const currentKey = this.workspace?.rootPath ? workspaceKey(this.workspace.rootPath) : ''
      if (currentKey === key && this.workspace) {
        const rootPath = this.workspace.rootPath
        const dirs = directoriesToRefreshForWorkspaceChanges(
          events,
          this.directoryCache,
          this.expandedPaths,
          rootPath,
          true,
        )
        pruneDirectoryCacheForChangedPaths(
          this.directoryCache,
          events.flatMap((event) => event.changedPaths),
          dirs,
        )
        await Promise.all(dirs.map((path) => this.loadDirectory(path, true).catch(() => undefined)))
        // Guard: workspace may have switched during await
        if (workspaceKey(this.workspace?.rootPath ?? '') !== key) return
        void this.reloadOpenTabsForChangedPaths(this.tabs, allChangedPaths)
        return
      }

      const snapshot = this.workspaceSnapshots[key]
      if (!snapshot) return
      pruneDirectoryCacheForChangedPaths(
        snapshot.directoryCache,
        events.flatMap((event) => event.changedPaths),
      )
      void this.reloadOpenTabsForChangedPaths(snapshot.tabs, allChangedPaths)
    },

    async refreshStaleWorkspaceAfterActivation(key: string, switchToken: number) {
      const pending = this.pendingWorkspaceFileChanges[key] ?? []
      delete this.pendingWorkspaceFileChanges[key]
      if (this.workspaceFileRefreshTimers[key]) {
        window.clearTimeout(this.workspaceFileRefreshTimers[key])
        delete this.workspaceFileRefreshTimers[key]
      }
      if (pending.length && switchToken === workspaceSwitchToken) {
        await this.applyWorkspaceFilesChangedEvents(key, pending)
      }
      if (switchToken !== workspaceSwitchToken || !this.workspace) return
    },

    async reloadOpenTabsForChangedPaths(tabs: EditorTab[], changedPaths: Set<string>) {
      if (!changedPaths.size) return
      for (const tab of tabs) {
        const tabPathKey = workspaceKey(tab.path)
        if (!changedPaths.has(tabPathKey)) continue

        if (tab.isDirty && tab.contentType === 'text') {
          try {
            const diskContent = await backend.readFile(tab.path)
            if (tab.lastKnownDiskContent === undefined || diskContent !== tab.lastKnownDiskContent) {
              this.fileConflictPaths[tabPathKey] = true
            } else {
              delete this.fileConflictPaths[tabPathKey]
            }
          } catch {
            this.fileConflictPaths[tabPathKey] = true
          }
          continue
        }

        try {
          const result = await readEditorFile(tab.path)
          Object.assign(tab, result)
          const content = result.content
          if (tab.contentType === 'text') tab.lastKnownDiskContent = content
          delete this.fileConflictPaths[tabPathKey]
        } catch (error) {
          if (tab.contentType === 'text') {
            this.fileConflictPaths[tabPathKey] = true
          } else {
            tab.contentType = 'unsupported'
            tab.content = formatError(error)
          }
        }
      }
    },

    async refreshRecentProjects() {
      this.recentProjects = await backend.listRecentProjects()
    },

    async removeRecentProject(path: string) {
      await backend.removeRecentProject(path)
      if (workspaceKey(this.workspace?.rootPath ?? '') !== workspaceKey(path)) {
      }
      delete this.settings.projectNicknames[path]
      this.settings.hiddenProjectPaths = this.settings.hiddenProjectPaths.filter((root) => workspaceKey(root) !== workspaceKey(path))
      await Promise.all([this.saveSettings(), this.refreshRecentProjects()])
      this.showActivityMessage('已从历史工作区移除')
    },

    applyCliHistorySnapshot(snapshot: { messages?: CliConversationMessage[]; paths?: CliHistoryPathCandidate[] }) {
      this.cliHistoryMessages = (snapshot.messages ?? []).filter((message) => (
        message.role === 'user' && !!message.content?.trim()
      ))
      this.cliHistoryPaths = snapshot.paths ?? []
    },

    async refreshNativeCliConversations() {
      const rootPath = this.workspace?.rootPath
      if (!rootPath || !isTauri()) {
        this.nativeCliConversations = []
        this.nativeCliConversationsRootPath = ''
        this.nativeCliConversationsLoading = false
        return []
      }
      const rootKey = workspaceKey(rootPath)
      this.nativeCliConversationsLoading = true
      try {
        const conversations = await backend.listWorkspaceCliConversations(rootPath)
        if (workspaceKey(this.workspace?.rootPath ?? '') !== rootKey) return []
        this.nativeCliConversations = conversations
        this.nativeCliConversationsRootPath = rootPath
        return conversations
      } catch (error) {
        if (workspaceKey(this.workspace?.rootPath ?? '') === rootKey) {
          this.nativeCliConversations = []
          this.nativeCliConversationsRootPath = rootPath
          this.showErrorMessage(`读取本机 CLI 对话失败：${formatError(error)}`)
        }
        return []
      } finally {
        if (workspaceKey(this.workspace?.rootPath ?? '') === rootKey) {
          this.nativeCliConversationsLoading = false
        }
      }
    },

    async readNativeCliConversation(conversation: CliNativeConversationSummary): Promise<CliNativeConversationDetail | null> {
      const rootPath = this.workspace?.rootPath
      if (!rootPath || !isTauri()) return null
      try {
        return await backend.readWorkspaceCliConversation(rootPath, conversation.sourcePath)
      } catch (error) {
        this.showErrorMessage(`读取对话内容失败：${formatError(error)}`)
        return null
      }
    },

    async resumeNativeCliConversation(conversation: CliNativeConversationSummary): Promise<TerminalSession | null> {
      const workspace = this.workspace
      const nativeSessionId = conversation.nativeSessionId?.trim()
      if (!workspace || !nativeSessionId || !conversation.resumeSupported) {
        this.showErrorMessage('这个历史对话没有可用的原生恢复标识。')
        return null
      }
      const existing = this.terminalSessions.find((session) => (
        session.nativeConversationId === conversation.id && terminalSessionIsLive(session)
      ))
      if (existing) {
        this.setActiveTerminalSession(existing.id)
        return existing
      }
      const workspaceId = workspace.id
      const rootPath = workspace.rootPath
      const rootKey = workspaceKey(rootPath)
      try {
        const session = await backend.resumeCliConversation(
          workspaceId,
          conversation.providerKind as TerminalProviderKind,
          rootPath,
          nativeSessionId,
        )
        if (this.workspace?.id !== workspaceId || workspaceKey(this.workspace?.rootPath ?? '') !== rootKey) {
          await backend.closeTerminal(session.id).catch(() => undefined)
          return null
        }
        session.name = conversation.title
        session.nativeConversationId = conversation.id
        this.terminalSessions.push(session)
        this.terminalDrafts[session.id] = ''
        this.terminalConversation[session.id] = []
        this.terminalConversationReplyPending[session.id] = false
        this.terminalExitCodes[session.id] = null
        this.setActiveTerminalSession(session.id)
        this.schedulePersistTerminalState()
        return session
      } catch (error) {
        this.showErrorMessage(`恢复 ${conversation.title} 失败：${formatError(error)}`)
        return null
      }
    },

    async refreshCliHistory() {
      if (!isTauri()) return
      try {
        this.applyCliHistorySnapshot(await backend.loadCliHistory())
      } catch (error) {
        this.showErrorMessage(`历史补全读取失败：${formatError(error)}`)
        return
      }
      void backend.refreshCliHistory().then((snapshot) => {
        this.applyCliHistorySnapshot(snapshot)
      }).catch((error) => {
        this.showErrorMessage(`历史补全索引失败：${formatError(error)}`)
      })
    },

    rememberCliHistoryMessage(message: CliConversationMessage, cwd?: string) {
      const content = message.content.trim()
      if (!content || message.role !== 'user') return
      const exists = this.cliHistoryMessages.some((item) => (
        item.content.trim() === content && item.timestamp === message.timestamp
      ))
      if (!exists) {
        this.cliHistoryMessages = [{ ...message, sessionId: 'cli-history' }, ...this.cliHistoryMessages].slice(0, 800)
      }
      if (isTauri()) {
        void backend.recordCliHistoryMessage({
          content,
          timestamp: message.timestamp,
          cwd: cwd ?? null,
          sessionId: message.sessionId,
        }).catch((error) => {
          this.showErrorMessage(`历史补全写入失败：${formatError(error)}`)
        })
      }
    },

    async loadSettings() {
      const next = await backend.getSettings()
      const loadedExplorerWidth = next.panelLayout?.explorerWidth
      this.settings = {
        ...defaultSettings(),
        ...next,
        mobileHost: {
          ...defaultSettings().mobileHost,
          ...next.mobileHost,
        },
        memoWindowFrame: normalizeMemoWindowFrame(next.memoWindowFrame),
        panelLayout: {
          ...defaultSettings().panelLayout,
          ...next.panelLayout,
        },
      }
      this.settings.disabledPluginIds = Array.isArray(this.settings.disabledPluginIds)
        ? this.settings.disabledPluginIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
        : []
      if (!['code', 'local_terminal'].includes(this.settings.activePreviewMode)) {
        this.settings.activePreviewMode = 'code'
      }
      if (typeof this.settings.multiTerminalMode !== 'boolean') {
        this.settings.multiTerminalMode = false
      }
      if (typeof this.settings.dialogueMapMode !== 'boolean') {
        this.settings.dialogueMapMode = false
      }
      this.settings.dialogueMapByWorkspace = normalizeDialogueMapStates(this.settings.dialogueMapByWorkspace)
      if (!['default', 'swapped'].includes(this.settings.projectLayoutMode)) {
        this.settings.projectLayoutMode = 'default'
      }
      if (this.settings.panelLayout.previewWidth < 340) {
        this.settings.panelLayout.previewWidth = 520
      }
      if (this.settings.panelLayout.conversationWidth < 420) {
        this.settings.panelLayout.conversationWidth = 520
      }
      if (this.settings.panelLayout.conversationWidth > 1040) {
        this.settings.panelLayout.conversationWidth = 1040
      }
      if (loadedExplorerWidth === LEGACY_DEFAULT_EXPLORER_WIDTH) {
        this.settings.panelLayout.explorerWidth = COMPACT_EXPLORER_WIDTH
      }
      if (this.settings.panelLayout.explorerWidth < 160) {
        this.settings.panelLayout.explorerWidth = COMPACT_EXPLORER_WIDTH
      }
      if (this.settings.panelLayout.explorerWidth > 520) {
        this.settings.panelLayout.explorerWidth = 520
      }
      if (!THEME_IDS.includes(this.settings.themeId)) {
        this.settings.themeId = DEFAULT_THEME_ID
      }
      applyTheme(this.settings.themeId)
    },

    async saveSettings() {
      this.settings = await backend.saveSettings(this.settings)
    },

    async addQuickPhrase(title: string, text: string) {
      const cleanText = text.trim()
      if (!cleanText) return
      const cleanTitle = title.trim() || cleanText.split(/\r?\n/)[0]?.slice(0, 24) || '快捷短语'
      const phrase: QuickPhrase = {
        id: crypto.randomUUID(),
        title: cleanTitle,
        text: cleanText,
        createdAt: new Date().toISOString(),
      }
      this.settings.quickPhrases = [phrase, ...(this.settings.quickPhrases ?? [])]
      await this.saveSettings()
    },

    async deleteQuickPhrase(id: string) {
      this.settings.quickPhrases = (this.settings.quickPhrases ?? []).filter((phrase) => phrase.id !== id)
      await this.saveSettings()
    },

    async setTheme(themeId: string) {
      if (!THEME_IDS.includes(themeId)) return
      this.settings.themeId = themeId
      applyTheme(themeId)
      await this.saveSettings()
    },

    async restoreLastWorkspace() {
      if (this.workspace || !this.recentProjects.length) return
      const candidates = this.visibleRecentProjects.length ? this.visibleRecentProjects : this.recentProjects
      for (const project of candidates) {
        const restored = await this.openProject(project.path, { silent: true })
        if (restored) {
          this.showActivityMessage(`已恢复工作区：${this.recentProjectTitle(project)}`)
          return
        }
      }
    },

    async openProject(path?: string, options: { silent?: boolean; keepSettingsOpen?: boolean } = {}): Promise<boolean> {
      this.showErrorMessage('')
      const switchToken = ++workspaceSwitchToken
      try {
        const nextWorkspace = await backend.openProject(path)
        if (switchToken !== workspaceSwitchToken) return true
        const sameWorkspace = this.workspace
          ? workspaceKey(this.workspace.rootPath) === workspaceKey(nextWorkspace.rootPath)
          : false

        if (!sameWorkspace) {
          await this.persistTerminalState().catch(() => undefined)
          this.stashActiveWorkspaceState()
          this.restoreWorkspaceScopedState(nextWorkspace)
        } else {
          this.workspace = nextWorkspace
        }

        const rootPath = nextWorkspace.rootPath
        await this.loadPersistedTerminalState(rootPath)
        this.registerWorkspacePath(rootPath)
        if (switchToken !== workspaceSwitchToken) return true
        this.activeWorkspaceSurface = 'project'
        this.refreshWorkspaceMetadataInBackground(rootPath)
        void this.refreshProjectStartupConfig()
        void this.refreshProjectTerminalActions()
        void this.loadDirectory(rootPath, !sameWorkspace && !this.directoryCache[rootPath]).catch(() => undefined)
        if (!options.keepSettingsOpen) this.settingsOpen = false
        void this.refreshPlugins()
        return true
      } catch (error) {
        if (!options.silent) this.showErrorMessage(String(error))
        return false
      }
    },

    async loadDirectory(path: string, force = false) {
      const normalizedPath = normalizeFilePath(path)
      if (!force && this.directoryCache[normalizedPath]) return

      const activeTask = directoryLoadTasks.get(normalizedPath)
      if (activeTask) {
        if (force) this.pendingDirectoryRefreshes[normalizedPath] = true
        await activeTask
        return
      }

      const task = (async () => {
        this.loadingDirectories = Array.from(new Set([...this.loadingDirectories, normalizedPath]))
        try {
          do {
            delete this.pendingDirectoryRefreshes[normalizedPath]
            try {
              this.showErrorMessage('')
              this.directoryCache[normalizedPath] = await backend.listDirectory(normalizedPath)
            } catch (error) {
              this.showErrorMessage(`无法读取目录：${normalizedPath}\n${formatError(error)}`)
              throw error
            }
          } while (this.pendingDirectoryRefreshes[normalizedPath])
        } finally {
          delete this.pendingDirectoryRefreshes[normalizedPath]
          this.loadingDirectories = this.loadingDirectories.filter((item) => item !== normalizedPath)
        }
      })()

      directoryLoadTasks.set(normalizedPath, task)
      try {
        await task
      } finally {
        if (directoryLoadTasks.get(normalizedPath) === task) {
          directoryLoadTasks.delete(normalizedPath)
        }
      }
    },

    async toggleDirectory(path: string) {
      if (this.expandedPaths.includes(path)) {
        this.expandedPaths = this.expandedPaths.filter((item) => item !== path)
        void this.syncWorkspaceWatchTargets()
        return
      }
      this.expandedPaths = [...this.expandedPaths, path]
      try {
        await this.loadDirectory(path)
        void this.syncWorkspaceWatchTargets()
      } catch {
        this.expandedPaths = this.expandedPaths.filter((item) => item !== path)
        void this.syncWorkspaceWatchTargets()
      }
    },

    async refreshExplorer(rootPath?: string) {
      const effectiveRootPath = normalizeFilePath(rootPath || this.workspace?.rootPath || '')
      if (!effectiveRootPath) return
      const paths = Array.from(new Set([
        effectiveRootPath,
        ...this.expandedPaths
          .map(normalizeFilePath)
          .filter((path) => isSameOrChildPath(path, effectiveRootPath)),
      ]))
      await Promise.all(paths.map((path) => this.loadDirectory(path, true).catch(() => undefined)))
    },

    collapseAllDirectories(rootPath?: string) {
      const effectiveRootPath = normalizeFilePath(rootPath || this.workspace?.rootPath || '')
      if (!effectiveRootPath) return
      const keptRoot = this.expandedPaths.find((path) => workspaceKey(path) === workspaceKey(effectiveRootPath))
      this.expandedPaths = keptRoot ? [keptRoot] : [effectiveRootPath]
      void this.syncWorkspaceWatchTargets()
    },

    async revealPathInExplorer(path: string) {
      const normalizedPath = normalizeFilePath(path)
      const rootPath = normalizeFilePath(this.workspace?.rootPath ?? '')
      if (!normalizedPath || !rootPath || !isSameOrChildPath(normalizedPath, rootPath)) return

      const parentPath = parentDirectoryOf(normalizedPath)
      const directories = directoryChainBetween(rootPath, parentPath)
      if (!directories.length) return

      for (const directory of directories) {
        if (!this.expandedPaths.some((item) => workspaceKey(item) === workspaceKey(directory))) {
          this.expandedPaths = [...this.expandedPaths, directory]
        }
        await this.loadDirectory(directory).catch(() => undefined)
      }

      this.explorerFocusedPath = normalizedPath
      this.explorerRevealRequestId += 1
      void this.syncWorkspaceWatchTargets()
    },

    async revealDirectoryInExplorer(path: string) {
      const normalizedPath = normalizeFilePath(path)
      const rootPath = normalizeFilePath(this.workspace?.rootPath ?? '')
      if (!normalizedPath || !rootPath || !isSameOrChildPath(normalizedPath, rootPath)) return

      const directories = directoryChainBetween(rootPath, normalizedPath)
      if (!directories.length) return

      for (const directory of directories) {
        if (!this.expandedPaths.some((item) => workspaceKey(item) === workspaceKey(directory))) {
          this.expandedPaths = [...this.expandedPaths, directory]
        }
        await this.loadDirectory(directory).catch(() => undefined)
      }

      this.explorerFocusedPath = normalizedPath
      this.explorerRevealRequestId += 1
      void this.syncWorkspaceWatchTargets()
    },

    async openBreadcrumbTarget(path: string) {
      const normalizedPath = normalizeFilePath(path)
      if (!normalizedPath) return

      this.setWorkspaceSurface('project')
      if (this.settings.activePreviewMode !== 'code') this.setPreviewMode('code')

      const existing = this.tabs.find((tab) => workspaceKey(tab.path) === workspaceKey(normalizedPath))
      if (existing) {
        await this.setActiveTab(existing.id)
        return
      }

      await this.revealDirectoryInExplorer(normalizedPath)
    },

    async openFile(path: string, options: OpenFileOptions = {}): Promise<boolean> {
      const normalizedPath = normalizeFilePath(path)
      const editorDirectory = this.workspace?.rootPath
        ? `${normalizeFilePath(this.workspace.rootPath).replace(/\/+$/, '').toLowerCase()}/.superhigh/editor/`
        : ''
      const isProjectEditorEntry = !!editorDirectory
        && normalizedPath.toLowerCase().startsWith(editorDirectory)
        && normalizedPath.toLowerCase().endsWith('.html')
      if (isProjectEditorEntry) {
        this.projectEditorEntryPath = normalizedPath
        this.codePreviewProjectEditorOpen = true
      } else if (!options.preserveCodePreviewScope) {
        this.codePreviewProjectEditorOpen = false
      }
      if (!options.preserveCodePreviewScope) this.codePreviewScopePath = null
      const existing = this.tabs.find((tab) => normalizeFilePath(tab.path) === normalizedPath)
      const revealInExplorer = options.revealInExplorer !== false
      // Preserve unsaved text when following another link to the same file.
      if (existing && existing.contentType !== 'unsupported' && !options.verifyExistingFile) {
        this.activeTabId = existing.id
        if (revealInExplorer) await this.revealPathInExplorer(normalizedPath)
        return true
      }
      let result: Pick<EditorTab, 'content' | 'contentType' | 'language'>
      let previewAvailable = true
      try {
        this.showErrorMessage('')
        result = await readEditorFile(normalizedPath)
      } catch (error) {
        // Existing files still get an actionable page when preview is unavailable.
        if (options.createUnsupportedTabOnError === false && !await backend.isFile(normalizedPath).catch(() => false)) {
          this.showErrorMessage(formatError(error))
          return false
        }
        previewAvailable = false
        result = { content: formatError(error), contentType: 'unsupported', language: 'plaintext' }
      }
      if (existing?.isDirty && existing.contentType === 'text') {
        if (!previewAvailable) {
          this.showErrorMessage(result.content)
          return false
        }
      } else if (existing) {
        Object.assign(existing, result)
        existing.lastKnownDiskContent = result.contentType === 'text' ? result.content : undefined
      }
      const tab: EditorTab = existing ?? {
        id: crypto.randomUUID(),
        path: normalizedPath,
        name: fileNameFromPath(normalizedPath),
        ...result,
        isDirty: false,
        ...(result.contentType === 'text' ? { lastKnownDiskContent: result.content } : {}),
      }
      if (!existing) this.tabs.push(tab)
      this.activeTabId = tab.id
      if (revealInExplorer) await this.revealPathInExplorer(normalizedPath)
      if (!options.skipWorkspaceWatchSync) void this.syncWorkspaceWatchTargets()
      return previewAvailable
    },

    updateActiveTabContent(content: string) {
      const tab = this.tabs.find((item) => item.id === this.activeTabId)
      if (!tab) return
      if (tab.contentType !== 'text') return
      tab.content = content
      tab.isDirty = true
      delete this.fileConflictPaths[workspaceKey(tab.path)]
      this.scheduleAutoSave()
    },

    scheduleAutoSave() {
      if (this.autoSaveTimer) {
        window.clearTimeout(this.autoSaveTimer)
        this.autoSaveTimer = null
      }
      if (this.settings.autoSave === 'off') return
      if (this.settings.autoSave === 'afterDelay') {
        this.autoSaveTimer = window.setTimeout(() => {
          this.autoSaveTimer = null
          void this.saveActiveTab()
        }, Math.max(200, this.settings.autoSaveDelay))
      }
    },

    triggerFocusAutoSave() {
      if (this.settings.autoSave !== 'onFocusChange') return
      void this.saveActiveTab()
    },

    cancelAutoSave() {
      if (this.autoSaveTimer) {
        window.clearTimeout(this.autoSaveTimer)
        this.autoSaveTimer = null
      }
    },

    async saveAllTabs(): Promise<boolean> {
      const dirtyTabs = this.tabs.filter((tab) => tab.contentType === 'text' && tab.isDirty)
      if (!dirtyTabs.length) return true

      let savedCount = 0
      for (const tab of dirtyTabs) {
        try {
          this.showErrorMessage('')
          await backend.writeFile(tab.path, tab.content)
          tab.isDirty = false
          tab.lastKnownDiskContent = tab.content
          delete this.fileConflictPaths[workspaceKey(tab.path)]
          savedCount += 1
          if (this.workspace && isSameOrChildPath(tab.path, this.workspace.rootPath)) {
            await this.loadDirectory(parentDirectoryOf(tab.path), true).catch(() => undefined)
          }
        } catch (error) {
          this.showErrorMessage(`保存失败：${tab.path}\n${formatError(error)}`)
          return false
        }
      }

      if (savedCount > 0) {
        this.showActivityMessage(`已保存 ${savedCount} 个文件`)
      }
      return true
    },

    async saveTabAs(id: string): Promise<boolean> {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab || tab.contentType !== 'text') return false
      // Use native file save dialog via backend
      try {
        const newPath = await backend.pickSaveFilePath(tab.path)
        if (!newPath) return false
        const previousPathKey = workspaceKey(tab.path)
        await backend.writeFile(newPath, tab.content)
        tab.path = normalizeFilePath(newPath)
        tab.name = fileNameFromPath(newPath)
        tab.language = inferLanguage(newPath)
        tab.isDirty = false
        tab.lastKnownDiskContent = tab.content
        delete this.fileConflictPaths[previousPathKey]
        delete this.fileConflictPaths[workspaceKey(tab.path)]
        await this.loadDirectory(parentDirectoryOf(tab.path), true)
        this.showActivityMessage(`已另存为：${tab.name}`)
        return true
      } catch (error) {
        this.showErrorMessage(`另存为失败：${formatError(error)}`)
        return false
      }
    },

    async setAutoSave(mode: AppSettings['autoSave']) {
      this.cancelAutoSave()
      this.settings.autoSave = mode
      await this.saveSettings()
    },

    async setAutoSaveDelay(ms: number) {
      this.settings.autoSaveDelay = Math.max(200, Math.min(60000, ms))
      await this.saveSettings()
    },

    async saveTab(id: string): Promise<boolean> {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab) return false
      if (tab.contentType !== 'text') return true
      try {
        this.showErrorMessage('')
        await backend.writeFile(tab.path, tab.content)
        tab.isDirty = false
        tab.lastKnownDiskContent = tab.content
        delete this.fileConflictPaths[workspaceKey(tab.path)]
        await this.loadDirectory(parentDirectoryOf(tab.path), true)
        this.showActivityMessage(`已保存：${fileNameFromPath(tab.path)}`)
        return true
      } catch (error) {
        this.showErrorMessage(`保存失败：${tab.path}\n${formatError(error)}`)
        return false
      }
    },

    async saveActiveTab(): Promise<boolean> {
      if (!this.activeTabId) return false
      return this.saveTab(this.activeTabId)
    },

    async reloadTabFromDisk(id: string): Promise<boolean> {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab || tab.contentType !== 'text') return false
      try {
        this.showErrorMessage('')
        const content = await backend.readFile(tab.path)
        tab.content = content
        tab.language = inferLanguage(tab.path)
        tab.isDirty = false
        tab.lastKnownDiskContent = content
        delete this.fileConflictPaths[workspaceKey(tab.path)]
        this.showActivityMessage(`已重新读取：${fileNameFromPath(tab.path)}`)
        return true
      } catch (error) {
        this.showErrorMessage(`重新读取失败：${tab.path}\n${formatError(error)}`)
        return false
      }
    },

    async reloadActiveTabFromDisk(): Promise<boolean> {
      if (!this.activeTabId) return false
      return this.reloadTabFromDisk(this.activeTabId)
    },

    async saveDirtyTextTabs(): Promise<boolean> {
      const dirtyTabs = [...this.dirtyTextTabs]
      if (!dirtyTabs.length) return true

      let savedCount = 0
      for (const ref of dirtyTabs) {
        const tab = ref.scope === 'current'
          ? this.tabs.find((item) => item.id === ref.tab.id)
          : this.workspaceSnapshots[ref.workspaceKey]?.tabs.find((item) => item.id === ref.tab.id)
        if (!tab || tab.contentType !== 'text' || !tab.isDirty) continue

        try {
          this.showErrorMessage('')
          await backend.writeFile(tab.path, tab.content)
          tab.isDirty = false
          tab.lastKnownDiskContent = tab.content
          delete this.fileConflictPaths[workspaceKey(tab.path)]
          savedCount += 1
          if (
            ref.scope === 'current' &&
            this.workspace &&
            isSameOrChildPath(tab.path, this.workspace.rootPath)
          ) {
            await this.loadDirectory(parentDirectoryOf(tab.path), true).catch(() => undefined)
          }
        } catch (error) {
          this.showErrorMessage(`保存失败：${tab.path}\n${formatError(error)}`)
          return false
        }
      }

      if (savedCount > 0) {
        this.showActivityMessage(`已保存 ${savedCount} 个未保存文件`)
      }
      return true
    },

    discardDirtyTextTabs() {
      for (const ref of [...this.dirtyTextTabs]) {
        const tab = ref.scope === 'current'
          ? this.tabs.find((item) => item.id === ref.tab.id)
          : this.workspaceSnapshots[ref.workspaceKey]?.tabs.find((item) => item.id === ref.tab.id)
        if (tab && tab.contentType === 'text') {
          tab.isDirty = false
        }
      }
    },

    async createFile(path: string) {
      const normalizedPath = normalizeFilePath(path)
      try {
        this.showErrorMessage('')
        await backend.createFile(normalizedPath)
        await this.loadDirectory(parentDirectoryOf(normalizedPath), true)
        this.showActivityMessage(`已新建文件：${fileNameFromPath(normalizedPath)}`)
        await this.openFile(normalizedPath)
      } catch (error) {
        this.showErrorMessage(`新建文件失败：${normalizedPath}\n${formatError(error)}`)
      }
    },

    async createDirectory(path: string) {
      const normalizedPath = normalizeFilePath(path)
      try {
        this.showErrorMessage('')
        await backend.createDirectory(normalizedPath)
        await this.loadDirectory(parentDirectoryOf(normalizedPath), true)
        this.showActivityMessage(`已新建文件夹：${fileNameFromPath(normalizedPath)}`)
      } catch (error) {
        this.showErrorMessage(`新建文件夹失败：${normalizedPath}\n${formatError(error)}`)
      }
    },

    async renamePath(path: string, nextName: string) {
      const normalizedPath = normalizeFilePath(path)
      const trimmedName = nextName.trim()
      if (!trimmedName) return
      const nextPath = joinPath(parentDirectoryOf(normalizedPath), trimmedName)
      if (normalizeFilePath(nextPath) === normalizedPath) return

      try {
        this.showErrorMessage('')
        await backend.renamePath(normalizedPath, nextPath)
        this.tabs = this.tabs.map((tab) => {
          if (!isSameOrChildPath(tab.path, normalizedPath)) return tab
          const nextTabPath = replacePathPrefix(tab.path, normalizedPath, nextPath)
          return {
            ...tab,
            path: nextTabPath,
            name: fileNameFromPath(nextTabPath),
          }
        })
        this.expandedPaths = this.expandedPaths.map((item) => replacePathPrefix(item, normalizedPath, nextPath))
        pruneDirectoryCacheForChangedPaths(this.directoryCache, [normalizedPath, nextPath])
        void this.syncWorkspaceWatchTargets()
        await this.refreshExplorer()
        this.showActivityMessage(`已重命名为：${fileNameFromPath(nextPath)}`)
      } catch (error) {
        this.showErrorMessage(`重命名失败：${normalizedPath}\n${formatError(error)}`)
      }
    },

    async deletePath(path: string) {
      const normalizedPath = normalizeFilePath(path)
      try {
        this.showErrorMessage('')
        await backend.deletePath(normalizedPath)
        this.tabs = this.tabs.filter((tab) => !isSameOrChildPath(tab.path, normalizedPath))
        if (this.activeTabId && !this.tabs.some((tab) => tab.id === this.activeTabId)) {
          this.activeTabId = this.tabs[0]?.id ?? null
        }
        this.expandedPaths = this.expandedPaths.filter((item) => !isSameOrChildPath(item, normalizedPath))
        pruneDirectoryCacheForChangedPaths(this.directoryCache, [normalizedPath])
        void this.syncWorkspaceWatchTargets()
        await this.refreshExplorer()
        this.showActivityMessage(`已删除：${fileNameFromPath(normalizedPath)}`)
      } catch (error) {
        this.showErrorMessage(`删除失败：${normalizedPath}\n${formatError(error)}`)
      }
    },

    closeTab(id: string) {
      const index = this.tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return
      const [removed] = this.tabs.splice(index, 1)
      if (this.activeTabId === removed.id) {
        // Select adjacent tab (prefer left neighbor), or fall back to first available
        this.activeTabId = this.tabs[index]?.id ?? this.tabs[Math.max(0, index - 1)]?.id ?? this.tabs[0]?.id ?? null
      }
      void this.syncWorkspaceWatchTargets()
    },

    async setActiveTab(id: string) {
      this.activeTabId = id
      const tab = this.tabs.find((item) => item.id === id)
      if (tab) await this.revealPathInExplorer(tab.path)
    },

    reorderTab(fromIndex: number, toIndex: number) {
      if (fromIndex === toIndex) return
      if (fromIndex < 0 || fromIndex >= this.tabs.length) return
      if (toIndex < 0 || toIndex >= this.tabs.length) return
      const [tab] = this.tabs.splice(fromIndex, 1)
      this.tabs.splice(toIndex, 0, tab)
    },

    closeSavedTabs() {
      const savedIds = new Set(this.tabs.filter((tab) => !tab.isDirty).map((tab) => tab.id))
      if (savedIds.size === 0) return
      this.tabs = this.tabs.filter((tab) => !savedIds.has(tab.id))
      if (this.activeTabId && savedIds.has(this.activeTabId)) {
        this.activeTabId = this.tabs[0]?.id ?? null
      }
      void this.syncWorkspaceWatchTargets()
    },

    cancelSearch() {
      searchRequestToken += 1
      if (searchDebounceTimer) window.clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
      searchDebounceResolve?.()
      searchDebounceResolve = null
      this.searchLoading = false
    },

    async searchProject(query: string, displayQuery = query, options: ProjectSearchOptions = {}) {
      this.searchQuery = displayQuery
      const backendQuery = query.trim()
      if (!backendQuery || !this.workspace) {
        this.cancelSearch()
        this.searchResults = null
        this.searchLoading = false
        return
      }
      const requestedDisplayQuery = displayQuery
      const requestToken = ++searchRequestToken
      this.searchLoading = true
      this.searchResults = null
      if (searchDebounceTimer) {
        window.clearTimeout(searchDebounceTimer)
        searchDebounceTimer = null
        searchDebounceResolve?.()
        searchDebounceResolve = null
      }
      const rootPath = this.workspace.rootPath
      const searchKey = workspaceKey(rootPath)
      await new Promise<void>((resolve) => {
        searchDebounceResolve = resolve
        searchDebounceTimer = window.setTimeout(() => {
          searchDebounceTimer = null
          searchDebounceResolve = null
          resolve()
        }, SEARCH_DEBOUNCE_MS)
      })
      if (this.searchQuery !== requestedDisplayQuery || requestToken !== searchRequestToken) return
      // Guard: workspace may have switched during debounce
      if (workspaceKey(this.workspace?.rootPath ?? '') !== searchKey) return
      try {
        const results = await backend.searchProjectFiles(backendQuery, [rootPath], {
          includeText: false,
          ...options,
          limit: 80,
        })
        if (this.searchQuery !== requestedDisplayQuery || requestToken !== searchRequestToken) return
        // Guard: workspace may have switched during search
        if (workspaceKey(this.workspace?.rootPath ?? '') !== searchKey) return
        this.searchResults = results
        this.searchOpen = true
      } catch (error) {
        if (requestToken !== searchRequestToken || this.searchQuery !== requestedDisplayQuery) return
        this.showErrorMessage(`搜索失败：${formatError(error)}`)
      } finally {
        if (this.searchQuery === requestedDisplayQuery && requestToken === searchRequestToken) {
          this.searchLoading = false
        }
      }
    },

    async refreshProjectInstructionFiles(projectPath?: string) {
      if (!isTauri()) return
      const targetPath = projectPath ?? this.workspace?.rootPath
      if (!targetPath) {
        this.projectInstructionFiles = null
        return
      }
      this.projectInstructionFilesLoading = true
      try {
        this.projectInstructionFiles = await backend.discoverProjectInstructionFiles(targetPath)
      } catch (error) {
        this.showErrorMessage(`项目指令文件读取失败：${formatError(error)}`)
      } finally {
        this.projectInstructionFilesLoading = false
      }
    },

    async migrateProjectInstructionFile(sourceKind: ProjectInstructionFileKind, targetKind: ProjectInstructionFileKind) {
      const projectPath = this.workspace?.rootPath
      if (!projectPath) return
      const result = await backend.migrateProjectInstructionFile(projectPath, sourceKind, targetKind)
      await Promise.all([
        this.refreshProjectInstructionFiles(projectPath),
        this.refreshExplorer(),
      ])
      const source = sourceKind === 'agents' ? 'AGENTS.md' : 'CLAUDE.md'
      const target = targetKind === 'agents' ? 'AGENTS.md' : 'CLAUDE.md'
      if (result.skipped) {
        this.showActivityMessage(`${source} 与 ${target} 内容一致，已跳过`)
      } else if (result.overwritten) {
        this.showActivityMessage(`已覆盖 ${target}，原文件已备份`)
      } else {
        this.showActivityMessage(`已从 ${source} 生成 ${target}`)
      }
    },

    async refreshCliEnvironments() {
      if (!isTauri()) return
      this.cliEnvironmentsLoading = true
      try {
        this.cliEnvironments = await backend.detectCliEnvironments()
      } catch (error) {
        this.showErrorMessage(`CLI 检测失败：${formatError(error)}`)
      } finally {
        this.cliEnvironmentsLoading = false
      }
    },

    async ensureMobileHostConfig() {
      if (!isTauri()) return null
      if (this.mobileHostConfig) return this.mobileHostConfig
      const config = await backend.ensureMobileHostConfig()
      this.mobileHostConfig = config
      this.settings.mobileHost = { ...config }
      return config
    },

    async refreshMobileHostStatus() {
      if (!isTauri()) return null
      this.mobileHostLoading = true
      try {
        const status = await backend.mobileHostStatus()
        this.mobileHostStatus = status
        this.mobileHostConfig = {
          port: status.port,
          token: status.token,
        }
        this.settings.mobileHost = { ...this.mobileHostConfig }
        return status
      } catch (error) {
        this.showErrorMessage(`手机端状态读取失败：${formatError(error)}`)
        return null
      } finally {
        this.mobileHostLoading = false
      }
    },

    async startMobileHost() {
      if (!isTauri()) return null
      this.mobileHostLoading = true
      try {
        const config = this.mobileHostConfig ?? await this.ensureMobileHostConfig()
        const status = await backend.startMobileHost(config ?? this.settings.mobileHost)
        this.mobileHostStatus = status
        this.mobileHostConfig = {
          port: status.port,
          token: status.token,
        }
        this.settings.mobileHost = { ...this.mobileHostConfig }
        this.showActivityMessage('手机端 Host 已启动')
        return status
      } catch (error) {
        this.showErrorMessage(`手机端 Host 启动失败：${formatError(error)}`)
        return null
      } finally {
        this.mobileHostLoading = false
      }
    },

    async stopMobileHost() {
      if (!isTauri()) return null
      this.mobileHostLoading = true
      try {
        const status = await backend.stopMobileHost()
        this.mobileHostStatus = status
        this.showActivityMessage('手机端 Host 已停止')
        return status
      } catch (error) {
        this.showErrorMessage(`手机端 Host 停止失败：${formatError(error)}`)
        return null
      } finally {
        this.mobileHostLoading = false
      }
    },

    async updateMobileHostConfig(partial: Partial<MobileHostConfig>) {
      const config = await this.ensureMobileHostConfig()
      if (!config) return
      const next = {
        ...config,
        ...partial,
      }
      next.port = Number.isFinite(Number(next.port)) ? Number(next.port) : 10320
      next.token = next.token.trim()
      this.mobileHostConfig = next
      this.settings.mobileHost = { ...next }
    },

    async regenerateMobileHostToken() {
      await this.updateMobileHostConfig({ token: randomId('mobile').replace(/[^a-z0-9]/gi, '').slice(0, 12) })
    },

    async refreshAppStorageInfo() {
      if (!isTauri()) return
      this.appStorageInfoLoading = true
      try {
        this.appStorageInfo = await backend.getAppStorageInfo()
      } catch (error) {
        this.showErrorMessage(`数据存储信息读取失败：${formatError(error)}`)
      } finally {
        this.appStorageInfoLoading = false
      }
    },

    async detectVitePressDocs(rootPath: string) {
      if (!isTauri() || !rootPath) return null
      const key = workspaceKey(rootPath)
      const existing = this.docsWorkspaces[key]
      if (existing?.status === 'missing') return null
      if (existing?.status === 'starting') return existing
      try {
        const info = await backend.detectVitePressDocs(rootPath)
        const docsWorkspace = docsWorkspaceFromInfo(info)
        if (this.docsWorkspaces[key] !== existing) return this.docsWorkspaces[key] ?? null
        this.docsWorkspaces[key] = docsWorkspace
        return docsWorkspace
      } catch (error) {
        if (this.docsWorkspaces[key] !== existing) return this.docsWorkspaces[key] ?? null
        const message = formatError(error)
        this.docsWorkspaces[key] = {
          projectPath: rootPath,
          docsRoot: '',
          url: '',
          port: 0,
          running: false,
          startedBySuperHigh: false,
          status: message.includes('未找到') ? 'missing' : 'error',
          error: message,
        }
        return null
      }
    },

    async ensureVitePressDocs(rootPath?: string) {
      if (!isTauri()) return null
      const targetRoot = rootPath ?? this.workspace?.rootPath
      if (!targetRoot) return null
      if (!this.workspace || workspaceKey(this.workspace.rootPath) !== workspaceKey(targetRoot)) {
        const switched = await this.switchWorkspace(targetRoot)
        if (!switched) return null
      }
      const key = workspaceKey(targetRoot)
      this.registerDocsTab(targetRoot)
      this.settingsOpen = false
      this.activeWorkspaceSurface = 'docs'
      const existing = this.docsWorkspaces[key]
      if (existing?.status === 'starting') return existing
      this.docsWorkspaces[key] = {
        projectPath: existing?.projectPath ?? targetRoot,
        docsRoot: existing?.docsRoot ?? '',
        url: existing?.url ?? '',
        port: existing?.port ?? 0,
        running: existing?.running ?? false,
        startedBySuperHigh: existing?.startedBySuperHigh ?? false,
        status: 'starting',
        error: undefined,
      }
      try {
        const info = await backend.ensureVitePressDocs(targetRoot)
        const docsWorkspace = docsWorkspaceFromInfo(info, 'running')
        this.docsWorkspaces[key] = docsWorkspace
        this.showActivityMessage(`文档预览已打开：${docsWorkspace.url}`)
        return docsWorkspace
      } catch (error) {
        const message = formatError(error)
        this.docsWorkspaces[key] = {
          ...this.docsWorkspaces[key],
          status: message.includes('未找到') ? 'missing' : 'error',
          running: false,
          error: message,
        }
        this.showErrorMessage(`文档预览失败：${message}`)
        return null
      }
    },

    async stopVitePressDocs(rootPath: string) {
      if (!isTauri() || !rootPath) return
      try {
        const info = await backend.stopVitePressDocs(rootPath)
        this.docsWorkspaces[workspaceKey(rootPath)] = docsWorkspaceFromInfo(info, 'idle')
      } catch (error) {
        this.showErrorMessage(`文档预览停止失败：${formatError(error)}`)
      }
    },

    async selectDirectory(path?: string) {
      if (!isTauri()) return null
      return backend.selectDirectory(path)
    },

    async createTerminalSession(
      providerKind: TerminalProviderKind,
      options: { name?: string; cwd?: string; initialPrompt?: string; launchPrompt?: boolean } = {},
    ) {
      const cwd = options.cwd?.trim() || this.workspace?.rootPath
      if (!cwd) return
      const initialPrompt = options.initialPrompt?.trim()
      const launchPrompt = options.launchPrompt && initialPrompt ? initialPrompt : undefined
      const session = await backend.createTerminalSession(this.workspace?.id ?? null, providerKind, cwd, launchPrompt)
      const name = options.name?.trim()
      if (name) session.name = name
      this.terminalSessions.push(session)
      this.setActiveTerminalSession(session.id)
      this.terminalDrafts[session.id] = this.terminalDrafts[session.id] ?? ''
      this.terminalConversation[session.id] = this.terminalConversation[session.id] ?? []
      this.terminalConversationReplyPending[session.id] = this.terminalConversationReplyPending[session.id] ?? false
      this.schedulePersistTerminalState()
      if (initialPrompt && !options.launchPrompt) {
        await this.sendTerminalConversationMessage(session.id, initialPrompt)
      } else if (launchPrompt) {
        const launchMessage = {
          id: crypto.randomUUID(),
          sessionId: session.id,
          role: 'user' as const,
          content: launchPrompt,
          timestamp: new Date().toISOString(),
        }
        this.appendTerminalConversationMessage(launchMessage)
        this.rememberCliHistoryMessage(launchMessage, session.cwd)
      }
      return session
    },

    async refreshProjectStartupConfig() {
      const refreshToken = ++projectStartupConfigRefreshToken
      const rootPath = this.workspace?.rootPath
      if (!rootPath || !isTauri()) {
        this.projectStartupConfig = null
        this.projectStartupConfigRootPath = ''
        this.projectStartupConfigLoading = false
        this.projectServiceRun = null
        return
      }
      const rootKey = workspaceKey(rootPath)
      const isCurrentRequest = () => (
        refreshToken === projectStartupConfigRefreshToken
        && workspaceKey(this.workspace?.rootPath ?? '') === rootKey
      )
      if (workspaceKey(this.projectStartupConfigRootPath) === rootKey && this.projectStartupConfig) {
        this.projectStartupConfigLoading = false
        return
      }
      if (workspaceKey(this.projectStartupConfigRootPath) !== rootKey) {
        this.projectStartupConfig = null
        this.projectStartupConfigRootPath = rootPath
        this.projectServiceRun = null
      }
      this.projectStartupConfigLoading = true
      try {
        const config = await backend.getProjectStartupConfig(rootPath)
        if (!isCurrentRequest()) return
        this.projectStartupConfig = config
        this.projectStartupConfigRootPath = rootPath
        this.syncProjectServiceRunFromLiveSessions(rootPath)
      } catch (error) {
        if (!isCurrentRequest()) return
        this.projectStartupConfig = null
        this.projectStartupConfigRootPath = rootPath
        this.showErrorMessage(`读取项目启动配置失败：${formatError(error)}`)
      } finally {
        if (isCurrentRequest()) {
          this.projectStartupConfigLoading = false
        }
      }
    },

    // 刷新当前工作区的本地终端动作按钮配置。
    async refreshProjectTerminalActions() {
      const refreshToken = ++projectTerminalActionsRefreshToken
      const rootPath = this.workspace?.rootPath
      if (!rootPath || !isTauri()) {
        this.projectTerminalActions = []
        this.projectTerminalActionsRootPath = ''
        this.projectTerminalActionsLoading = false
        this.projectTerminalActionBusy = {}
        return
      }
      const rootKey = workspaceKey(rootPath)
      const isCurrentRequest = () => (
        refreshToken === projectTerminalActionsRefreshToken
        && workspaceKey(this.workspace?.rootPath ?? '') === rootKey
      )
      if (workspaceKey(this.projectTerminalActionsRootPath) !== rootKey) {
        this.projectTerminalActions = []
        this.projectTerminalActionsRootPath = rootPath
        this.projectTerminalActionBusy = {}
      }
      this.projectTerminalActionsLoading = true
      try {
        const actions = await backend.getProjectTerminalActions(rootPath)
        if (!isCurrentRequest()) return
        this.projectTerminalActions = actions
        this.projectTerminalActionsRootPath = rootPath
      } catch (error) {
        if (!isCurrentRequest()) return
        this.projectTerminalActions = []
        this.projectTerminalActionsRootPath = rootPath
        this.showErrorMessage(`读取本地终端动作失败：${formatError(error)}`)
      } finally {
        if (isCurrentRequest()) {
          this.projectTerminalActionsLoading = false
        }
      }
    },

    async createProjectStartupTerminalSession() {
      const rootPath = this.workspace?.rootPath
      if (!rootPath) return
      const workspaceId = this.workspace?.id ?? null
      const rootKey = workspaceKey(rootPath)
      const session = await backend.createProjectStartupTerminalSession(workspaceId, rootPath)
      const currentWorkspaceMatches = (
        this.workspace?.id === workspaceId
        && workspaceKey(this.workspace?.rootPath ?? '') === rootKey
      )
      if (!currentWorkspaceMatches) {
        Promise.resolve(backend.closeTerminal(session.id)).catch((error) => {
          this.showErrorMessage(`终端进程清理失败：${formatError(error)}`)
        })
        return
      }
      this.closeExitedManagedTerminalSessions(session)
      this.terminalSessions.push(session)
      this.setActiveTerminalSession(session.id)
      this.terminalDrafts[session.id] = this.terminalDrafts[session.id] ?? ''
      this.terminalConversation[session.id] = this.terminalConversation[session.id] ?? []
      this.terminalConversationReplyPending[session.id] = this.terminalConversationReplyPending[session.id] ?? false
      this.schedulePersistTerminalState()
      return session
    },

    syncProjectServiceRunFromLiveSessions(rootPath?: string) {
      const projectPath = rootPath ?? this.workspace?.rootPath
      const config = this.projectStartupConfig
      if (!projectPath || config?.mode !== 'services') {
        this.projectServiceRun = null
        return
      }
      const services = config.services ?? []
      if (!services.length) return

      const liveByService = new Map<string, TerminalSession>()
      for (const service of services) {
        const session = this.terminalSessions.find((item) => (
          item.providerKind === 'project-service'
          && terminalSessionIsLive(item)
          && item.title === service.name
          && workspaceKey(item.cwd) === workspaceKey(service.workingDirectory)
        ))
        if (session) liveByService.set(service.id, session)
      }
      if (!liveByService.size) return

      const existing = this.projectServiceRun && workspaceKey(this.projectServiceRun.projectPath) === workspaceKey(projectPath)
        ? this.projectServiceRun
        : null
      const nextServices: ProjectServiceRunState['services'] = { ...(existing?.services ?? {}) }
      for (const service of services) {
        const session = liveByService.get(service.id)
        if (!session) continue
        nextServices[service.id] = {
          serviceId: service.id,
          status: 'running',
          sessionId: session.id,
          message: nextServices[service.id]?.message ?? null,
        }
      }
      this.projectServiceRun = {
        projectPath,
        runId: existing?.runId ?? `restored-${Date.now()}`,
        chainStatus: deriveProjectServiceChainStatus(nextServices),
        services: nextServices,
      }
    },

    // 执行“启动项目”动作，自动兼容单脚本和服务链两种启动配置。
    async startProjectFromTerminalAction() {
      if (this.projectStartupConfig?.mode === 'services') {
        return this.startProjectServices()
      }
      return this.createProjectStartupTerminalSession()
    },

    // 查找单脚本启动模式下仍在运行的 SuperHigh 控制台。
    findProjectStartupActionSession(): TerminalSession | null {
      const expectedTitle = this.projectStartupConfig?.name?.trim()
      return this.terminalSessions.find((session) => (
        session.providerKind === 'project-startup'
        && terminalSessionIsLive(session)
        && this.terminalExitCodes[session.id] == null
        && (expectedTitle ? session.title === expectedTitle : true)
      )) ?? null
    },

    // 按 serviceId 查找服务链里对应的 SuperHigh 控制台。
    findProjectServiceActionSession(serviceId?: string | null): TerminalSession | null {
      const normalizedServiceId = serviceId?.trim()
      if (!normalizedServiceId) return null
      const sessionId = this.projectServiceRun?.services[normalizedServiceId]?.sessionId
      if (!sessionId) return null
      return this.terminalSessions.find((session) => session.id === sessionId && terminalSessionIsLive(session)) ?? null
    },

    // 执行“重启项目”动作：写入 stop，并按配置决定是否重新启动脚本。
    async restartProjectFromTerminalAction(action: ProjectTerminalAction) {
      const session = this.findProjectServiceActionSession(action.serviceId)
        ?? this.findProjectStartupActionSession()
      if (!session) {
        await this.startProjectFromTerminalAction()
        this.showActivityMessage(`${action.label}：未找到运行中的控制台，已尝试启动项目`)
        return
      }

      await this.writeTerminalInput(terminalInputLine(action.input ?? 'stop'), session.id)
      this.setActiveTerminalSession(session.id)
      if (!action.startAfterCommand) {
        this.showActivityMessage(`${action.label}：已发送 ${action.input?.trim() || 'stop'}`)
        return
      }

      await delay(action.restartDelayMs || 5_000)
      if (this.terminalSessions.some((item) => item.id === session.id && terminalSessionIsLive(item))) {
        await this.closeTerminalSession(session.id)
      }
      this.projectServiceRun = null
      await this.startProjectFromTerminalAction()
      this.showActivityMessage(`${action.label}：已重新启动`)
    },

    // 本地终端动作总入口，用忙碌标记防止同一个按钮重复触发。
    async runProjectTerminalAction(action: ProjectTerminalAction) {
      if (this.projectTerminalActionBusy[action.id]) return
      this.projectTerminalActionBusy = { ...this.projectTerminalActionBusy, [action.id]: true }
      try {
        if (action.kind === 'start-project') {
          const result = await this.startProjectFromTerminalAction()
          const externalService = result && 'services' in result
            ? result.services.find((service) => service.status === 'externalRunning')
            : null
          if (externalService) {
            this.showErrorMessage(`${action.label}：${externalService.message ?? '检测到外部实例，Super High 无法接管其控制台'}`)
          } else {
            this.showActivityMessage(`${action.label}：已在 Super High 本地终端执行`)
          }
        } else if (action.kind === 'restart-project') {
          await this.restartProjectFromTerminalAction(action)
        }
      } catch (error) {
        this.showErrorMessage(`${action.label}失败：${formatError(error)}`)
      } finally {
        const next = { ...this.projectTerminalActionBusy }
        delete next[action.id]
        this.projectTerminalActionBusy = next
      }
    },

    applyProjectServiceStatus(event: ProjectServiceStatusEvent) {
      const rootPath = this.workspace?.rootPath
      if (!rootPath || workspaceKey(rootPath) !== workspaceKey(event.projectPath)) return
      if (!this.projectServiceRun || this.projectServiceRun.runId !== event.runId) {
        this.projectServiceRun = {
          projectPath: event.projectPath,
          runId: event.runId,
          chainStatus: 'starting',
          services: {},
        }
      }
      if (event.session && !this.terminalSessions.some((session) => session.id === event.session?.id)) {
        this.closeExitedManagedTerminalSessions(event.session)
        this.terminalSessions.push(event.session)
        this.terminalDrafts[event.session.id] = this.terminalDrafts[event.session.id] ?? ''
        this.terminalConversation[event.session.id] = this.terminalConversation[event.session.id] ?? []
        this.terminalConversationReplyPending[event.session.id] = this.terminalConversationReplyPending[event.session.id] ?? false
      }
      const previous = this.projectServiceRun.services[event.serviceId]
      this.projectServiceRun.services[event.serviceId] = {
        serviceId: event.serviceId,
        status: event.status,
        sessionId: event.session?.id ?? previous?.sessionId ?? null,
        message: event.message ?? previous?.message ?? null,
      }
      this.projectServiceRun.chainStatus = deriveProjectServiceChainStatus(this.projectServiceRun.services)
      this.schedulePersistTerminalState()
    },

    async startProjectServices(): Promise<ProjectServicesStartResult | undefined> {
      const rootPath = this.workspace?.rootPath
      if (!rootPath || this.projectServicesStarting || ['starting', 'running'].includes(this.projectServiceRun?.chainStatus ?? 'idle')) return
      const workspaceId = this.workspace?.id ?? null
      const rootKey = workspaceKey(rootPath)
      this.projectServicesStarting = true
      try {
        const result = await backend.startProjectServices(workspaceId, rootPath)
        if (this.workspace?.id !== workspaceId || workspaceKey(this.workspace?.rootPath ?? '') !== rootKey) return result
        for (const service of result.services) {
          this.applyProjectServiceStatus({
            projectPath: result.projectPath,
            runId: result.runId,
            serviceId: service.serviceId,
            status: service.status,
            session: service.session,
            message: service.message,
          })
        }
        return result
      } finally {
        this.projectServicesStarting = false
      }
    },

    focusProjectService(serviceId: string): boolean {
      const sessionId = this.projectServiceRun?.services[serviceId]?.sessionId
      if (!sessionId) return false
      const session = this.terminalSessions.find((item) => item.id === sessionId && terminalSessionIsLive(item))
      if (!session) return false
      this.setActiveTerminalSession(session.id)
      return true
    },

    async closeProjectServiceSessions() {
      const sessionIds = Array.from(new Set(Object.values(this.projectServiceRun?.services ?? {})
        .map((service) => service.sessionId)
        .filter((sessionId): sessionId is string => !!sessionId)))
      for (const sessionId of sessionIds) await this.closeTerminalSession(sessionId)
      this.projectServiceRun = null
    },

    markProjectServiceExited(sessionId: string) {
      if (!this.projectServiceRun) return
      for (const service of Object.values(this.projectServiceRun.services)) {
        if (service.sessionId !== sessionId || service.status === 'failed') continue
        service.status = 'exited' as ProjectServiceStatus
      }
      this.projectServiceRun.chainStatus = deriveProjectServiceChainStatus(this.projectServiceRun.services)
    },

    setActiveTerminalSession(sessionId: string | null) {
      const session = this.terminalSessions.find((item) => item.id === sessionId)
      if (!session) {
        this.activeTerminalSessionId = null
        this.schedulePersistTerminalState()
        return
      }
      this.activeTerminalSessionId = terminalSessionIsLive(session) ? session.id : null
      if (isLocalTerminalSessionKind(session.providerKind)) {
        this.activeLocalTerminalSessionId = session.id
      } else {
        this.activeCliSessionId = session.id
      }
      this.schedulePersistTerminalState()
    },

    setTerminalDraft(sessionId: string, value: string) {
      this.terminalDrafts[sessionId] = value
      this.schedulePersistTerminalState()
    },

    insertIntoTerminalDraft(sessionId: string, text: string) {
      const current = this.terminalDrafts[sessionId] ?? ''
      const separator = current.endsWith('\n') || current.length === 0 ? '' : '\n'
      this.terminalDrafts[sessionId] = `${current}${separator}${text}`
      this.schedulePersistTerminalState()
    },

    appendTerminalConversationMessage(message: CliConversationMessage) {
      const messages = normalizeTerminalMessages([...(this.terminalConversation[message.sessionId] ?? []), {
        ...message,
        content: truncateTerminalMessageContent(message.content),
      }])
      this.terminalConversation[message.sessionId] = messages
      this.schedulePersistTerminalState()
    },

    setTerminalReplyPendingInState(
      sessionId: string,
      pending: boolean,
      state?: TerminalStateSource,
      rootPath?: string,
    ) {
      const targetState = state ?? this.currentTerminalStateSource()
      const existing = terminalReplyIdleTimers.get(sessionId)
      if (existing) window.clearTimeout(existing)
      terminalReplyIdleTimers.delete(sessionId)
      targetState.terminalConversationReplyPending[sessionId] = pending
      if (!pending) return
      const timer = window.setTimeout(() => {
        terminalReplyIdleTimers.delete(sessionId)
        targetState.terminalConversationReplyPending[sessionId] = false
        if (rootPath) this.schedulePersistTerminalState(rootPath)
      }, TERMINAL_REPLY_IDLE_MS)
      terminalReplyIdleTimers.set(sessionId, timer)
    },

    setTerminalReplyPending(sessionId: string, pending: boolean) {
      this.setTerminalReplyPendingInState(sessionId, pending, this.currentTerminalStateSource(), this.workspace?.rootPath)
    },

    recordTerminalExit(sessionId: string, exitCode: number | null) {
      const target = this.terminalStateTargetForSession(sessionId)
      if (!target) return
      target.state.terminalExitCodes[sessionId] = exitCode
      this.setTerminalReplyPendingInState(sessionId, false, target.state, target.rootPath)
      this.schedulePersistTerminalState(target.rootPath)
    },

    queueTerminalOutput(sessionId: string, chunk: string) {
      if (!chunk || !this.terminalStateTargetForSession(sessionId)) return
      const chunks = terminalOutputBuffers.get(sessionId) ?? []
      chunks.push(chunk)
      terminalOutputBuffers.set(sessionId, chunks)
      const length = (terminalOutputBufferLengths.get(sessionId) ?? 0) + chunk.length
      terminalOutputBufferLengths.set(sessionId, length)
      if (terminalOutputFlushTimers.has(sessionId)) return
      terminalOutputFlushTimers.set(sessionId, window.setTimeout(() => {
        terminalOutputFlushTimers.delete(sessionId)
        this.flushTerminalOutput(sessionId)
      }, TERMINAL_OUTPUT_BATCH_DELAY_MS))
    },

    flushTerminalOutput(sessionId: string) {
      const timer = terminalOutputFlushTimers.get(sessionId)
      if (timer) window.clearTimeout(timer)
      terminalOutputFlushTimers.delete(sessionId)
      const chunks = terminalOutputBuffers.get(sessionId)
      if (!chunks?.length) {
        terminalOutputBuffers.delete(sessionId)
        terminalOutputBufferLengths.delete(sessionId)
        this.finishTerminalExit(sessionId)
        return
      }
      const batch: string[] = []
      let remaining = TERMINAL_OUTPUT_BATCH_MAX_LENGTH
      while (remaining > 0 && chunks.length) {
        const chunk = chunks[0]
        if (chunk.length <= remaining) {
          batch.push(chunk)
          chunks.shift()
          remaining -= chunk.length
        } else {
          batch.push(chunk.slice(0, remaining))
          chunks[0] = chunk.slice(remaining)
          remaining = 0
        }
      }
      const processedLength = TERMINAL_OUTPUT_BATCH_MAX_LENGTH - remaining
      const queuedLength = (terminalOutputBufferLengths.get(sessionId) ?? processedLength) - processedLength
      if (chunks.length) {
        terminalOutputBufferLengths.set(sessionId, queuedLength)
      } else {
        terminalOutputBuffers.delete(sessionId)
        terminalOutputBufferLengths.delete(sessionId)
      }
      const text = batch.join('')
      this.appendTerminalConversationReply(sessionId, text)
      this.schedulePlanDetection(sessionId, text)
      if (chunks.length) {
        terminalOutputFlushTimers.set(sessionId, window.setTimeout(() => {
          terminalOutputFlushTimers.delete(sessionId)
          this.flushTerminalOutput(sessionId)
        }, TERMINAL_OUTPUT_BACKLOG_DELAY_MS))
        return
      }
      this.finishTerminalExit(sessionId)
    },

    flushPendingTerminalOutput() {
      for (const sessionId of Array.from(terminalOutputBuffers.keys())) {
        while (terminalOutputBuffers.has(sessionId)) this.flushTerminalOutput(sessionId)
      }
    },

    finishTerminalOutputForExit(sessionId: string, exitCode: number | null) {
      terminalOutputPendingExits.set(sessionId, exitCode)
      if (!terminalOutputBuffers.has(sessionId)) {
        this.finishTerminalExit(sessionId)
        return
      }
      const timer = terminalOutputFlushTimers.get(sessionId)
      if (timer) window.clearTimeout(timer)
      terminalOutputFlushTimers.set(sessionId, window.setTimeout(() => {
        terminalOutputFlushTimers.delete(sessionId)
        this.flushTerminalOutput(sessionId)
      }, 0))
    },

    finishTerminalExit(sessionId: string) {
      if (!terminalOutputPendingExits.has(sessionId)) return
      const exitCode = terminalOutputPendingExits.get(sessionId) ?? null
      terminalOutputPendingExits.delete(sessionId)
      this.recordTerminalExit(sessionId, exitCode)
      this.markProjectServiceExited(sessionId)
    },

    async sendTerminalConversationMessage(sessionId: string, text: string) {
      const trimmed = text.trim()
      if (!trimmed) return false
      const session = this.terminalSessions.find((item) => item.id === sessionId)
      if (!session || session.restoredFromDisk) {
        this.showErrorMessage('历史会话已结束，请新建对话继续。')
        return false
      }
      const message: CliConversationMessage = {
        id: crypto.randomUUID(),
        sessionId,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      }
      await this.writeTerminalInput(`${trimmed}\r`, sessionId)
      this.appendTerminalConversationMessage(message)
      this.rememberCliHistoryMessage(message, session.cwd)
      this.terminalDrafts[sessionId] = ''
      this.setTerminalReplyPending(sessionId, true)
      this.schedulePersistTerminalState()
      return true
    },

    appendTerminalConversationReply(sessionId: string, text: string) {
      const target = this.terminalStateTargetForSession(sessionId)
      if (!target || !target.state.terminalConversationReplyPending[sessionId]) return
      const messages = target.state.terminalConversation[sessionId] ?? []
      const lastUserIndex = findLastMessageIndex(messages, 'user')
      if (lastUserIndex < 0) return
      const content = summarizeTerminalReply(text, messages[lastUserIndex].content)
      if (!content) return
      this.setTerminalReplyPendingInState(sessionId, true, target.state, target.rootPath)
      const lastSystemIndex = findLastMessageIndex(messages, 'system')
      if (lastSystemIndex > lastUserIndex) {
        const last = messages[lastSystemIndex]
        const nextContent = mergeTerminalReplyText(last.content, content)
        if (nextContent === last.content) return
        target.state.terminalConversation[sessionId] = messages.map((message, index) => (
          index === lastSystemIndex
            ? { ...message, content: nextContent, timestamp: new Date().toISOString() }
            : message
        ))
        this.schedulePersistTerminalState(target.rootPath)
        return
      }
      target.state.terminalConversation[sessionId] = [
        ...messages,
        {
          id: crypto.randomUUID(),
          sessionId,
          role: 'system',
          content,
          timestamp: new Date().toISOString(),
        },
      ]
      target.state.terminalConversation[sessionId] = normalizeTerminalMessages(target.state.terminalConversation[sessionId])
      this.schedulePersistTerminalState(target.rootPath)
    },

    async writeTerminalInput(input: string, sessionId?: string | null) {
      const targetSessionId = sessionId ?? useWorkspaceStore().activeTerminalSessionId
      if (!targetSessionId) return
      await backend.writeTerminalInput(targetSessionId, input)
    },

    async resizeTerminalSession(sessionId: string, cols: number, rows: number) {
      await backend.resizeTerminal(sessionId, cols, rows)
    },

    async closeTerminalSession(sessionId: string) {
      const closing = this.terminalSessions.find((session) => session.id === sessionId)
      if (!closing) return
      clearTerminalSessionRuntimeState(sessionId)
      this.terminalSessions = this.terminalSessions.filter((session) => session.id !== sessionId)
      delete this.terminalDrafts[sessionId]
      delete this.terminalConversation[sessionId]
      delete this.terminalConversationReplyPending[sessionId]
      delete this.terminalExitCodes[sessionId]
      delete this.cliPlans[sessionId]
      if (this.activeTerminalSessionId === sessionId) {        const fallback = closing && isLocalTerminalSessionKind(closing.providerKind)
          ? this.localTerminalSessions[0] ?? this.cliTerminalSessions[0]
          : this.cliTerminalSessions[0] ?? this.localTerminalSessions[0]
        this.activeTerminalSessionId = fallback?.id ?? null
      }
      if (this.activeCliSessionId === sessionId) {
        this.activeCliSessionId = this.cliTerminalSessions[0]?.id ?? null
      }
      if (this.activeLocalTerminalSessionId === sessionId) {
        this.activeLocalTerminalSessionId = this.localTerminalSessions[0]?.id ?? null
      }
      if (!closing.restoredFromDisk) {
        backend.closeTerminal(sessionId).catch((error) => {
          this.showErrorMessage(`终端进程清理失败：${formatError(error)}`)
        })
      }
      this.schedulePersistTerminalState()
    },

    async closeTerminalSessionsForWorkspace(workspaceId: string) {
      if (!isTauri() || !workspaceId) return
      const shouldClearCurrentWorkspace = this.workspace?.id === workspaceId
      const snapshotEntry = shouldClearCurrentWorkspace
        ? null
        : Object.entries(this.workspaceSnapshots).find(([, snapshot]) => snapshot.workspace.id === workspaceId) ?? null
      const closeIds = shouldClearCurrentWorkspace
        ? new Set(this.terminalSessions.map((session) => session.id))
        : new Set(snapshotEntry?.[1].terminalSessions.map((session) => session.id) ?? [])
      if (shouldClearCurrentWorkspace) {
        for (const sessionId of closeIds) {
          clearTerminalSessionRuntimeState(sessionId)
        }
        this.terminalSessions = []
        this.activeTerminalSessionId = null
        this.activeCliSessionId = null
        this.activeLocalTerminalSessionId = null
        for (const sessionId of closeIds) {
          delete this.terminalDrafts[sessionId]
          delete this.terminalConversation[sessionId]
          delete this.terminalConversationReplyPending[sessionId]
          delete this.terminalExitCodes[sessionId]
          delete this.cliPlans[sessionId]
        }
      } else if (snapshotEntry) {
        const [, snapshot] = snapshotEntry
        for (const sessionId of closeIds) {
          clearTerminalSessionRuntimeState(sessionId)
          delete this.cliPlans[sessionId]
        }
        snapshot.terminalSessions = []
        snapshot.activeTerminalSessionId = null
        snapshot.activeCliSessionId = null
        snapshot.activeLocalTerminalSessionId = null
        snapshot.terminalDrafts = {}
        snapshot.terminalConversation = {}
        snapshot.terminalConversationReplyPending = {}
        snapshot.terminalExitCodes = {}
        await this.persistTerminalState(snapshot.workspace.rootPath, emptyTerminalStateSource()).catch((error) => {
          this.showErrorMessage(`终端对话保存失败：${formatError(error)}`)
        })
      }
      backend.closeTerminalSessionsForWorkspace(workspaceId).catch((error) => {
        this.showErrorMessage(`工作区终端关闭失败：${formatError(error)}`)
      })
      if (shouldClearCurrentWorkspace) this.schedulePersistTerminalState()
    },

    renameTerminalSession(sessionId: string, name: string) {
      const session = this.terminalSessions.find((item) => item.id === sessionId)
      if (!session) return
      session.name = name.trim()
      this.schedulePersistTerminalState()
    },

    reorderCliTerminalSession(fromSessionId: string, toSessionId: string) {
      if (!fromSessionId || fromSessionId === toSessionId) return
      const visibleSessions = this.cliTerminalSessions
      const fromVisibleIndex = visibleSessions.findIndex((session) => session.id === fromSessionId)
      const toVisibleIndex = visibleSessions.findIndex((session) => session.id === toSessionId)
      if (fromVisibleIndex < 0 || toVisibleIndex < 0) return

      const nextVisible = [...visibleSessions]
      const [session] = nextVisible.splice(fromVisibleIndex, 1)
      nextVisible.splice(toVisibleIndex, 0, session)

      const reorderedIds = new Set(nextVisible.map((item) => item.id))
      let visibleIndex = 0
      this.terminalSessions = this.terminalSessions.map((item) => {
        if (!reorderedIds.has(item.id)) return item
        return nextVisible[visibleIndex++] ?? item
      })
      this.schedulePersistTerminalState()
    },

    setPreviewMode(mode: 'code' | 'local_terminal') {
      this.settings.activePreviewMode = mode
      this.codePreviewScopePath = null
      void this.saveSettings()
    },

    setMultiTerminalMode(enabled: boolean) {
      this.settings.multiTerminalMode = enabled
      if (enabled) {
        this.settings.activePreviewMode = 'code'
        this.codePreviewScopePath = null
      }
      void this.saveSettings()
    },

    setDialogueMapMode(enabled: boolean) {
      this.settings.dialogueMapMode = enabled
      if (enabled && this.workspace) {
        this.activeWorkspaceSurface = 'project'
        this.settingsOpen = false
        void this.refreshNativeCliConversations()
      }
      void this.saveSettings()
    },

    dialogueMapWorkspaceState(rootPath?: string): DialogueMapWorkspaceState {
      const key = workspaceKey(rootPath ?? this.workspace?.rootPath ?? '')
      if (!key) return defaultDialogueMapWorkspaceState()
      const existing = this.settings.dialogueMapByWorkspace[key]
      if (existing) return existing
      const next = defaultDialogueMapWorkspaceState()
      this.settings.dialogueMapByWorkspace[key] = next
      return next
    },

    setDialogueMapViewport(viewport: DialogueMapViewport, persist = true) {
      const state = this.dialogueMapWorkspaceState()
      state.viewport = normalizeDialogueMapViewport(viewport)
      if (persist) void this.saveSettings()
    },

    setDialogueMapCardPosition(conversationId: string, position: DialogueMapPosition, persist = true) {
      if (!conversationId) return
      const x = Number(position.x)
      const y = Number(position.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const state = this.dialogueMapWorkspaceState()
      state.positions[conversationId] = { x, y }
      if (persist) void this.saveSettings()
    },

    resetDialogueMapWorkspaceState() {
      const rootPath = this.workspace?.rootPath
      if (!rootPath) return
      delete this.settings.dialogueMapByWorkspace[workspaceKey(rootPath)]
      void this.saveSettings()
    },

    async openScopedCodePreview(path: string, scopePath: string, options: { keepWorkspaceSurface?: boolean } = {}): Promise<boolean> {
      const normalizedPath = normalizeFilePath(path)
      const normalizedScopePath = normalizeFilePath(scopePath)
      if (!normalizedPath || !normalizedScopePath || !isSameOrChildPath(normalizedPath, normalizedScopePath)) return false

      if (!options.keepWorkspaceSurface) this.setWorkspaceSurface('project')
      this.setPreviewMode('code')
      const opened = await this.openFile(normalizedPath, {
        createUnsupportedTabOnError: false,
        preserveCodePreviewScope: true,
        revealInExplorer: false,
      })
      if (opened) this.codePreviewScopePath = normalizedScopePath
      return opened
    },

    setScopedCodePreviewContent(path: string, content: string, options: { isDirty?: boolean } = {}): boolean {
      const normalizedPath = normalizeFilePath(path)
      const tab = this.tabs.find((item) => workspaceKey(item.path) === workspaceKey(normalizedPath))
      if (!tab || tab.contentType !== 'text') return false
      tab.content = content
      tab.isDirty = options.isDirty ?? true
      if (!tab.isDirty) tab.lastKnownDiskContent = content
      this.activeTabId = tab.id
      delete this.fileConflictPaths[workspaceKey(tab.path)]
      return true
    },

    toggleProjectLayoutMode() {
      this.settings.projectLayoutMode = this.settings.projectLayoutMode === 'swapped' ? 'default' : 'swapped'
      void this.saveSettings()
    },

    async setRenderColorCodes(enabled: boolean) {
      this.settings.renderColorCodes = enabled
      await this.saveSettings()
    },

    async setYamlKeyValuePanelEnabled(enabled: boolean) {
      this.settings.yamlKeyValuePanelEnabled = enabled
      await this.saveSettings()
    },

    setWorkspaceSurface(surface: WorkspaceSurfaceKind) {
      if (surface === 'scripts') {
        this.scriptToolsOpen = true
        this.settingsOpen = false
        return
      }
      if ((surface === 'editor' || surface === 'docs' || surface === 'files') && !this.workspace) return
      this.activeWorkspaceSurface = surface
      this.settingsOpen = false
    },

    restoreProjectEditorEntryTab() {
      const entryPath = normalizeFilePath(this.projectEditorEntryPath ?? '')
      const tab = this.tabs.find((item) => normalizeFilePath(item.path).toLowerCase() === entryPath.toLowerCase())
      if (tab) this.activeTabId = tab.id
    },

    closeCodePreviewProjectEditor() {
      this.codePreviewProjectEditorOpen = false
      this.codePreviewScopePath = null
      this.restoreProjectEditorEntryTab()
    },

    setScriptToolsOpen(open: boolean) {
      if (!this.workspace) return
      this.scriptToolsOpen = open
      this.settingsOpen = false
    },

    toggleScriptTools() {
      this.setScriptToolsOpen(!this.scriptToolsOpen)
    },

    setMemoWindowOpen(open: boolean) {
      if (open && !this.workspace) return
      this.memoWindowOpen = open
      if (open) this.settingsOpen = false
    },

    toggleMemoWindow() {
      this.setMemoWindowOpen(!this.memoWindowOpen)
    },

    setMemoWindowFrame(frame: MemoWindowFrame, persist = false) {
      this.settings.memoWindowFrame = normalizeMemoWindowFrame(frame)
      if (persist) void this.saveSettings()
    },

    setPanelLayoutSize(key: keyof AppSettings['panelLayout'], value: number, persist = false) {
      const limits: Record<keyof AppSettings['panelLayout'], [number, number]> = {
        conversationWidth: [420, 1040],
        explorerWidth: [160, 520],
        previewWidth: [340, 1040],
        terminalHeight: [150, 520],
      }
      const [min, max] = limits[key]
      const next = Math.min(max, Math.max(min, Math.round(value)))
      this.settings.panelLayout[key] = next
      if (persist) void this.saveSettings()
    },

    setSettingsOpen(open: boolean) {
      this.settingsOpen = open
    },

    setNewConversationDialogOpen(open: boolean) {
      this.newConversationDialogOpen = open
    },

    toggleMarkdownPreview() {
      this.markdownPreviewEnabled = !this.markdownPreviewEnabled
    },

    toggleHtmlPreview() {
      this.settings.htmlPreviewEnabled = !this.settings.htmlPreviewEnabled
      void this.saveSettings()
    },

    async openPath(path: string) {
      if (!path) return
      try {
        this.showErrorMessage('')
        await backend.openPath(path)
      } catch (error) {
        this.showErrorMessage(`无法在文件资源管理器中打开：${path}\n${formatError(error)}`)
      }
    },

    async toggleHiddenProject(root: string) {
      this.settings.hiddenProjectPaths = this.settings.hiddenProjectPaths.includes(root)
        ? this.settings.hiddenProjectPaths.filter((item) => item !== root)
        : [...this.settings.hiddenProjectPaths, root]
      await this.saveSettings()
    },

    async setProjectNickname(root: string, value: string) {
      const trimmed = value.trim()
      if (trimmed) {
        this.settings.projectNicknames[root] = trimmed
      } else {
        delete this.settings.projectNicknames[root]
      }
      await this.saveSettings()
    },

    schedulePlanDetection(sessionId: string, chunk: string) {
      // 先清洗 ANSI 再拼缓冲：Claude Code TUI 输出大量控制序列，
      // 8000 字节原始缓冲很容易被屏幕重绘码撑满而导致两头哨符装不下。
      const cleaned = stripTerminalAnsi(chunk)
      if (!cleaned) return
      const buffer = `${planMarkerBuffers.get(sessionId) ?? ''}${cleaned}`.slice(-PLAN_MARKER_BUFFER_LENGTH)
      planMarkerBuffers.set(sessionId, buffer)
      if (!buffer.includes(PLAN_MARKER_START) || !buffer.includes(PLAN_MARKER_END)) return
      const existing = planDetectionTimers.get(sessionId)
      if (existing) window.clearTimeout(existing)
      const timer = window.setTimeout(() => {
        planDetectionTimers.delete(sessionId)
        void this.detectPlanFromBuffer(sessionId)
      }, PLAN_DETECTION_DELAY_MS)
      planDetectionTimers.set(sessionId, timer)
    },

    async detectPlanFromBuffer(sessionId: string) {
      if (!isTauri()) return
      try {
        const snapshot = await backend.getTerminalBuffer(sessionId)
        const cleaned = stripTerminalAnsi(snapshot.buffer)
        const block = extractPlanBlock(cleaned)
        if (!block) {
          console.debug('[Plan] extractPlanBlock null', { bufLen: snapshot.buffer.length, cleanedLen: cleaned.length })
          return
        }
        const decisions = parsePlanDecisions(block)
        if (!decisions.length) { console.debug('[Plan] parsePlanDecisions empty'); return }
        const planId = `plan-${hashString(block)}`
        const existing = this.cliPlans[sessionId] ?? []
        if (existing.some((plan) => plan.id === planId)) return
        const proposal: PlanProposal = {
          id: planId,
          sessionId,
          decisions,
          createdAt: new Date().toISOString(),
        }
        this.cliPlans[sessionId] = [...existing, proposal]
        console.debug('[Plan] proposal added', { planId, decisions: decisions.length })
      } catch (error) {
        console.error('[Plan] detectPlanFromBuffer error', error)
        this.showErrorMessage(`Plan 解析失败：${formatError(error)}`)
      }
    },

    setPlanDecisionChoice(sessionId: string, planId: string, decisionKey: string, choice: PlanProposal['decisions'][number]['choice']) {
      const plans = this.cliPlans[sessionId]
      if (!plans) return
      const plan = plans.find((item) => item.id === planId)
      if (!plan) return
      const decision = plan.decisions.find((item) => item.key === decisionKey)
      if (decision) decision.choice = choice
    },

    setPlanDecisionChoiceNote(
      sessionId: string,
      planId: string,
      decisionKey: string,
      choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>,
      note: string,
    ) {
      const plans = this.cliPlans[sessionId]
      if (!plans) return
      const plan = plans.find((item) => item.id === planId)
      if (!plan) return
      const decision = plan.decisions.find((item) => item.key === decisionKey)
      if (!decision) return
      decision.choiceNotes = { ...(decision.choiceNotes ?? {}), [choice]: note }
    },

    dismissPlanProposal(sessionId: string, planId: string) {
      const plans = this.cliPlans[sessionId]
      if (!plans) return
      this.cliPlans[sessionId] = plans.filter((item) => item.id !== planId)
    },

    // 把 Plan 决策回执直接写入 CLI 会话；不经过 terminalDrafts 草稿框，保证一定能发出。
    async submitPlanProposal(sessionId: string, planId: string) {
      const plan = (this.cliPlans[sessionId] ?? []).find((item) => item.id === planId)
      if (!plan) return
      if (plan.decisions.some((decision) => decision.choice === 'pending')) return
      const single = plan.decisions.length === 1
      const lines = plan.decisions.map((decision, index) => {
        const label = single ? '' : `决策${index + 1}`
        const note = decision.choice === 'pending' ? '' : decision.choiceNotes?.[decision.choice]?.trim() ?? ''
        if (decision.choice === 'yes') {
          const detail = decision.yesText || decision.recommendation || decision.question
          return [`采纳${label}：${detail}`.trim(), note ? `补充：${note}` : ''].filter(Boolean).join('\n')
        }
        if (decision.choice === 'no') {
          const detail = decision.noText || '不采纳此方案'
          return [`拒绝${label}：${detail}`.trim(), note ? `补充：${note}` : ''].filter(Boolean).join('\n')
        }
        return [`跳过${label}`.trim(), note ? `补充：${note}` : ''].filter(Boolean).join('\n')
      })
      const text = `${lines.join('\n')}\n请据此继续。`
      const message: CliConversationMessage = {
        id: crypto.randomUUID(),
        sessionId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      }
      await backend.writeTerminalInput(sessionId, `${text}\r`)
      this.appendTerminalConversationMessage(message)
      const session = this.terminalSessions.find((item) => item.id === sessionId)
      this.rememberCliHistoryMessage(message, session?.cwd)
      this.setTerminalReplyPending(sessionId, true)
      plan.resolvedAt = new Date().toISOString()
      this.dismissPlanProposal(sessionId, planId)
    },

    showActivityMessage(message: string) {
      this.activityMessage = message
      if (activityMessageTimer) window.clearTimeout(activityMessageTimer)
      activityMessageTimer = message
        ? window.setTimeout(() => { this.activityMessage = ''; activityMessageTimer = null }, ACTIVITY_MESSAGE_DURATION_MS)
        : null
    },

    showErrorMessage(message: string) {
      this.errorMessage = message
      if (errorMessageTimer) window.clearTimeout(errorMessageTimer)
      errorMessageTimer = message
        ? window.setTimeout(() => { this.errorMessage = ''; errorMessageTimer = null }, ERROR_MESSAGE_DURATION_MS)
        : null
    },

    dismissActivityMessage() {
      this.activityMessage = ''
      if (activityMessageTimer) { window.clearTimeout(activityMessageTimer); activityMessageTimer = null }
    },

    dismissErrorMessage() {
      this.errorMessage = ''
      if (errorMessageTimer) { window.clearTimeout(errorMessageTimer); errorMessageTimer = null }
    },

    async persistOpenTerminalStates() {
      const tasks: Promise<void>[] = []
      if (this.workspace?.rootPath) {
        tasks.push(this.persistTerminalState(this.workspace.rootPath, this.currentTerminalStateSource()))
      }
      for (const snapshot of Object.values(this.workspaceSnapshots)) {
        tasks.push(this.persistTerminalState(snapshot.workspace.rootPath, this.snapshotTerminalStateSource(snapshot)))
      }
      await Promise.allSettled(tasks)
    },

    clearWorkspaceRuntimeTimers() {
      for (const timer of Object.values(this.workspaceFileRefreshTimers)) window.clearTimeout(timer)
      this.workspaceFileRefreshTimers = {}
      this.pendingWorkspaceFileChanges = {}

      if (this.metadataRefreshTimer) {
        window.clearTimeout(this.metadataRefreshTimer)
        this.metadataRefreshTimer = null
      }
      if (workspaceWatchSyncTimer) {
        window.clearTimeout(workspaceWatchSyncTimer)
        workspaceWatchSyncTimer = null
      }
      if (searchDebounceTimer) {
        window.clearTimeout(searchDebounceTimer)
        searchDebounceTimer = null
      }
      searchDebounceResolve?.()
      searchDebounceResolve = null
      searchRequestToken += 1

      if (activityMessageTimer) {
        window.clearTimeout(activityMessageTimer)
        activityMessageTimer = null
      }
      if (errorMessageTimer) {
        window.clearTimeout(errorMessageTimer)
        errorMessageTimer = null
      }
      for (const timer of terminalOutputFlushTimers.values()) window.clearTimeout(timer)
      terminalOutputFlushTimers.clear()
      terminalOutputBuffers.clear()
      terminalOutputBufferLengths.clear()
      terminalOutputPendingExits.clear()
      for (const timer of terminalStatePersistTimers.values()) window.clearTimeout(timer)
      terminalStatePersistTimers.clear()
      for (const timer of terminalReplyIdleTimers.values()) window.clearTimeout(timer)
      terminalReplyIdleTimers.clear()
      for (const timer of planDetectionTimers.values()) window.clearTimeout(timer)
      planDetectionTimers.clear()
      planMarkerBuffers.clear()
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot))
  import.meta.hot.dispose(() => {
    const store = useWorkspaceStore()
    store.flushPendingTerminalOutput()
    void store.persistOpenTerminalStates().catch(() => undefined)
    store.clearWorkspaceRuntimeTimers()
    store.unbindBackendEvents()
  })
}
