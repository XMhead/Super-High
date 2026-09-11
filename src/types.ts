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

export interface SkillCompletionItem {
  name: string
  description: string
  scope: 'global' | 'project'
  path: string
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
  includeText?: boolean
  fileNameOnly?: boolean
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
  isDirty: boolean
  lastKnownDiskContent?: string
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
  createdAt: string
  updatedAt: string
}

export interface MemoQuery {
  text?: string
  createdFrom?: string
  createdBefore?: string
}

export interface MemoWindowFrame {
  left: number | null
  top: number | null
  width: number
  height: number
}

export interface ItemSearchPhraseRule {
  id: string
  phrase: string
  value: string
  createdAt: string
  updatedAt: string
  history: ItemSearchPhraseHistoryEntry[]
}

export type ItemSearchPhraseHistoryAction = 'created' | 'updated'

export interface ItemSearchPhraseHistoryEntry {
  id: string
  action: ItemSearchPhraseHistoryAction
  phrase: string
  value: string
  previousPhrase?: string | null
  previousValue?: string | null
  createdAt: string
}

export interface ProjectMinecraftCapabilities {
  itemSources: ItemLibrarySource[]
  monsterLibrary: boolean
  dragonCore: boolean
}

export type ItemLibrarySource = 'ni' | 'mm'

export interface ItemLibrarySearchItem {
  source: ItemLibrarySource
  itemKey: string
  displayName?: string | null
  materialOrId?: string | null
  filePath: string
  relativePath: string
  lineNumber: number
  yamlBlock: string
  libraryRootPath: string
  dragonCoreIcon?: DragonCoreItemIcon | null
  dragonCoreEffect?: DragonCoreItemEffect | null
  dragonCoreFontImages?: DragonCoreFontImage[] | null
}

export interface DragonCoreItemIcon {
  dataUrl: string
  texture: string
  imagePath: string
  configPath: string
  relativeConfigPath: string
  lineNumber: number
}

export interface DragonCoreItemEffect {
  dataUrl: string
  texture: string
  imagePath: string
  configPath: string
  relativeConfigPath: string
  lineNumber: number
  matchText: string
}

export interface DragonCoreFontImage {
  character: string
  dataUrl: string
  path: string
  imagePath: string
  configPath: string
  relativeConfigPath: string
  lineNumber: number
  width: number
  height: number
  yOffset?: number | null
  color?: boolean | null
  fontWidth?: number | null
}


export interface ItemLibrarySearchResult {
  source: ItemLibrarySource
  libraryRootPath: string
  items: ItemLibrarySearchItem[]
  totalItems?: number
  page?: number
  pageSize?: number
  ignoredPathCount?: number
  ignoreConfigPath?: string | null
}

export interface ItemLibraryKeyResult {
  source: ItemLibrarySource
  libraryRootPath: string
  itemKeys: string[]
}

export interface MonsterLibraryAttribute {
  raw: string
  nameRaw?: string | null
  name?: string | null
  valueRaw?: string | null
}

export interface MonsterLibraryItem {
  mobKey: string
  display?: string | null
  // Health stays text so values above JavaScript's safe integer range are exact.
  health?: string | null
  attributes: MonsterLibraryAttribute[]
  filePath: string
  relativePath: string
  lineNumber: number
  yamlBlock: string
}

export interface MonsterLibrarySearchResult {
  libraryRootPath: string
  monsters: MonsterLibraryItem[]
  totalMonsters: number
  page: number
  pageSize: number
}

export interface MinecraftItemGiveResult {
  playerName: string
  itemKey: string
  amount: number
  command: string
  output: string
}

export interface MinecraftOnlinePlayersResult {
  players: string[]
  output: string
}

export interface MinecraftRconCommandResult {
  command: string
  output: string
}

export interface DragonCoreGuiOpenResult {
  playerName: string
  guiName: string
  filePath: string
  command: string
  output: string
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

export interface AppSettings {
  themeId: string
  hiddenCliProviderIds: string[]
  disabledPluginIds: string[]
  hiddenProjectPaths: string[]
  projectNicknames: Record<string, string>
  projectCategories: Record<string, string>
  quickPhrases: QuickPhrase[]
  itemSearchPhrases: ItemSearchPhraseRule[]
  dragonCoreClientRootPath: string
  activePreviewMode: 'code' | 'local_terminal'
  multiTerminalMode: boolean
  dialogueMapMode: boolean
  dialogueMapByWorkspace: Record<string, DialogueMapWorkspaceState>
  projectLayoutMode: ProjectLayoutMode
  renderColorCodes: boolean
  yamlKeyValuePanelEnabled: boolean
  htmlPreviewEnabled: boolean
  autoSave: 'off' | 'afterDelay' | 'onFocusChange'
  autoSaveDelay: number
  mobileHost: MobileHostConfig
  memoWindowFrame: MemoWindowFrame
  panelLayout: {
    conversationWidth: number
    explorerWidth: number
    previewWidth: number
    terminalHeight: number
  }
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

export interface MobileHostApiStatus {
  themeId: string
  hiddenCliProviderIds: string[]
  status: string
  appName: string
  serverTime: number
  recentProjectCount: number
  activeProjectPath?: string | null
  version?: string
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

export interface VitePressDocsInfo {
  projectPath: string
  docsRoot: string
  url: string
  port: number
  running: boolean
  startedBySuperHigh: boolean
}

export type VitePressDocStatus = 'idle' | 'detected' | 'starting' | 'running' | 'missing' | 'error'

export interface VitePressDocWorkspace extends VitePressDocsInfo {
  status: VitePressDocStatus
  error?: string
}

export type WorkspaceSurfaceKind = 'project' | 'editor' | 'docs' | 'scripts' | 'minecraft' | 'files'

export interface ScriptToolDescriptor {
  id: string
  /** Tool-level toolbox category. Missing registry values default to user. */
  type: string
  displayName: string
  tooltip: string
  sourcePath: string
  uiPath: string | null
  /** True for registry entries intended only for editor integrations. */
  hidden: boolean
}

export interface ScriptToolListResponse {
  configPath: string | null
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

export type WorkspaceTabKind = 'project' | 'docs'

export interface WorkspaceTabDescriptor {
  id: string
  kind: WorkspaceTabKind
  rootPath: string
  label: string
  title: string
  active: boolean
}

export type TerminalProviderKind = 'local' | 'minecraft-client' | 'claude' | 'codex' | 'kimi' | 'grok' | 'gemini' | 'opencode'

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
  id: string
  title: string
  providerKind: TerminalProviderKind | string
  cwd: string
  name?: string
  nativeConversationId?: string
  restoredFromDisk?: boolean
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
