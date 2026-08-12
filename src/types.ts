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

export type ProjectTerminalActionKind = 'start-project' | 'restart-project'

export interface ProjectTerminalAction {
  id: string
  label: string
  kind: ProjectTerminalActionKind
  tooltip?: string | null
  serviceId?: string | null
  input?: string | null
  startAfterCommand: boolean
  restartDelayMs: number
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
  contentType: 'text' | 'image' | 'unsupported'
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

export type ProjectLayoutMode = 'default' | 'swapped'

export type ChannelProviderKind = 'claude' | 'codex'

/**
 * 渠道上游 API 格式（与 cc-switch 的 apiFormat 对应）：
 * - anthropic：Anthropic Messages（Claude Code 原生）→ /v1/messages，请求体 messages[]，鉴权 x-api-key
 * - openai_responses：OpenAI Responses（Codex 原生）→ /v1/responses，请求体 input，鉴权 Bearer
 * - openai_chat：OpenAI Chat Completions（兼容格式）→ /v1/chat/completions，请求体 messages[]，鉴权 Bearer
 */
export type ChannelApiFormat = 'anthropic' | 'openai_responses' | 'openai_chat'

export interface ChannelConfig {
  id: string
  name: string
  provider: ChannelProviderKind
  websiteUrl: string
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: ChannelApiFormat
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

export interface AppSettings {
  themeId: string
  disabledPluginIds: string[]
  hiddenProjectPaths: string[]
  projectNicknames: Record<string, string>
  projectCategories: Record<string, string>
  quickPhrases: QuickPhrase[]
  activePreviewMode: 'code' | 'local_terminal'
  projectLayoutMode: ProjectLayoutMode
  renderColorCodes: boolean
  htmlPreviewEnabled: boolean
  autoSave: 'off' | 'afterDelay' | 'onFocusChange'
  autoSaveDelay: number
  mobileHost: MobileHostConfig
  memoWindowFrame: MemoWindowFrame
  channels: ChannelConfig[]
  panelLayout: {
    conversationWidth: number
    explorerWidth: number
    previewWidth: number
    terminalHeight: number
  }
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
  status: string
  appName: string
  serverTime: number
  recentProjectCount: number
}

export interface RemoteConnectionConfig {
  remoteHost: string
  shareName: string
  localDriveLetter: string
  remoteRoot: string
  username: string
}

export interface RemoteServerCheck {
  id: string
  label: string
  ok: boolean
  detail: string
  severity: 'ok' | 'warn' | 'error' | string
}

export interface RemoteDriveStatus {
  config: RemoteConnectionConfig
  tailscaleAvailable: boolean
  driveMapped: boolean
  uncPath: string
  localPath: string
  workspaceRoot: string
  checks: RemoteServerCheck[]
}

export interface RemoteMapResult {
  success: boolean
  driveLetter: string
  uncPath: string
  error: string | null
}

export interface TailscaleStatus {
  available: boolean
  ip: string | null
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

export interface WorkflowRefs {
  docs?: string[]
  files?: string[]
}

export type WorkspaceSurfaceKind = 'project' | 'editor' | 'docs' | 'scripts' | 'files' | 'channels'

export interface ScriptToolDescriptor {
  id: string
  displayName: string
  tooltip: string
  sourcePath: string
  uiPath: string | null
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

export type WorkspaceTabKind = 'project' | 'docs'

export interface WorkspaceTabDescriptor {
  id: string
  kind: WorkspaceTabKind
  rootPath: string
  label: string
  title: string
  active: boolean
}

export type TerminalProviderKind = 'local' | 'claude' | 'codex' | 'kimi' | 'grok' | 'gemini' | 'opencode' | 'ssh'

export interface SshConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  extraArgs: string
  createdAt: string
  updatedAt: string
}

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
  restoredFromDisk?: boolean
}

export interface CliConversationMessage {
  id: string
  sessionId: string
  role: 'user' | 'system'
  content: string
  timestamp: string
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
