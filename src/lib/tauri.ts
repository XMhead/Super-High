import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  AppSettings,
  AppStorageInfo,
  ChannelConfig,
  ChannelProbeResult,
  CliProviderEnvironment,
  EndpointLatencyResult,
  FetchedModel,
  DirectoryListing,
  FileOperationResult,
  MemoQuery,
  MemoRecord,
  MobileHostConfig,
  MobileHostStatus,
  ProjectInstructionFileKind,
  ProjectInstructionFiles,
  ProjectInstructionMigrationResult,
  ProjectStartupInfo,
  ProjectTerminalAction,
  ProjectServiceStatusEvent,
  ProjectServicesStartResult,
  ProjectSearchResult,
  ProjectSearchOptions,
  ScriptToolListResponse,
  ScriptToolRunResponse,
  RecentProject,
  RemoteConnectionConfig,
  RemoteDriveStatus,
  RemoteMapResult,
  RemoteServerCheck,
  SshConnectionConfig,
  TailscaleStatus,
  TerminalProviderKind,
  TerminalSession,
  VitePressDocsInfo,
  Workspace,
  WorkspaceFilesChangedEvent,
  WorkspaceWatchTarget,
  PluginListResponse,
  PluginShellExecRequest,
  PluginShellExecResult,
  PluginWorkspaceContext,
} from '@/types'

export interface TerminalBufferSnapshot {
  buffer: string
  startByte: number
  endByte: number
}

export interface StartupOpenTarget {
  workspacePath: string
  filePath: string | null
}

export interface TerminalOutputPayload {
  sessionId: string
  chunk: string
  startByte: number
  endByte: number
}

export interface TerminalExitPayload {
  sessionId: string
  exitCode: number | null
}

function normalizeProjectServiceStatusEvent(value: unknown): ProjectServiceStatusEvent | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  const projectPath = payload.projectPath ?? payload.project_path
  const runId = payload.runId ?? payload.run_id
  const serviceId = payload.serviceId ?? payload.service_id
  const status = payload.status
  if (typeof projectPath !== 'string' || typeof runId !== 'string' || typeof serviceId !== 'string' || typeof status !== 'string') return null
  return {
    projectPath,
    runId,
    serviceId,
    status: status as ProjectServiceStatusEvent['status'],
    session: payload.session && typeof payload.session === 'object' ? payload.session as TerminalSession : null,
    message: typeof payload.message === 'string' ? payload.message : null,
  }
}

type RawTerminalBufferSnapshot = {
  buffer?: unknown
  start_byte?: unknown
  end_byte?: unknown
  startByte?: unknown
  endByte?: unknown
} | string

type RawTerminalOutputPayload = Partial<TerminalOutputPayload> & {
  session_id?: unknown
  start_byte?: unknown
  end_byte?: unknown
}

type RawTerminalExitPayload = Partial<TerminalExitPayload> & {
  session_id?: unknown
  exit_code?: unknown
}

type RawWorkspaceFilesChangedPayload = Partial<WorkspaceFilesChangedEvent> & {
  root_path?: unknown
  changed_paths?: unknown
  affected_directories?: unknown
}

const terminalTextEncoder = new TextEncoder()

export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args)
}

function numberFromIpc(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeTerminalBufferSnapshot(value: RawTerminalBufferSnapshot): TerminalBufferSnapshot {
  if (typeof value === 'string') {
    const endByte = terminalTextEncoder.encode(value).length
    return { buffer: value, startByte: 0, endByte }
  }

  const buffer = typeof value.buffer === 'string' ? value.buffer : ''
  const bufferBytes = terminalTextEncoder.encode(buffer).length
  const endByte = numberFromIpc(value.endByte ?? value.end_byte, bufferBytes)
  const startByte = numberFromIpc(value.startByte ?? value.start_byte, Math.max(0, endByte - bufferBytes))
  return { buffer, startByte, endByte }
}

function normalizeTerminalOutputPayload(value: unknown): TerminalOutputPayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as RawTerminalOutputPayload
  const sessionIdValue = payload.sessionId ?? payload.session_id
  const chunkValue = payload.chunk
  if (typeof sessionIdValue !== 'string' || typeof chunkValue !== 'string') return null

  const startByte = numberFromIpc(payload.startByte ?? payload.start_byte, 0)
  const rawEndByte = payload.endByte ?? payload.end_byte
  const endByte = rawEndByte == null
    ? startByte + terminalTextEncoder.encode(chunkValue).length
    : numberFromIpc(rawEndByte, startByte)
  return {
    sessionId: sessionIdValue,
    chunk: chunkValue,
    startByte,
    endByte: Math.max(endByte, startByte),
  }
}

function normalizeTerminalExitPayload(value: unknown): TerminalExitPayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as RawTerminalExitPayload
  const sessionIdValue = payload.sessionId ?? payload.session_id
  if (typeof sessionIdValue !== 'string') return null
  const exitCodeValue = payload.exitCode ?? payload.exit_code
  return {
    sessionId: sessionIdValue,
    exitCode: exitCodeValue == null ? null : numberFromIpc(exitCodeValue, 0),
  }
}

function stringArrayFromIpc(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeWorkspaceFilesChangedPayload(value: unknown): WorkspaceFilesChangedEvent | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as RawWorkspaceFilesChangedPayload
  const rootPath = payload.rootPath ?? payload.root_path
  if (typeof rootPath !== 'string' || !rootPath) return null
  return {
    rootPath,
    changedPaths: stringArrayFromIpc(payload.changedPaths ?? payload.changed_paths),
    affectedDirectories: stringArrayFromIpc(payload.affectedDirectories ?? payload.affected_directories),
    kind: typeof payload.kind === 'string' ? payload.kind : 'other',
    sequence: numberFromIpc(payload.sequence, 0),
  }
}

export const backend = {
  takeStartupOpenTarget() {
    return command<StartupOpenTarget | null>('take_startup_open_target')
  },
  openProject(path?: string) {
    return command<Workspace>('open_project', { path })
  },
  listRecentProjects() {
    return command<RecentProject[]>('list_recent_projects')
  },
  removeRecentProject(path: string) {
    return command<void>('remove_recent_project_command', { path })
  },
  getSettings() {
    return command<AppSettings>('get_app_settings')
  },
  getAppStorageInfo() {
    return command<AppStorageInfo>('get_app_storage_info_command')
  },
  listPlugins(workspace?: PluginWorkspaceContext | null) {
    return invoke<PluginListResponse>('list_plugins_command', { workspace: workspace ?? null })
  },
  readPluginAsset(pluginId: string, relativePath: string, workspace?: PluginWorkspaceContext | null) {
    return invoke<string>('read_plugin_asset_command', {
      pluginId,
      relativePath,
      workspace: workspace ?? null,
    })
  },
  execPluginShell(request: PluginShellExecRequest) {
    return invoke<PluginShellExecResult>('plugin_shell_exec_command', { request })
  },
  detectVitePressDocs(projectPath: string) {
    return command<VitePressDocsInfo>('detect_vitepress_docs_command', { projectPath })
  },
  ensureVitePressDocs(projectPath: string) {
    return command<VitePressDocsInfo>('ensure_vitepress_docs_command', { projectPath })
  },
  stopVitePressDocs(projectPath: string) {
    return command<VitePressDocsInfo>('stop_vitepress_docs_command', { projectPath })
  },
  shutdownApp() {
    return command<void>('shutdown_app_command')
  },
  openSystemVoiceInput() {
    return command<void>('open_system_voice_input_command')
  },
  closeSystemVoiceInput() {
    return command<void>('close_system_voice_input_command')
  },
  saveSettings(settings: AppSettings) {
    return command<AppSettings>('save_app_settings', { settings })
  },
  probeChannel(config: ChannelConfig) {
    return command<ChannelProbeResult>('probe_channel_command', { config })
  },
  probeWebsiteLatency(config: ChannelConfig) {
    return command<EndpointLatencyResult[]>('probe_website_latency_command', { config })
  },
  fetchChannelModels(config: ChannelConfig) {
    return command<FetchedModel[]>('fetch_channel_models_command', { config })
  },
  listMemos(query: MemoQuery = {}) {
    return command<MemoRecord[]>('list_memos_command', {
      query: query.text,
      createdFrom: query.createdFrom,
      createdBefore: query.createdBefore,
    })
  },
  createMemo() {
    return command<MemoRecord>('create_memo_command')
  },
  updateMemo(id: string, title: string, content: string) {
    return command<MemoRecord>('update_memo_command', { id, title, content })
  },
  deleteMemo(id: string) {
    return command<void>('delete_memo_command', { id })
  },
  listDirectory(path: string) {
    return command<DirectoryListing>('list_directory_command', { path })
  },
  readFile(path: string) {
    return command<string>('read_file_command', { path })
  },
  readImageAsDataUrl(path: string) {
    return command<string>('read_image_as_data_url_command', { path })
  },
  readMediaAsDataUrl(path: string) {
    return command<string>('read_media_as_data_url_command', { path })
  },
  savePastedImage(projectPath: string, dataUrl: string, preferredName?: string) {
    return command<string>('save_pasted_image_command', {
      projectPath,
      dataUrl,
      preferredName,
    })
  },
  writeFile(path: string, content: string) {
    return command<void>('write_file_command', { path, content })
  },
  pickSaveFilePath(path: string) {
    return command<string | null>('pick_save_file_path_command', { path })
  },
  selectFiles(path?: string) {
    return command<string[]>('select_files_command', { path })
  },
  createFile(path: string) {
    return command<void>('create_file_command', { path })
  },
  createDirectory(path: string) {
    return command<void>('create_directory_command', { path })
  },
  renamePath(path: string, newPath: string) {
    return command<void>('rename_path_command', { path, newPath })
  },
  deletePath(path: string) {
    return command<void>('delete_path_command', { path })
  },
  copyPathsToDirectory(paths: string[], targetDirectory: string) {
    return command<FileOperationResult[]>('copy_paths_to_directory_command', { paths, targetDirectory })
  },
  movePathsToDirectory(paths: string[], targetDirectory: string) {
    return command<FileOperationResult[]>('move_paths_to_directory_command', { paths, targetDirectory })
  },
  copyFilesToClipboard(paths: string[]) {
    return command<void>('copy_files_to_clipboard_command', { paths })
  },
  replaceImageFromClipboard(path: string) {
    return command<void>('replace_image_from_clipboard_command', { path })
  },
  searchProjectFiles(query: string, roots: string[], options: ProjectSearchOptions = {}) {
    return command<ProjectSearchResult>('search_project_files_command', { query, roots, options })
  },
  listProjectScriptTools(projectPath: string) {
    return command<ScriptToolListResponse>('list_project_script_tools_command', { projectPath })
  },
  runProjectScriptTool(projectPath: string, toolId: string, values: Record<string, string>) {
    return command<ScriptToolRunResponse>('run_project_script_tool_command', { projectPath, toolId, values })
  },
  syncWorkspaceWatchRoots(rootPaths: string[]) {
    return command<void>('sync_workspace_watch_roots_command', { rootPaths })
  },
  syncWorkspaceWatchTargets(targets: WorkspaceWatchTarget[]) {
    return command<void>('sync_workspace_watch_targets_command', { targets })
  },
  discoverProjectInstructionFiles(projectPath: string) {
    return command<ProjectInstructionFiles>('discover_project_instruction_files_command', { projectPath })
  },
  migrateProjectInstructionFile(
    projectPath: string,
    sourceKind: ProjectInstructionFileKind,
    targetKind: ProjectInstructionFileKind,
  ) {
    return command<ProjectInstructionMigrationResult>('migrate_project_instruction_file_command', {
      projectPath,
      sourceKind,
      targetKind,
    })
  },
  detectCliEnvironments() {
    return command<CliProviderEnvironment[]>('detect_cli_environments_command')
  },
  defaultRemoteConfig() {
    return command<RemoteConnectionConfig>('default_remote_config_command')
  },
  remoteDriveStatus(config: RemoteConnectionConfig) {
    return command<RemoteDriveStatus>('remote_drive_status_command', { config })
  },
  mapRemoteDrive(config: RemoteConnectionConfig) {
    return command<RemoteMapResult>('map_remote_drive_command', { config })
  },
  unmapRemoteDrive(letter: string) {
    return command<RemoteMapResult>('unmap_remote_drive_command', { letter })
  },
  remoteMapScript(config: RemoteConnectionConfig) {
    return command<string>('remote_map_script_command', { config })
  },
  remoteVerifyScript(config: RemoteConnectionConfig) {
    return command<string>('remote_verify_script_command', { config })
  },
  remoteTailscaleStatus() {
    return command<TailscaleStatus>('remote_tailscale_status_command')
  },
  ensureMobileHostConfig() {
    return command<MobileHostConfig>('ensure_mobile_host_config_command')
  },
  mobileHostStatus() {
    return command<MobileHostStatus>('mobile_host_status_command')
  },
  startMobileHost(config?: MobileHostConfig) {
    return command<MobileHostStatus>('start_mobile_host_command', { config })
  },
  stopMobileHost() {
    return command<MobileHostStatus>('stop_mobile_host_command')
  },
  createTerminalSession(workspaceId: string | null, providerKind: TerminalProviderKind, cwd: string, initialPrompt?: string) {
    return command<TerminalSession>('create_terminal_session_command', {
      workspaceId,
      providerKind,
      cwd,
      initialPrompt,
    })
  },
  openExternalCli(providerKind: TerminalProviderKind, cwd: string) {
    return command<void>('open_external_cli_command', { providerKind, cwd })
  },
  getProjectStartupConfig(projectPath: string) {
    return command<ProjectStartupInfo | null>('get_project_startup_config_command', { projectPath })
  },
  getProjectTerminalActions(projectPath: string) {
    return command<ProjectTerminalAction[]>('get_project_terminal_actions_command', { projectPath })
  },
  createProjectStartupTerminalSession(workspaceId: string | null, projectPath: string) {
    return command<TerminalSession>('create_project_startup_terminal_session_command', { workspaceId, projectPath })
  },
  startProjectServices(workspaceId: string | null, projectPath: string) {
    return command<ProjectServicesStartResult>('start_project_services_command', { workspaceId, projectPath })
  },
  selectDirectory(path?: string) {
    return command<string | null>('select_directory_command', { path })
  },
  writeTerminalInput(sessionId: string, input: string) {
    return command<void>('write_terminal_input_command', { sessionId, input })
  },
  resizeTerminal(sessionId: string, cols: number, rows: number) {
    return command<void>('resize_terminal_session_command', { sessionId, cols, rows })
  },
  async getTerminalBuffer(sessionId: string) {
    const snapshot = await command<RawTerminalBufferSnapshot>('get_terminal_buffer_command', { sessionId })
    return normalizeTerminalBufferSnapshot(snapshot)
  },
  listLiveTerminalSessionIds() {
    return command<string[]>('list_live_terminal_session_ids_command')
  },
  closeTerminal(sessionId: string) {
    return command<void>('close_terminal_session_command', { sessionId })
  },
  closeTerminalSessionsForWorkspace(workspaceId: string) {
    return command<void>('close_terminal_sessions_for_workspace_command', { workspaceId })
  },
  listSshConnections() {
    return command<SshConnectionConfig[]>('list_ssh_connections_command')
  },
  saveSshConnection(config: SshConnectionConfig) {
    return command<void>('save_ssh_connection_command', { config })
  },
  deleteSshConnection(id: string) {
    return command<void>('delete_ssh_connection_command', { id })
  },
  createSshTerminalSession(workspaceId: string | null, connectionId: string, cwd: string) {
    return command<TerminalSession>('create_ssh_terminal_session_command', {
      workspaceId,
      connectionId,
      cwd,
    })
  },
  openPath(path: string) {
    return command<void>('open_path_command', { path })
  },
  openUrl(url: string) {
    return command<void>('open_url_command', { url })
  },
}

export function onTerminalOutput(handler: (event: TerminalOutputPayload) => void): Promise<UnlistenFn> {
  return listen('terminal-output', (event) => {
    const payload = normalizeTerminalOutputPayload(event.payload)
    if (payload) handler(payload)
  })
}

export function onTerminalExit(handler: (event: TerminalExitPayload) => void): Promise<UnlistenFn> {
  return listen('terminal-exit', (event) => {
    const payload = normalizeTerminalExitPayload(event.payload)
    if (payload) handler(payload)
  })
}

export function onProjectServiceStatus(handler: (event: ProjectServiceStatusEvent) => void): Promise<UnlistenFn> {
  return listen('project-service-status', (event) => {
    const payload = normalizeProjectServiceStatusEvent(event.payload)
    if (payload) handler(payload)
  })
}

export function onWorkspaceFilesChanged(handler: (event: WorkspaceFilesChangedEvent) => void): Promise<UnlistenFn> {
  return listen('workspace-files-changed', (event) => {
    const payload = normalizeWorkspaceFilesChangedPayload(event.payload)
    if (payload) handler(payload)
  })
}
