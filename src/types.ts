import type { FontAsset, FontStylePack } from '@/lib/fontStyles'
import type { MarkdownHeadingColors } from '@/lib/markdownHeadingColors'

export interface ThemeTokens {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: {
    bg: {
      primary: string
      secondary: string
      tertiary: string
      hover: string
    }
    text: {
      primary: string
      secondary: string
      muted: string
    }
    accent: {
      blue: string
      green: string
      yellow: string
      red: string
      purple: string
    }
    border: string
    inputBg: string
  }
  /** Optional editor token colors; themes without it derive syntax colors from accents. */
  syntax?: {
    comment: string
    string: string
    keyword: string
    function: string
    type: string
    number: string
  }
  terminal: {
    background: string
    foreground: string
    cursor: string
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }
  surfaceOpacity?: number
  /** Optional signature visuals: ambient backdrop, gradient accents and motion, scoped by `data-theme-fx`. */
  effects?: {
    gradient: [string, string, string]
  }
}

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: string
}

export interface Workspace {
  id: string
  name: string
  displayName: string
  rootPath: string
  openedAt: string
}

export interface ProjectStartupInfo {
  name: string
  mode?: 'single' | 'services'
  scriptPath?: string | null
  workingDirectory?: string | null
  services?: ProjectStartupServiceInfo[]
}

export interface ProjectStartupServiceInfo {
  id: string
  name: string
  scriptPath?: string | null
  commandPath?: string | null
  args: string[]
  workingDirectory: string
  startAfter: string[]
  healthCheck?: ProjectServiceHealthCheckInfo | null
}

export interface ProjectServiceHealthCheckInfo {
  kind: 'tcp'
  host: string
  port: number
  timeoutMs: number
}

export type ProjectTerminalActionKind = 'start-project' | 'restart-project' | 'minecraft-client'

export type ProjectMinecraftClientActionOperation = 'start' | 'stop' | 'restart' | 'release' | 'status'

export interface ProjectTerminalAction {
  id: string
  label: string
  kind: ProjectTerminalActionKind
  tooltip?: string | null
  serviceId?: string | null
  input?: string | null
  startAfterCommand: boolean
  restartDelayMs: number
  operation?: ProjectMinecraftClientActionOperation | null
}

export type ProjectServiceStatus = 'pending' | 'starting' | 'running' | 'externalRunning' | 'failed' | 'exited'

export interface ProjectServiceRunServiceState {
  serviceId: string
  status: ProjectServiceStatus
  sessionId: string | null
  message?: string | null
}

export interface ProjectServiceRunState {
  projectPath: string
  runId: string
  chainStatus: 'idle' | 'starting' | 'running' | 'failed' | 'partial'
  services: Record<string, ProjectServiceRunServiceState>
}

export interface ProjectServiceStatusEvent {
  projectPath: string
  runId: string
  serviceId: string
  status: ProjectServiceStatus
  session: TerminalSession | null
  message: string | null
}

export interface ProjectServicesStartResult {
  projectPath: string
  runId: string
  services: Array<{
    serviceId: string
    status: ProjectServiceStatus
    session: TerminalSession | null
    message: string | null
  }>
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  extension?: string
  size?: number
  modified?: number
  isHidden?: boolean
}

export interface DirectoryListing {
  path: string
  entries: FileEntry[]
}

export type SkillScopeOrder = 'globalFirst' | 'globalLast'

export interface SkillCompletionItem {
  name: string
  description: string
  scope: 'global' | 'project'
  path: string
  /** 注册指令使用注册表路径和稳定 ID；普通 Skill 不包含这两个字段。 */
  commandId?: string
  content?: string
}

/** Skill 概览：描述行常驻会话上下文，正文仅在调用时加载；token 为本地估算值。 */
export interface SkillOverviewItem {
  name: string
  description: string
  scope: 'global' | 'project'
  path: string
  body: string
  descriptionTokens: number
  bodyTokens: number
}

export interface FileOperationResult {
  sourcePath: string
  targetPath?: string | null
  ok: boolean
  error?: string | null
}

export interface ProjectFileMatch {
  path: string
  relativePath: string
  name: string
  modified?: number | null
}

export interface TextSearchMatch {
  path: string
  relativePath: string
  lineNumber: number
  column: number
  preview: string
}

export interface ProjectSearchResult {
  files: ProjectFileMatch[]
  textMatches: TextSearchMatch[]
}

export interface ProjectSearchOptions {
  sortMode?: SearchSortMode
  openCounts?: Record<string, number>
  includeText?: boolean
  includeFiles?: boolean
  buffers?: { path: string; content: string }[]
  fileNameOnly?: boolean
  fullContentLines?: boolean
  contentRegex?: boolean
  preserveWhitespace?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  includeFilter?: string
  limit?: number
}

export interface WorkspaceFilesChangedEvent {
  rootPath: string
  changedPaths: string[]
  affectedDirectories: string[]
  kind: 'create' | 'remove' | 'modify' | 'rename' | 'other' | string
  sequence: number
}

export interface WorkspaceWatchTarget {
  rootPath: string
  directories: string[]
}

export interface EditorTab {
  id: string
  path: string
  name: string
  content: string
  contentType: 'text' | 'image' | 'office' | 'media' | 'unsupported'
  language: string
  encoding?: string
  isDirty: boolean
  lastKnownDiskContent?: string
  changePreview?: {
    requestId: string
    showingDiff: boolean
    sourceOnly?: boolean
    loading: boolean
    oldText: string
    newText: string
    reason: string
    error: string
  }
}

export type ProjectInstructionFileKind = 'agents' | 'claude'

export interface ProjectInstructionFileStatus {
  kind: ProjectInstructionFileKind
  fileName: string
  filePath: string
  exists: boolean
  sizeBytes: number
  lineCount: number
  modified?: number | null
}

export interface ProjectInstructionFiles {
  projectPath: string
  files: ProjectInstructionFileStatus[]
}

export interface ProjectInstructionMigrationResult {
  sourceKind: ProjectInstructionFileKind
  targetKind: ProjectInstructionFileKind
  sourcePath: string
  targetPath: string
  copied: boolean
  skipped: boolean
  overwritten: boolean
  backupPath?: string | null
  bytes: number
}

export interface QuickPhrase {
  id: string
  title: string
  text: string
  createdAt: string
}

export interface MemoRecord {
  id: string
  title: string
  content: string
  attachments: string[]
  category?: string
  createdAt: string
  updatedAt: string
}

export interface MemoSummary {
  id: string
  title: string
  contentPreview: string
  category?: string
  createdAt: string
  updatedAt: string
}

export interface MemoCursor { createdAt: string; id: string }
export interface MemoPage {
  items: MemoSummary[]
  previousCursor: MemoCursor | null
  nextCursor: MemoCursor | null
}

export interface MemoQuery {
  text?: string
  category?: string
  createdFrom?: string
  createdBefore?: string
}

export interface MemoWindowFrame {
  left: number | null
  top: number | null
  width: number
  height: number
}

export type ProjectLayoutMode = 'default' | 'swapped'

export type ChannelProviderKind = 'claude' | 'codex' | 'gemini' | 'grok' | 'opencode'

/**
 * 渠道上游 API 格式（与 cc-switch 的 apiFormat 对应）：
 * - anthropic：Anthropic Messages（Claude Code 原生）→ /v1/messages，请求体 messages[]，鉴权 x-api-key
 * - openai_responses：OpenAI Responses（Codex 原生）→ /v1/responses，请求体 input，鉴权 Bearer
 * - openai_chat：OpenAI Chat Completions（兼容格式）→ /v1/chat/completions，请求体 messages[]，鉴权 Bearer
 * - gemini_native：Gemini generateContent → /v1beta/models/{model}:generateContent，请求体 contents[]，鉴权 x-goog-api-key
 */
export type ChannelApiFormat = 'anthropic' | 'openai_responses' | 'openai_chat' | 'gemini_native'

export interface ChannelConfig {
  id: string
  name: string
  provider: ChannelProviderKind
  websiteUrl: string
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: ChannelApiFormat
  /** 鉴权头风格（对齐 cc-switch）：AUTH_TOKEN→Bearer、ANTHROPIC_API_KEY→x-api-key、Gemini→x-goog-api-key；codex/grok 走 Bearer。 */
  apiKeyAuth?: 'bearer' | 'x-api-key' | 'x-goog-api-key'
}

export interface ChannelProbeResult {
  ok: boolean
  latencyMs: number
  endpoint: string
  reply: string
  error: string
  status: number
}

export interface EndpointLatencyResult {
  url: string
  label: string
  latencyMs: number | null
  status: number | null
  error: string | null
}

export interface FetchedModel {
  id: string
  ownedBy: string | null
}

/** cc-switch 供应商（渠道检测面板数据源；来自 ~/.cc-switch/cc-switch.db）。 */
export interface CcProviderInfo {
  /** 所属应用：claude | codex | gemini | grokbuild | opencode。 */
  app: 'claude' | 'codex' | 'gemini' | 'grokbuild' | 'opencode'
  id: string
  name: string
  websiteUrl: string
  baseUrl: string
  apiKey: string
  apiFormat: ChannelApiFormat
  apiKeyAuth: 'bearer' | 'x-api-key' | 'x-goog-api-key'
  model: string
  /** 配置里声明的静态模型候选（opencode 的 models 键；其余为空）。 */
  models: CcProviderModel[]
  category: string
  isCurrent: boolean
}

export interface CcProviderModel {
  id: string
  name: string
}

/** cc-switch 项目分组（profiles 表）：分组 → 各应用槽位绑定的供应商 id。 */
export interface CcProfileInfo {
  id: string
  name: string
  claudeProvider: string | null
  codexProvider: string | null
}

export interface CcProfilesResponse {
  profiles: CcProfileInfo[]
  currentClaude: string | null
  currentCodex: string | null
}

/** cc-switch 用量：某个本地日期下某个模型的合计，输入已归一为新增输入。 */
export interface UsageDailyModelRow {
  date: string
  model: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface UsageStatsResponse {
  available: boolean
  daily: UsageDailyModelRow[]
  longestSessionMs: number
  error: string | null
}

export interface ScriptUsageDailyRow {
  date: string
  /** `<skill>/<skill 内路径>`。 */
  script: string
  count: number
}

/** 只统计 Agent Skill 自带的 `<skill>/scripts/**` 脚本。 */
export interface ScriptUsageEntry {
  skill: string
  /** project / global：当前工作区可见；other：不在可见范围但调用过。 */
  scope: 'project' | 'global' | 'other'
  skillDir: string
  /** skill 内相对路径，如 `scripts/tool.py`。 */
  script: string
  path: string
  count: number
  recent30d: number
  /** 0 表示从未调用。 */
  lastUsedMs: number
  idleDays: number | null
  exists: boolean
  /** 文件名出现在 SKILL.md 或 references/ 中。 */
  documented: boolean
  /** 同 skill 内引用了它的其它脚本，仅对未调用的脚本计算。 */
  referencedBy?: string[]
  /** claude / codex / superhigh 各自的次数。 */
  sources: Record<string, number>
}

export interface ScriptUsageResponse {
  workspace: string
  daily: ScriptUsageDailyRow[]
  scripts: ScriptUsageEntry[]
  error: string | null
}

export type SearchSortMode = 'default' | 'newest' | 'oldest' | 'mostOpened'

export interface AppSettings {
  searchSortMode?: SearchSortMode
  fileOpenCountsByWorkspace?: Record<string, Record<string, number>>
  themeId: string
  fontStyleId: string
  customFonts?: FontAsset[]
  customFontStyles?: FontStylePack[]
  customThemes?: ThemeTokens[]
  hiddenCliProviderIds: string[]
  disabledPluginIds: string[]
  hiddenProjectPaths: string[]
  projectNicknames: Record<string, string>
  projectCategories: Record<string, string>
  quickPhrases: QuickPhrase[]
  activePreviewMode: 'code' | 'local_terminal'
  multiTerminalMode: boolean
  cliViewMode?: 'chat' | 'work' | ''
  dialogueMapMode: boolean
  dialogueMapByWorkspace: Record<string, DialogueMapWorkspaceState>
  projectLayoutMode: ProjectLayoutMode
  conversationSidebarVisible: boolean
  activityBarVisible: boolean
  explorerVisible: boolean
  externalCmdMaximized: boolean
  scrollSpeedPercent: number
  renderColorCodes: boolean
  markdownHeadingColors: MarkdownHeadingColors
  markdownHeadingColorsEnabled: boolean
  yamlKeyValuePanelEnabled: boolean
  yamlKeyValueCodexColors: boolean
  petAutoExpand: boolean
  htmlPreviewEnabled: boolean
  autoSave: 'off' | 'afterDelay' | 'onFocusChange'
  agentCliCommandTranslation?: boolean
  skillScopeOrder: SkillScopeOrder
  autoSaveDelay: number
  mobileHost: MobileHostConfig
  memoWindowFrame: MemoWindowFrame
  memoLastCategory: string
  memoLastSelectedId: string
  scriptToolSelections: Record<string, { filter: 'all' | 'global' | 'project'; toolId: string }>
  panelLayout: {
    conversationWidth: number
    explorerWidth: number
    previewWidth: number
    terminalHeight: number
  }
}

export interface ImportRecycleNotice {
  path: string
  name: string
}

export interface DialogueMapViewport {
  x: number
  y: number
  zoom: number
}

export interface DialogueMapPosition {
  x: number
  y: number
}

export interface DialogueMapWorkspaceState {
  viewport: DialogueMapViewport
  positions: Record<string, DialogueMapPosition>
}

export interface MobileHostConfig {
  port: number
  token: string
}

export interface MobileHostStatus {
  running: boolean
  bind: string
  port: number
  token: string
  urls: string[]
}

export interface MobileCliNotice {
  seq: number
  title: string
  provider: string
  workspace: string
  body: string
  durationMs?: number | null
  plan: boolean
}

export interface MobileHostApiStatus {
  themeId: string
  fontStyleId?: string
  hiddenCliProviderIds: string[]
  markdownHeadingColors?: MarkdownHeadingColors
  markdownHeadingColorsEnabled?: boolean
  status: string
  appName: string
  serverTime: number
  recentProjectCount: number
  activeProjectPath?: string | null
  viewState?: MobileViewState
  workspaceHosts?: { path: string; port: number }[]
  version?: string
}

export interface MobileViewState {
  filePath: string | null
  htmlPreviewEnabled: boolean
  revision: number
}

export interface AppStorageInfo {
  dataDir: string
  databasePath: string
  databaseSizeBytes: number
  superHighRoot: string
  globalLibraryRoot: string
  globalPluginsDir: string
  pluginLogPath: string
  pluginDisableFlagPath: string
}


export type PluginRuntimeStatus = 'matched' | 'notMatched' | 'disabled' | 'manifestError' | 'loaded' | 'failed'
export type PluginSource = 'global' | 'project'

export interface PluginWorkspaceContext {
  name: string
  displayName: string
  rootPath: string
}

export interface PluginEnvironment {
  pluginRoot: string
  projectPluginRoot?: string | null
  disableFlagPath: string
  logPath: string
  allDisabled: boolean
  disabledReason?: string | null
}

export interface PluginDescriptor {
  id: string
  name: string
  version: string
  rootPath: string
  main: string
  mainPath: string
  style?: string | null
  stylePath?: string | null
  source: PluginSource
  permissions: string[]
  unsafe: boolean
  status: PluginRuntimeStatus
  matchReason?: string | null
  disabledReason?: string | null
  error?: string | null
}

export interface PluginListResponse {
  environment: PluginEnvironment
  plugins: PluginDescriptor[]
}

export interface PluginShellExecRequest {
  command: string
  cwd?: string | null
  env?: Record<string, string>
  timeoutMs?: number | null
}

export interface PluginShellExecResult {
  command: string
  cwd?: string | null
  exitCode?: number | null
  stdout: string
  stderr: string
}

export interface PluginCommandContribution {
  id: string
  pluginId: string
  title: string
  tooltip?: string
}

export type WorkspaceSurfaceKind = 'project' | 'scripts' | 'minecraft' | 'files' | 'git'

export interface ScriptToolDescriptor {
  scope?: 'global' | 'project'
  registryPath?: string
  basePath?: string
  sourceAbsolutePath?: string
  uiAbsolutePath?: string | null
  id: string
  title?: string
  description?: string
  runtime?: string
  kind?: 'query' | 'maintenance'
  parameters?: { id: string; description: string; flag: string; position: number | null; literal: string | null; required: boolean; type: string }[]
  output?: { format: 'json' | 'text' | 'markdown'; description: string; schema: Record<string, unknown> | null; example: unknown } | null
  examples?: Record<string, string>[]
  displayName: string
  tooltip: string
  sourcePath: string
  uiPath: string | null
  /** True for registry entries intended only for editor integrations. */
  hidden: boolean
}

export interface ScriptToolListResponse {
  configPath: string | null
  globalConfigPath?: string | null
  directories: string[]
  tools: ScriptToolDescriptor[]
}

export interface ScriptToolRunResponse {
  toolId: string
  title: string
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface MinecraftClientConfig {
  projectPath: string
  configPath: string
  displayName: string
  clientRoot: string
  launcherPath: string
  embedTarget: string
  windowTitleIncludes: string[]
  processNames: string[]
  startupTimeoutMs: number
}

export interface MinecraftClientStatus {
  state: string
  message: string
  config: MinecraftClientConfig | null
  windowTitle: string | null
  processId: number | null
  embedded: boolean
}

export interface MinecraftClientTerminalStartResult {
  status: MinecraftClientStatus
  session: TerminalSession | null
}

export interface MinecraftEmbedRect {
  x: number
  y: number
  width: number
  height: number
}

export type WorkspaceTabKind = 'project'

export interface WorkspaceTabDescriptor {
  id: string
  kind: WorkspaceTabKind
  rootPath: string
  label: string
  title: string
  active: boolean
}

export type TerminalProviderKind = 'local' | 'minecraft-client' | 'claude' | 'codex' | 'kimi' | 'grok' | 'gemini' | 'opencode' | 'codebuddy'

export interface CliProviderEnvironment {
  providerKind: Exclude<TerminalProviderKind, 'local'>
  name: string
  command: string
  available: boolean
  resolvedPath?: string | null
  launcher: string
  source?: string | null
  issue?: string | null
  checkedLocations: string[]
}

export interface TerminalSession {
  readOnly?: boolean
  id: string
  title: string
  providerKind: TerminalProviderKind | string
  cwd: string
  name?: string
  terminalTitle?: string
  nativeConversationId?: string
}

export interface CliNativeConversationSummary {
  id: string
  providerKind: TerminalProviderKind | string
  nativeSessionId: string | null
  title: string
  summary: string
  cwd: string
  createdAt: string
  updatedAt: string
  messageCount: number
  sourcePath: string
  resumeSupported: boolean
}

export interface CliNativeConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface CliNativeConversationDetail extends CliNativeConversationSummary {
  messages: CliNativeConversationMessage[]
}

export interface CliConversationMessage {
  id: string
  sessionId: string
  role: 'user' | 'system'
  content: string
  timestamp: string
}

export interface CliHistoryPathCandidate {
  path: string
  count: number
  lastIndex: number
}

export interface CliHistorySnapshot {
  messages: CliConversationMessage[]
  paths: CliHistoryPathCandidate[]
  scannedFiles: number
  indexedFiles: number
  indexedMessages: number
}

export type PlanDecisionChoice = 'pending' | 'yes' | 'no' | 'skip'

export interface PlanDecision {
  key: string
  title: string
  question: string
  yesText: string
  noText: string
  recommendation: string
  recommendedChoice?: Exclude<PlanDecisionChoice, 'pending'> | null
  choice: PlanDecisionChoice
  choiceNotes?: Partial<Record<Exclude<PlanDecisionChoice, 'pending'>, string>>
}

export interface PlanProposal {
  id: string
  sessionId: string
  decisions: PlanDecision[]
  createdAt: string
  resolvedAt?: string
}

export interface GitStatusFile {
  path: string
  oldPath: string | null
  status: string
  indexStatus: string
  worktreeStatus: string
  untracked: boolean
  additions: number | null
  deletions: number | null
}

export interface GitStatus {
  repoRoot: string
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitStatusFile[]
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  email: string
  timestamp: number
  subject: string
  refs: string
  parents: string[]
}

export interface GitCommitFile {
  path: string
  oldPath: string | null
  status: string
  additions: number | null
  deletions: number | null
}

export interface GitCommitDetail {
  commit: GitCommit
  body: string
  files: GitCommitFile[]
}

export interface GitFileDiff {
  path: string
  oldText: string
  newText: string
  binary: boolean
  truncated: boolean
  tooLarge: boolean
}

export interface GitHubAccountStatus {
  installed: boolean
  authenticated: boolean
  login: string | null
  host: string
  tokenSource: string | null
  homeDirectory: string | null
  error: string | null
}

export interface GitHubRepoSummary {
  nameWithOwner: string
  description: string | null
  isPrivate: boolean
  isFork: boolean
  isArchived: boolean
  isEmpty: boolean
  pushedAt: string | null
}

export interface GitReplayStatus {
  installed: boolean
  programPath: string | null
  installCommand: string
}

export interface GitReplayTarget {
  repoPath: string
  source: 'workspace' | 'cache'
  nameWithOwner: string | null
}

export type GitReplayOrder = 'asc' | 'desc' | 'random'

export interface GitReplayOptions {
  order: GitReplayOrder
  speed: number
  author: string | null
}
