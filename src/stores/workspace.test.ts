import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliNativeConversationSummary, DirectoryListing, EditorTab, MinecraftClientConfig, PlanProposal, Workspace } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => vi.fn()),
  isTauri: vi.fn(),
  onTerminalExit: vi.fn(async (_handler: (event: { sessionId: string; exitCode: number | null }) => void) => vi.fn()),
  searchProjectFiles: vi.fn(),
  takeStartupOpenTarget: vi.fn(),
  getSettings: vi.fn(),
  writeFile: vi.fn(),
  writeEditorFile: vi.fn(async () => undefined),
  createDirectory: vi.fn(),
  deletePath: vi.fn(),
  listDirectory: vi.fn(),
  closeTerminal: vi.fn(),
  closeTerminalSessionsForWorkspace: vi.fn(),
  writeTerminalInput: vi.fn(),
  getTerminalBuffer: vi.fn(),
  listLiveTerminalSessionIds: vi.fn(),
  syncWorkspaceWatchRoots: vi.fn(),
  syncWorkspaceWatchTargets: vi.fn(),
  openProject: vi.fn(),
  openPath: vi.fn(),
  readFile: vi.fn(),
  readEditorFile: vi.fn(async (path: string, encoding?: string) => ({ content: await mocks.readFile(path), encoding: encoding ?? 'utf-8' })),
  isFile: vi.fn(),
  readMediaAsDataUrl: vi.fn(),
  readImageAsDataUrl: vi.fn(),
  readOfficeFileBase64: vi.fn(),
  saveSettings: vi.fn(),
  listRecentProjects: vi.fn(),
  detectVitePressDocs: vi.fn(),
  createTerminalSession: vi.fn(),
  createProjectStartupTerminalSession: vi.fn(),
  startProjectServices: vi.fn(),
  startMinecraftClient: vi.fn(),
  stopMinecraftClient: vi.fn(),
  listWorkspaceCliConversations: vi.fn(),
  readWorkspaceCliConversation: vi.fn(),
  resumeCliConversation: vi.fn(),
  loadCliHistory: vi.fn(),
  refreshCliHistory: vi.fn(),
  recordCliHistoryMessage: vi.fn(),
  ensureVitePressDocs: vi.fn(),
  getMinecraftClientConfig: vi.fn(),
  updateMobileHostConfig: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    searchProjectFiles: mocks.searchProjectFiles,
    takeStartupOpenTarget: mocks.takeStartupOpenTarget,
    getSettings: mocks.getSettings,
    writeFile: mocks.writeFile,
    writeEditorFile: mocks.writeEditorFile,
    createDirectory: mocks.createDirectory,
    deletePath: mocks.deletePath,
    listDirectory: mocks.listDirectory,
    closeTerminal: mocks.closeTerminal,
    closeTerminalSessionsForWorkspace: mocks.closeTerminalSessionsForWorkspace,
    writeTerminalInput: mocks.writeTerminalInput,
    getTerminalBuffer: mocks.getTerminalBuffer,
    listLiveTerminalSessionIds: mocks.listLiveTerminalSessionIds,
    syncWorkspaceWatchRoots: mocks.syncWorkspaceWatchRoots,
    syncWorkspaceWatchTargets: mocks.syncWorkspaceWatchTargets,
    openProject: mocks.openProject,
    openPath: mocks.openPath,
    readFile: mocks.readFile,
    readEditorFile: mocks.readEditorFile,
    isFile: mocks.isFile,
    readMediaAsDataUrl: mocks.readMediaAsDataUrl,
    readImageAsDataUrl: mocks.readImageAsDataUrl,
    readOfficeFileBase64: mocks.readOfficeFileBase64,
    saveSettings: mocks.saveSettings,
    listRecentProjects: mocks.listRecentProjects,
    detectVitePressDocs: mocks.detectVitePressDocs,
    createTerminalSession: mocks.createTerminalSession,
    createProjectStartupTerminalSession: mocks.createProjectStartupTerminalSession,
    startProjectServices: mocks.startProjectServices,
    startMinecraftClient: mocks.startMinecraftClient,
    stopMinecraftClient: mocks.stopMinecraftClient,
    listWorkspaceCliConversations: mocks.listWorkspaceCliConversations,
    readWorkspaceCliConversation: mocks.readWorkspaceCliConversation,
    resumeCliConversation: mocks.resumeCliConversation,
    loadCliHistory: mocks.loadCliHistory,
    refreshCliHistory: mocks.refreshCliHistory,
    recordCliHistoryMessage: mocks.recordCliHistoryMessage,
    ensureVitePressDocs: mocks.ensureVitePressDocs,
    getMinecraftClientConfig: mocks.getMinecraftClientConfig,
    updateMobileHostConfig: mocks.updateMobileHostConfig,
  },
  isTauri: mocks.isTauri,
  onTerminalExit: mocks.onTerminalExit,
  onTerminalOutput: vi.fn(async () => vi.fn()),
  onWorkspaceFilesChanged: vi.fn(async () => vi.fn()),
  onProjectServiceStatus: vi.fn(async () => vi.fn()),
}))

describe('mobile Host token updates', () => {
  it('publishes only the token accepted by the running Host and preserves the previous token on failure', async () => {
    setActivePinia(createPinia())
    mocks.isTauri.mockReturnValue(true)
    const store = useWorkspaceStore()
    store.mobileHostConfig = { port: 10320, token: 'old-token' }
    store.settings.mobileHost = { ...store.mobileHostConfig }
    mocks.updateMobileHostConfig.mockResolvedValue({ running: true, port: 10320, token: 'new-token', urls: [] })
    await store.updateMobileHostConfig({ token: 'new-token' })
    expect(mocks.updateMobileHostConfig).toHaveBeenCalledWith({ port: 10320, token: 'new-token' })
    expect(store.mobileHostStatus?.token).toBe('new-token')
    expect(store.settings.mobileHost.token).toBe('new-token')
    mocks.updateMobileHostConfig.mockRejectedValueOnce(new Error('Host refused'))
    await store.updateMobileHostConfig({ token: 'failed-token' })
    expect(store.mobileHostConfig.token).toBe('new-token')
    expect(store.mobileHostStatus?.token).toBe('new-token')
    vi.restoreAllMocks()
  })
})

describe('project editor configuration binding', () => {
  it('keeps the page during tree selection and saved-content sync, but permits explicit code navigation', async () => {
    setActivePinia(createPinia())
    const store = useWorkspaceStore()
    const origin = 'D:/Project/.superhigh/editor/items.html'
    const first = 'D:/Project/Items/a.yml'
    const second = 'D:/Project/Items/b.yml'
    const outside = 'D:/Project/other.yml'
    store.workspace = { rootPath: 'D:/Project' } as Workspace
    store.tabs = [origin, first, second, outside].map((path, index) => ({
      id: String(index), path, name: path.split('/').at(-1)!, content: index === 1 ? 'draft: true' : 'saved: true',
      contentType: 'text', language: 'yaml', isDirty: index === 1,
    }))
    store.activeTabId = '0'
    vi.spyOn(store, 'recordFileOpen').mockImplementation(() => undefined)
    vi.spyOn(store, 'revealPathInExplorer').mockResolvedValue(undefined as any)
    vi.spyOn(store, 'saveSettings').mockResolvedValue(undefined as any)
    expect(await store.bindScopedCodePreview(first, 'D:/Project/Items', origin)).toBe(true)
    expect(store.activeTabId).toBe('0')
    expect(store.tabs[1]!.content).toBe('draft: true')
    expect(await store.openFile(second, { bindToActiveEditor: true })).toBe(true)
    expect(store.activeTabId).toBe('0')
    expect(store.projectEditorBindings[origin.toLowerCase()]?.path).toBe(second)
    expect(store.setScopedCodePreviewContent(second, 'updated: true', { isDirty: false, keepActiveTab: true })).toBe(true)
    expect(store.activeTabId).toBe('0')
    expect(store.tabs[2]!.lastKnownDiskContent).toBe('updated: true')
    expect(await store.openScopedCodePreview(second, 'D:/Project/Items', { originPath: origin })).toBe(true)
    expect(store.activeTabId).toBe('2')
    store.activeTabId = '0'
    expect(await store.openFile(outside, { bindToActiveEditor: true })).toBe(true)
    expect(store.activeTabId).toBe('3')
    expect(await store.bindScopedCodePreview(outside, 'D:/Project/Items', origin)).toBe(false)
    vi.restoreAllMocks()
  })
})

describe('file search preferences', () => {
  it('persists workspace counts and sorting without counting tab focus or encoding reload', async () => {
    setActivePinia(createPinia())
    mocks.isTauri.mockReturnValue(false)
    mocks.readFile.mockResolvedValue('content')
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    const store = useWorkspaceStore()
    store.workspace = { id: 'one', name: 'One', displayName: 'One', rootPath: 'D:/One', openedAt: '' }
    await store.openFile('D:/One/file.txt', { revealInExplorer: false, skipWorkspaceWatchSync: true })
    store.activeTabId = store.tabs[0].id
    expect(store.fileOpenCount('d:/one/file.txt')).toBe(1)
    await store.openFile('D:/One/file.txt', { revealInExplorer: false, skipWorkspaceWatchSync: true })
    await store.openFile('D:/One/file.txt', { recordOpen: false, verifyExistingFile: true, revealInExplorer: false, skipWorkspaceWatchSync: true })
    expect(store.fileOpenCount('D:/One/file.txt')).toBe(2)
    await store.setSearchSortMode('mostOpened')
    const saved = mocks.saveSettings.mock.calls.at(-1)![0]
    mocks.getSettings.mockResolvedValue(saved)
    setActivePinia(createPinia())
    const restored = useWorkspaceStore()
    await restored.loadSettings()
    restored.workspace = store.workspace
    expect(restored.settings.searchSortMode).toBe('mostOpened')
    expect(restored.fileOpenCount('D:/One/file.txt')).toBe(2)
    restored.workspace = { ...store.workspace, rootPath: 'D:/Two' }
    expect(restored.fileOpenCount('D:/One/file.txt')).toBe(0)
  })
})

describe('terminal file navigation', () => {
  it('opens the file and reveals its line while explorer expansion is still pending', async () => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    mocks.isTauri.mockReturnValue(false)
    mocks.readFile.mockResolvedValue('one\ntwo\nthree')
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    const store = useWorkspaceStore()
    store.workspace = { id: 'demo', name: 'Demo', displayName: 'Demo', rootPath: 'D:/Demo', openedAt: '' }
    let finishReveal!: () => void
    const expansion = new Promise<void>((resolve) => { finishReveal = resolve })
    const reveal = vi.spyOn(store, 'revealPathInExplorer').mockReturnValue(expansion)
    const positions: unknown[] = []
    const onPosition = (event: Event) => positions.push((event as CustomEvent).detail)
    window.addEventListener('superhigh:reveal-editor-position', onPosition)
    try {
      expect(await store.openTerminalFileLink('D:/Demo/dir/file.txt', 3)).toBe(true)
      expect(store.activeTab?.content).toBe('one\ntwo\nthree')
      vi.advanceTimersByTime(100)
      expect(positions).toEqual([{ path: 'D:/Demo/dir/file.txt', lineNumber: 3, column: 1 }])
    } finally {
      finishReveal()
      window.removeEventListener('superhigh:reveal-editor-position', onPosition)
      reveal.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('mobile-created terminal selection', () => {
  it('selects the new CLI session on desktop without duplicating replayed events', () => {
    setActivePinia(createPinia())
    mocks.isTauri.mockReturnValue(true)
    mocks.listen.mockClear()
    const store = useWorkspaceStore()
    mocks.listLiveTerminalSessionIds.mockResolvedValue(['fourth', 'fifth'])
    store.workspace = workspace('D:/project')
    const fourth = { id: 'fourth', title: 'Codex', cwd: 'D:/project', providerKind: 'codex' }
    const fifth = { ...fourth, id: 'fifth' }
    store.terminalSessions = [fourth]
    store.setActiveTerminalSession(fourth.id)
    store.bindBackendEvents()
    const handler = mocks.listen.mock.calls.find(([name]) => name === 'mobile-terminal-created')![1]
    handler({ payload: fifth })
    expect(store.activeCliSessionId).toBe('fifth')
    expect(store.activeTerminalSessionId).toBe('fifth')
    expect(store.terminalDrafts.fifth).toBe('')
    store.setActiveTerminalSession(fourth.id)
    handler({ payload: fifth })
    expect(store.terminalSessions).toHaveLength(2)
    expect(store.activeCliSessionId).toBe('fourth')
    store.unbindBackendEvents()
  })
})

function workspace(rootPath: string): Workspace {
  return {
    id: rootPath,
    name: rootPath.split('/').pop() ?? rootPath,
    displayName: rootPath.split('/').pop() ?? rootPath,
    rootPath,
    openedAt: '2026-05-09T00:00:00Z',
  }
}

function textTab(id: string, path: string, isDirty: boolean, content = `${id} content`): EditorTab {
  return {
    id,
    path,
    name: path.split('/').pop() ?? path,
    content,
    contentType: 'text',
    language: 'plaintext',
    isDirty,
  }
}

function planProposal(sessionId: string, decisions: PlanProposal['decisions'] = [
  { key: 'step-1', title: 'Step 1', question: 'Proceed?', yesText: 'do it', noText: 'skip this', recommendation: 'do it', choice: 'pending' },
]): PlanProposal {
  return {
    id: 'plan-sample',
    sessionId,
    decisions,
    createdAt: '2026-05-09T00:00:00Z',
  }
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

function scopedState(rootPath: string) {
  return {
    workspace: workspace(rootPath),
    directoryCache: {},
    expandedPaths: [],
    loadingDirectories: [],
    tabs: [],
    activeTabId: null,
    searchQuery: '',
    searchResults: null,
    searchOpen: false,
    searchLoading: false,
    terminalSessions: [],
    activeTerminalSessionId: null,
    activeCliSessionId: null,
    activeLocalTerminalSessionId: null,
    terminalDrafts: {},
    terminalConversation: {},
    activeWorkspaceSurface: 'project' as const,
  }
}

function minecraftConfig(projectPath = 'D:/One'): MinecraftClientConfig {
  return {
    projectPath,
    configPath: `${projectPath}/.superhigh/minecraft-client.json`,
    displayName: 'Test Minecraft',
    clientRoot: `${projectPath}/client`,
    launcherPath: `${projectPath}/client/launcher.exe`,
    embedTarget: 'final-game-window',
    windowTitleIncludes: ['Minecraft'],
    processNames: ['javaw.exe'],
    startupTimeoutMs: 180000,
  }
}

describe('Minecraft client workspace state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.getMinecraftClientConfig.mockReset()
  })

  it('hides the Minecraft feature when the workspace has no config', async () => {
    mocks.getMinecraftClientConfig.mockResolvedValue(null)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')

    await store.loadMinecraftClientConfig()

    expect(store.minecraftClientAvailable).toBe(false)
    expect(store.minecraftClientConfigError).toBe('')
  })

  it('enables the Minecraft feature when the workspace has a valid config', async () => {
    mocks.getMinecraftClientConfig.mockResolvedValue(minecraftConfig())
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')

    await store.loadMinecraftClientConfig()

    expect(store.minecraftClientAvailable).toBe(true)
    expect(store.minecraftClientConfig).toEqual(minecraftConfig())
  })
})

describe('startup media mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.isTauri.mockReset()
    mocks.takeStartupOpenTarget.mockReset()
    mocks.getSettings.mockReset()
    mocks.listRecentProjects.mockReset()
    mocks.openProject.mockReset()
    mocks.loadCliHistory.mockReset()
    mocks.refreshCliHistory.mockReset()
    mocks.recordCliHistoryMessage.mockReset()
    mocks.isTauri.mockReturnValue(true)
    mocks.loadCliHistory.mockResolvedValue({
      messages: [],
      paths: [],
      scannedFiles: 0,
      indexedFiles: 0,
      indexedMessages: 0,
    })
    mocks.refreshCliHistory.mockResolvedValue({
      messages: [],
      paths: [],
      scannedFiles: 0,
      indexedFiles: 0,
      indexedMessages: 0,
    })
    mocks.recordCliHistoryMessage.mockResolvedValue(undefined)
    mocks.takeStartupOpenTarget.mockResolvedValue({
      workspacePath: 'D:/Media',
      filePath: 'D:/Media/ICON.PNG',
    })
    mocks.getSettings.mockResolvedValue({})
  })

  it('opens media directly without restoring workspace state', async () => {
    const store = useWorkspaceStore()

    await store.initialize()

    expect(store.startupMediaPath).toBe('D:/Media/ICON.PNG')
    expect(store.initialized).toBe(true)
    expect(store.workspace).toBeNull()
    expect(mocks.getSettings).toHaveBeenCalledOnce()
    expect(mocks.listRecentProjects).not.toHaveBeenCalled()
    expect(mocks.openProject).not.toHaveBeenCalled()
  })

  it('keeps ordinary startup files in the existing workspace flow', async () => {
    mocks.takeStartupOpenTarget.mockResolvedValue({
      workspacePath: 'D:/Project',
      filePath: 'D:/Project/notes.txt',
    })
    mocks.listRecentProjects.mockResolvedValue([])
    const store = useWorkspaceStore()
    const openProject = vi.spyOn(store, 'openProject').mockResolvedValue(true)
    vi.spyOn(store, 'refreshStartupMetadataInBackground').mockImplementation(() => undefined)

    await store.initialize()

    expect(store.startupMediaPath).toBeNull()
    expect(openProject).toHaveBeenCalledWith('D:/Project', { silent: true })
  })

  it.each(['doc', 'docx', 'pdf'])('shows associated %s files even when the saved view is a terminal', async (extension) => {
    mocks.takeStartupOpenTarget.mockResolvedValue({ workspacePath: 'E:/', filePath: `E:/document.${extension}` })
    mocks.getSettings.mockResolvedValue({ activePreviewMode: 'local_terminal', multiTerminalMode: true, dialogueMapMode: true })
    mocks.listRecentProjects.mockResolvedValue([])
    const store = useWorkspaceStore()
    vi.spyOn(store, 'openProject').mockResolvedValue(true)
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    vi.spyOn(store, 'refreshStartupMetadataInBackground').mockImplementation(() => undefined)
    await store.initialize()
    expect(openFile).toHaveBeenCalledWith(`E:/document.${extension}`)
    expect(store.settings).toMatchObject({ activePreviewMode: 'code', multiTerminalMode: false, dialogueMapMode: false })
    expect(store.activeWorkspaceSurface).toBe('project')
  })
})

describe('workspace dirty tab handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.isTauri.mockReset()
    mocks.takeStartupOpenTarget.mockReset()
    mocks.getSettings.mockReset()
    mocks.writeFile.mockReset()
    mocks.writeEditorFile.mockReset()
    mocks.createDirectory.mockReset()
    mocks.deletePath.mockReset()
    mocks.listDirectory.mockReset()
    mocks.closeTerminal.mockReset()
    mocks.closeTerminalSessionsForWorkspace.mockReset()
    mocks.writeTerminalInput.mockReset()
    mocks.getTerminalBuffer.mockReset()
    mocks.listLiveTerminalSessionIds.mockReset()
    mocks.syncWorkspaceWatchRoots.mockReset()
    mocks.syncWorkspaceWatchTargets.mockReset()
    mocks.openProject.mockReset()
    mocks.openPath.mockReset()
    mocks.readFile.mockReset()
    mocks.readEditorFile.mockReset()
    mocks.readImageAsDataUrl.mockReset()
    mocks.saveSettings.mockReset()
    mocks.listRecentProjects.mockReset()
    mocks.detectVitePressDocs.mockReset()
    mocks.createTerminalSession.mockReset()
    mocks.listWorkspaceCliConversations.mockReset()
    mocks.readWorkspaceCliConversation.mockReset()
    mocks.resumeCliConversation.mockReset()
    mocks.loadCliHistory.mockReset()
    mocks.refreshCliHistory.mockReset()
    mocks.recordCliHistoryMessage.mockReset()
    mocks.isTauri.mockReturnValue(false)
    mocks.loadCliHistory.mockResolvedValue({
      messages: [],
      paths: [],
      scannedFiles: 0,
      indexedFiles: 0,
      indexedMessages: 0,
    })
    mocks.refreshCliHistory.mockResolvedValue({
      messages: [],
      paths: [],
      scannedFiles: 0,
      indexedFiles: 0,
      indexedMessages: 0,
    })
    mocks.recordCliHistoryMessage.mockResolvedValue(undefined)
    mocks.getSettings.mockResolvedValue({})
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.writeEditorFile.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.deletePath.mockResolvedValue(undefined)
    mocks.listDirectory.mockImplementation(async (path: string) => ({ path, entries: [] }))
    mocks.closeTerminal.mockResolvedValue(undefined)
    mocks.closeTerminalSessionsForWorkspace.mockResolvedValue(undefined)
    mocks.writeTerminalInput.mockResolvedValue(undefined)
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: '', startByte: 0, endByte: 0 })
    mocks.listLiveTerminalSessionIds.mockResolvedValue(['session-1', 'resumed-session-1'])
    mocks.syncWorkspaceWatchRoots.mockResolvedValue(undefined)
    mocks.syncWorkspaceWatchTargets.mockResolvedValue(undefined)
    mocks.openProject.mockImplementation(async (path: string) => workspace(path))
    mocks.openPath.mockResolvedValue(undefined)
    mocks.readFile.mockResolvedValue('file content')
    mocks.readEditorFile.mockImplementation(async (path: string, encoding?: string) => ({ content: await mocks.readFile(path), encoding: encoding ?? 'utf-8' }))
    mocks.readImageAsDataUrl.mockResolvedValue('data:image/png;base64,AA==')
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.listRecentProjects.mockResolvedValue([])
    mocks.createTerminalSession.mockResolvedValue({
      id: 'session-1',
      title: 'Codex CLI',
      providerKind: 'codex',
      cwd: 'D:/One',
    })
    mocks.listWorkspaceCliConversations.mockResolvedValue([])
    mocks.readWorkspaceCliConversation.mockResolvedValue(null)
    mocks.resumeCliConversation.mockResolvedValue({
      id: 'resumed-session-1',
      title: 'Codex CLI',
      providerKind: 'codex',
      cwd: 'D:/One',
    })
    mocks.detectVitePressDocs.mockResolvedValue({
      projectPath: 'D:/One',
      docsRoot: '',
      url: '',
      port: 0,
      running: false,
      startedBySuperHigh: false,
    })
  })

  it('counts dirty text tabs in current workspace and inactive snapshots', () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.tabs = [
      textTab('current-dirty', 'D:/One/a.txt', true),
      { ...textTab('current-clean', 'D:/One/b.txt', false), isDirty: false },
      { ...textTab('image-dirty', 'D:/One/c.png', true), contentType: 'image' },
    ]
    store.workspaceSnapshots = {
      'd:/one': {
        workspace: workspace('D:/One'),
        directoryCache: {},
        expandedPaths: [],
        loadingDirectories: [],
        tabs: [textTab('stale-current-snapshot', 'D:/One/stale.txt', true)],
        activeTabId: null,
        searchQuery: '',
        searchResults: null,
        searchOpen: false,
        searchLoading: false,
        terminalSessions: [],
        activeTerminalSessionId: null,
        activeCliSessionId: null,
        activeLocalTerminalSessionId: null,
        activeWorkspaceSurface: 'project',
      },
      'd:/two': {
        workspace: workspace('D:/Two'),
        directoryCache: {},
        expandedPaths: [],
        loadingDirectories: [],
        tabs: [textTab('snapshot-dirty', 'D:/Two/a.txt', true)],
        activeTabId: null,
        searchQuery: '',
        searchResults: null,
        searchOpen: false,
        searchLoading: false,
        terminalSessions: [],
        activeTerminalSessionId: null,
        activeCliSessionId: null,
        activeLocalTerminalSessionId: null,
        activeWorkspaceSurface: 'project',
      },
    }

    expect(store.hasDirtyTextTabs).toBe(true)
    expect(store.dirtyTextTabs.map((ref) => ref.tab.id)).toEqual(['current-dirty', 'snapshot-dirty'])
  })


  it('defaults the project layout mode when loading older settings', async () => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({
      themeId: 'dark',
      panelLayout: { previewWidth: 520 },
    })

    await store.loadSettings()

    expect(store.settings.projectLayoutMode).toBe('default')
  })

  it('restores scroll speed and rolls back failed saves without resetting conversation history', async () => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({ scrollSpeedPercent: 200, themeId: 'dark' })
    await store.loadSettings()
    expect(store.settings.scrollSpeedPercent).toBe(200)
    store.terminalDrafts = { history: '保留草稿' }
    await store.setScrollSpeedPercent(250)
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ scrollSpeedPercent: 250 }))
    mocks.saveSettings.mockRejectedValueOnce(new Error('disk unavailable'))
    await store.setScrollSpeedPercent(125)
    expect(store.settings.scrollSpeedPercent).toBe(250)
    expect(store.terminalDrafts).toEqual({ history: '保留草稿' })
    expect(store.errorMessage).toContain('保存滚动速度失败')
    mocks.getSettings.mockResolvedValue({ themeId: 'dark' })
    await store.loadSettings()
    expect(store.settings.scrollSpeedPercent).toBe(100)
  })

  it('defaults and normalizes the memo window frame when loading settings', async () => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({
      themeId: 'dark',
      memoWindowFrame: {
        left: Number.NaN,
        top: -20,
        width: 100,
        height: Number.POSITIVE_INFINITY,
      },
      panelLayout: { previewWidth: 520 },
    })

    await store.loadSettings()

    expect(store.settings.memoWindowFrame).toEqual({
      left: null,
      top: 0,
      width: 520,
      height: 680,
    })
  })

  it.each([[760, 620], [988, 806], [1710, 1395]])('migrates the previous memo default %i × %i to the compact size', async (width, height) => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({
      themeId: 'dark',
      memoWindowFrame: { left: 24, top: 36, width, height },
      panelLayout: { previewWidth: 520 },
    })

    await store.loadSettings()

    expect(store.settings.memoWindowFrame).toEqual({
      left: 24,
      top: 36,
      width: 960,
      height: 680,
    })
  })

  it('opens the memo window only when a workspace is active', () => {
    const store = useWorkspaceStore()

    store.setMemoWindowOpen(true)
    expect(store.memoWindowOpen).toBe(false)

    store.workspace = workspace('D:/One')
    store.toggleMemoWindow()
    expect(store.memoWindowOpen).toBe(true)

    store.toggleMemoWindow()
    expect(store.memoWindowOpen).toBe(false)
  })

  it('normalizes and persists the memo window frame on request', () => {
    const store = useWorkspaceStore()

    store.setMemoWindowFrame({ left: 24, top: 36, width: 900, height: 700 }, true)

    expect(store.settings.memoWindowFrame).toEqual({ left: 24, top: 36, width: 900, height: 700 })
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      memoWindowFrame: { left: 24, top: 36, width: 900, height: 700 },
    }))
  })

  it('uses the compact explorer width when loading older settings', async () => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({
      themeId: 'dark',
      panelLayout: { previewWidth: 520 },
    })

    await store.loadSettings()

    expect(store.settings.panelLayout.explorerWidth).toBe(192)
  })

  it('migrates the old default explorer width to the compact default', async () => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({
      themeId: 'dark',
      panelLayout: { previewWidth: 520, explorerWidth: 240 },
    })

    await store.loadSettings()

    expect(store.settings.panelLayout.explorerWidth).toBe(192)
  })

  it('toggles and saves the remembered project layout mode', () => {
    const store = useWorkspaceStore()

    store.toggleProjectLayoutMode()

    expect(store.settings.projectLayoutMode).toBe('swapped')
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      projectLayoutMode: 'swapped',
    }))
  })

  it('enables multi-terminal mode in the code preview and remembers it', () => {
    const store = useWorkspaceStore()
    store.settings.activePreviewMode = 'local_terminal'

    store.setMultiTerminalMode(true)

    expect(store.settings.multiTerminalMode).toBe(true)
    expect(store.settings.activePreviewMode).toBe('code')
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      multiTerminalMode: true,
      activePreviewMode: 'code',
    }))
  })

  it('persists dialogue-map mode and normalizes each workspace canvas state', async () => {
    const store = useWorkspaceStore()
    mocks.getSettings.mockResolvedValue({
      dialogueMapMode: true,
      dialogueMapByWorkspace: {
        'd:/one': {
          viewport: { x: 10, y: -20, zoom: 9 },
          positions: {
            valid: { x: 35, y: 48 },
            invalid: { x: 'nope', y: 8 },
          },
        },
      },
    })

    await store.loadSettings()
    store.workspace = workspace('D:/One')

    expect(store.settings.dialogueMapMode).toBe(true)
    expect(store.dialogueMapWorkspaceState()).toEqual({
      viewport: { x: 10, y: -20, zoom: 2.2 },
      positions: { valid: { x: 35, y: 48 } },
    })

    store.setDialogueMapViewport({ x: 84, y: 96, zoom: 0.1 })
    store.setDialogueMapCardPosition('codex:session-1', { x: 150, y: 210 })
    await store.saveSettings()

    expect(store.dialogueMapWorkspaceState()).toEqual({
      viewport: { x: 84, y: 96, zoom: 0.45 },
      positions: {
        valid: { x: 35, y: 48 },
        'codex:session-1': { x: 150, y: 210 },
      },
    })
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      dialogueMapMode: true,
      dialogueMapByWorkspace: expect.objectContaining({
        'd:/one': expect.objectContaining({
          positions: expect.objectContaining({ 'codex:session-1': { x: 150, y: 210 } }),
        }),
      }),
    }))
  })

  it('loads native workspace conversations and resumes one only once', async () => {
    mocks.isTauri.mockReturnValue(true)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    const conversation: CliNativeConversationSummary = {
      id: 'codex:session-1',
      providerKind: 'codex',
      nativeSessionId: 'session-1',
      title: '修复对话地图',
      summary: '已经找到根因。',
      cwd: 'D:/One',
      createdAt: '2026-08-25T01:00:00Z',
      updatedAt: '2026-08-25T01:03:00Z',
      messageCount: 2,
      sourcePath: 'C:/Users/ExampleUser01/.codex/sessions/rollout.jsonl',
      resumeSupported: true,
    }
    mocks.listWorkspaceCliConversations.mockResolvedValue([conversation])

    await store.refreshNativeCliConversations()
    const resumed = await store.resumeNativeCliConversation(conversation)
    const resumedAgain = await store.resumeNativeCliConversation(conversation)

    expect(mocks.listWorkspaceCliConversations).toHaveBeenCalledWith('D:/One')
    expect(store.nativeCliConversations).toEqual([conversation])
    expect(mocks.resumeCliConversation).toHaveBeenCalledOnce()
    expect(mocks.resumeCliConversation).toHaveBeenCalledWith('D:/One', 'codex', 'D:/One', 'session-1')
    expect(resumed?.nativeConversationId).toBe('codex:session-1')
    expect(resumedAgain?.id).toBe('resumed-session-1')
    expect(store.terminalSessions).toHaveLength(1)
  })



  it('saves dirty text tabs across workspaces and clears dirty flags', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.tabs = [textTab('current-dirty', 'D:/One/a.txt', true, 'current')]
    store.workspaceSnapshots = {
      'd:/two': {
        workspace: workspace('D:/Two'),
        directoryCache: {},
        expandedPaths: [],
        loadingDirectories: [],
        tabs: [textTab('snapshot-dirty', 'D:/Two/a.txt', true, 'snapshot')],
        activeTabId: null,
        searchQuery: '',
        searchResults: null,
        searchOpen: false,
        searchLoading: false,
        terminalSessions: [],
        activeTerminalSessionId: null,
        activeCliSessionId: null,
        activeLocalTerminalSessionId: null,
        activeWorkspaceSurface: 'project',
      },
    }

    await expect(store.saveDirtyTextTabs()).resolves.toBe(true)

    expect(mocks.writeEditorFile).toHaveBeenCalledWith('D:/One/a.txt', 'current', 'utf-8')
    expect(mocks.writeEditorFile).toHaveBeenCalledWith('D:/Two/a.txt', 'snapshot', 'utf-8')
    expect(store.hasDirtyTextTabs).toBe(false)
  })

  it('discards dirty flags without writing files', () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.tabs = [textTab('current-dirty', 'D:/One/a.txt', true)]
    store.workspaceSnapshots = {
      'd:/two': {
        workspace: workspace('D:/Two'),
        directoryCache: {},
        expandedPaths: [],
        loadingDirectories: [],
        tabs: [textTab('snapshot-dirty', 'D:/Two/a.txt', true)],
        activeTabId: null,
        searchQuery: '',
        searchResults: null,
        searchOpen: false,
        searchLoading: false,
        terminalSessions: [],
        activeTerminalSessionId: null,
        activeCliSessionId: null,
        activeLocalTerminalSessionId: null,
        activeWorkspaceSurface: 'project',
      },
    }

    store.discardDirtyTextTabs()

    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(store.hasDirtyTextTabs).toBe(false)
  })

  it('does not close a workspace while it still has dirty text tabs', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One', 'D:/Two']
    store.workspaceSnapshots = {
      'd:/two': {
        workspace: workspace('D:/Two'),
        directoryCache: {},
        expandedPaths: [],
        loadingDirectories: [],
        tabs: [textTab('snapshot-dirty', 'D:/Two/a.txt', true)],
        activeTabId: null,
        searchQuery: '',
        searchResults: null,
        searchOpen: false,
        searchLoading: false,
        terminalSessions: [],
        activeTerminalSessionId: null,
        activeCliSessionId: null,
        activeLocalTerminalSessionId: null,
        activeWorkspaceSurface: 'project',
      },
    }

    await store.closeWorkspaceTab('D:/Two')

    expect(store.openWorkspacePaths).toEqual(['D:/One', 'D:/Two'])
    expect(store.workspaceSnapshots['d:/two']).toBeTruthy()
    expect(store.pendingWorkspaceCloseRootPath).toBe('D:/Two')
  })
})

describe('workspace file refresh and scoped state performance', () => {
  let fakeNow = Date.parse('2026-05-09T00:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    fakeNow += 10_000
    vi.setSystemTime(fakeNow)
    setActivePinia(createPinia())
    mocks.isTauri.mockReset()
    mocks.writeFile.mockReset()
    mocks.createDirectory.mockReset()
    mocks.deletePath.mockReset()
    mocks.listDirectory.mockReset()
    mocks.closeTerminal.mockReset()
    mocks.closeTerminalSessionsForWorkspace.mockReset()
    mocks.writeTerminalInput.mockReset()
    mocks.getTerminalBuffer.mockReset()
    mocks.listLiveTerminalSessionIds.mockReset()
    mocks.syncWorkspaceWatchRoots.mockReset()
    mocks.syncWorkspaceWatchTargets.mockReset()
    mocks.openProject.mockReset()
    mocks.openPath.mockReset()
    mocks.readFile.mockReset()
    mocks.readImageAsDataUrl.mockReset()
    mocks.saveSettings.mockReset()
    mocks.listRecentProjects.mockReset()
    mocks.detectVitePressDocs.mockReset()
    mocks.createTerminalSession.mockReset()
    mocks.loadCliHistory.mockReset()
    mocks.refreshCliHistory.mockReset()
    mocks.recordCliHistoryMessage.mockReset()
    mocks.ensureVitePressDocs.mockReset()
    mocks.isTauri.mockReturnValue(false)
    mocks.loadCliHistory.mockResolvedValue({
      messages: [],
      paths: [],
      scannedFiles: 0,
      indexedFiles: 0,
      indexedMessages: 0,
    })
    mocks.refreshCliHistory.mockResolvedValue({
      messages: [],
      paths: [],
      scannedFiles: 0,
      indexedFiles: 0,
      indexedMessages: 0,
    })
    mocks.recordCliHistoryMessage.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.deletePath.mockResolvedValue(undefined)
    mocks.listDirectory.mockImplementation(async (path: string) => ({ path, entries: [] }))
    mocks.closeTerminal.mockResolvedValue(undefined)
    mocks.closeTerminalSessionsForWorkspace.mockResolvedValue(undefined)
    mocks.writeTerminalInput.mockResolvedValue(undefined)
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: '', startByte: 0, endByte: 0 })
    mocks.listLiveTerminalSessionIds.mockResolvedValue(['session-1', 'resumed-session-1'])
    mocks.syncWorkspaceWatchRoots.mockResolvedValue(undefined)
    mocks.syncWorkspaceWatchTargets.mockResolvedValue(undefined)
    mocks.openProject.mockImplementation(async (path: string) => workspace(path))
    mocks.openPath.mockResolvedValue(undefined)
    mocks.readFile.mockResolvedValue('file content')
    mocks.readImageAsDataUrl.mockResolvedValue('data:image/png;base64,AA==')
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.listRecentProjects.mockResolvedValue([])
    mocks.createTerminalSession.mockResolvedValue({
      id: 'session-1',
      title: 'Codex CLI',
      providerKind: 'codex',
      cwd: 'D:/One',
    })
    mocks.detectVitePressDocs.mockResolvedValue({
      projectPath: 'D:/One',
      docsRoot: '',
      url: '',
      port: 0,
      running: false,
      startedBySuperHigh: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues a forced directory refresh while the same directory is already loading', async () => {
    const store = useWorkspaceStore()
    let resolveFirst: (listing: DirectoryListing) => void = () => undefined
    mocks.listDirectory
      .mockImplementationOnce(async (path: string) => new Promise<DirectoryListing>((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce({
        path: 'D:/One',
        entries: [{
          name: 'fresh.txt',
          path: 'D:/One/fresh.txt',
          type: 'file',
          extension: '.txt',
          size: 5,
          modified: 1,
          isHidden: false,
        }],
      })

    const firstLoad = store.loadDirectory('D:/One', true)
    const secondLoad = store.loadDirectory('D:/One', true)

    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    resolveFirst({ path: 'D:/One', entries: [] })
    await Promise.all([firstLoad, secondLoad])

    expect(mocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(store.directoryCache['D:/One'].entries.map((entry) => entry.name)).toEqual(['fresh.txt'])
  })

  it('refreshes the requested explorer root and its expanded children', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.expandedPaths = [
      'D:/One',
      'D:/One/src',
      'D:/One/ProjectEditor',
      'D:/One/ProjectEditor/cards',
    ]

    await store.refreshExplorer('D:/One/ProjectEditor')

    expect(mocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, 'D:/One/ProjectEditor')
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(2, 'D:/One/ProjectEditor/cards')
  })

  it('collapses every expanded directory, keeping only the root', () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.expandedPaths = [
      'D:/One',
      'D:/One/src',
      'D:/One/ProjectEditor',
      'D:/One/ProjectEditor/cards',
    ]

    store.collapseAllDirectories('D:/One')

    expect(store.expandedPaths).toEqual(['D:/One'])
  })

  it('refreshes only affected cached or expanded directories in the current workspace', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One']
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [] },
      'D:/One/src': { path: 'D:/One/src', entries: [] },
      'D:/One/docs': { path: 'D:/One/docs', entries: [] },
    }
    store.expandedPaths = ['D:/One', 'D:/One/src']

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/One',
      changedPaths: ['D:/One/src/new.ts'],
      affectedDirectories: ['D:/One/src'],
      kind: 'create',
      sequence: 1,
    })
    await vi.advanceTimersByTimeAsync(130)

    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/One/src')
  })

  it('refreshes an externally created file while further watcher events continue arriving', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One']
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [] },
    }

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/One',
      changedPaths: ['D:/One/new.txt'],
      affectedDirectories: ['D:/One'],
      kind: 'create',
      sequence: 1,
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/One',
      changedPaths: ['D:/One/server.log'],
      affectedDirectories: ['D:/One'],
      kind: 'modify',
      sequence: 2,
    })
    await vi.advanceTimersByTimeAsync(30)

    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/One')
  })

  it('starts a document preview only once while the first request is pending', async () => {
    mocks.isTauri.mockReturnValue(true)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One']
    let resolveStart!: (value: {
      projectPath: string
      docsRoot: string
      url: string
      port: number
      running: boolean
      startedBySuperHigh: boolean
    }) => void
    mocks.ensureVitePressDocs.mockImplementation(() => new Promise((resolve) => {
      resolveStart = resolve
    }))

    const first = store.ensureVitePressDocs('D:/One')
    const second = store.ensureVitePressDocs('D:/One')

    expect(mocks.ensureVitePressDocs).toHaveBeenCalledTimes(1)
    resolveStart({
      projectPath: 'D:/One',
      docsRoot: 'D:/One/docs',
      url: 'http://127.0.0.1:5175',
      port: 5175,
      running: true,
      startedBySuperHigh: true,
    })
    await Promise.all([first, second])
  })

  it('does not let an older document detection replace a newer preview start', async () => {
    mocks.isTauri.mockReturnValue(true)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One']
    let resolveDetection!: (value: {
      projectPath: string
      docsRoot: string
      url: string
      port: number
      running: boolean
      startedBySuperHigh: boolean
    }) => void
    mocks.detectVitePressDocs.mockImplementation(() => new Promise((resolve) => {
      resolveDetection = resolve
    }))
    mocks.ensureVitePressDocs.mockResolvedValue({
      projectPath: 'D:/One',
      docsRoot: 'D:/One/docs',
      url: 'http://127.0.0.1:5175',
      port: 5175,
      running: true,
      startedBySuperHigh: true,
    })

    const detection = store.detectVitePressDocs('D:/One')
    const started = await store.ensureVitePressDocs('D:/One')
    resolveDetection({
      projectPath: 'D:/One',
      docsRoot: 'D:/One/docs',
      url: '',
      port: 0,
      running: false,
      startedBySuperHigh: false,
    })
    await detection

    expect(started?.status).toBe('running')
    expect(store.docsWorkspaces['d:/one']?.status).toBe('running')
    expect(store.docsWorkspaces['d:/one']?.url).toBe('http://127.0.0.1:5175')
  })

  it('ignores a delayed watcher event for the last confirmed ProjectEditor write', async () => {
    const store = useWorkspaceStore()
    const tab = textTab('projecteditor', 'D:/One/ProjectEditor/Gui/menu.yml', true, 'next draft')
    tab.lastKnownDiskContent = 'saved by ProjectEditor'
    store.tabs = [tab]
    store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml'] = true
    mocks.readFile.mockResolvedValueOnce('saved by ProjectEditor')

    await store.reloadOpenTabsForChangedPaths(
      store.tabs,
      new Set(['d:/one/projecteditor/gui/menu.yml']),
    )

    expect(tab.content).toBe('next draft')
    expect(tab.isDirty).toBe(true)
    expect(store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml']).toBeUndefined()
  })

  it('auto-loads a real external file change over a dirty draft', async () => {
    const store = useWorkspaceStore()
    const tab = textTab('projecteditor', 'D:/One/ProjectEditor/Gui/menu.yml', true, 'local draft')
    tab.lastKnownDiskContent = 'known disk content'
    store.tabs = [tab]
    store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml'] = true
    mocks.readFile.mockResolvedValueOnce('external disk content')

    await store.reloadOpenTabsForChangedPaths(
      store.tabs,
      new Set(['d:/one/projecteditor/gui/menu.yml']),
    )

    expect(tab.content).toBe('external disk content')
    expect(tab.isDirty).toBe(false)
    expect(tab.lastKnownDiskContent).toBe('external disk content')
    expect(store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml']).toBeUndefined()
  })

  it('records clean ProjectEditor preview content and clears mixed-case conflicts', () => {
    const store = useWorkspaceStore()
    const tab = textTab('projecteditor', 'D:/One/ProjectEditor/Gui/Menu.yml', true, 'old')
    store.tabs = [tab]
    store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml'] = true

    const updated = store.setScopedCodePreviewContent(
      'd:/one/projecteditor/gui/menu.yml',
      'saved by ProjectEditor',
      { isDirty: false },
    )

    expect(updated).toBe(true)
    expect(tab.content).toBe('saved by ProjectEditor')
    expect(tab.isDirty).toBe(false)
    expect(tab.lastKnownDiskContent).toBe('saved by ProjectEditor')
    expect(store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml']).toBeUndefined()
  })

  it('reloads an open text tab from disk and resets its conflict baseline', async () => {
    const store = useWorkspaceStore()
    const tab = textTab('projecteditor', 'D:/One/ProjectEditor/Gui/menu.yml', true, 'local draft')
    tab.lastKnownDiskContent = 'old disk content'
    store.tabs = [tab]
    store.activeTabId = tab.id
    store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml'] = true
    mocks.readFile.mockResolvedValueOnce('current disk content')

    await expect(store.reloadActiveTabFromDisk()).resolves.toBe(true)

    expect(tab.content).toBe('current disk content')
    expect(tab.isDirty).toBe(false)
    expect(tab.lastKnownDiskContent).toBe('current disk content')
    expect(store.fileConflictPaths['d:/one/projecteditor/gui/menu.yml']).toBeUndefined()
  })

  it('keeps the visible directory cached until an external refresh finishes', async () => {
    let resolveRefresh!: (listing: DirectoryListing) => void
    mocks.listDirectory.mockImplementation(() => new Promise<DirectoryListing>((resolve) => {
      resolveRefresh = resolve
    }))
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One']
    store.directoryCache = {
      'D:/One': {
        path: 'D:/One',
        entries: [{ name: 'existing.txt', path: 'D:/One/existing.txt', type: 'file' }],
      },
    }

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/One',
      changedPaths: ['D:/One/new.txt'],
      affectedDirectories: ['D:/One'],
      kind: 'create',
      sequence: 2,
    })
    await vi.advanceTimersByTimeAsync(130)

    expect(store.directoryCache['D:/One'].entries[0]?.name).toBe('existing.txt')

    resolveRefresh({
      path: 'D:/One',
      entries: [{ name: 'new.txt', path: 'D:/One/new.txt', type: 'file' }],
    })
    await vi.waitFor(() => {
      expect(store.directoryCache['D:/One'].entries[0]?.name).toBe('new.txt')
    })
  })

  it('keeps background workspace directory refresh deferred until activation', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One', 'D:/Two']
    store.workspaceSnapshots = {
      'd:/two': {
        ...scopedState('D:/Two'),
        directoryCache: {
          'D:/Two/src': { path: 'D:/Two/src', entries: [] },
        },
        expandedPaths: ['D:/Two', 'D:/Two/src', 'D:/Two/docs'],
      },
    }

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/Two',
      changedPaths: ['D:/Two/docs/page.md', 'D:/Two/src/main.ts'],
      affectedDirectories: ['D:/Two/docs', 'D:/Two/src'],
      kind: 'modify',
      sequence: 2,
    })
    await vi.advanceTimersByTimeAsync(130)

    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(store.workspaceSnapshots['d:/two'].directoryCache['D:/Two/src']).toBeUndefined()
  })

  it('reloads expanded directories whose background cache was cleared on activation', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One', 'D:/Two']
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [] },
    }
    store.workspaceSnapshots = {
      'd:/two': {
        ...scopedState('D:/Two'),
        directoryCache: {
          'D:/Two': { path: 'D:/Two', entries: [] },
          'D:/Two/src': { path: 'D:/Two/src', entries: [] },
          'D:/Two/docs': { path: 'D:/Two/docs', entries: [] },
        },
        expandedPaths: ['D:/Two', 'D:/Two/src'],
      },
    }

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/Two',
      changedPaths: ['D:/Two/src/main.ts', 'D:/Two/docs/page.md'],
      affectedDirectories: ['D:/Two/src', 'D:/Two/docs'],
      kind: 'modify',
      sequence: 3,
    })
    await vi.advanceTimersByTimeAsync(130)
    expect(store.pendingWorkspaceFileChanges['d:/two']).toBeUndefined()
    expect(store.workspaceSnapshots['d:/two'].directoryCache['D:/Two/src']).toBeUndefined()
    mocks.listDirectory.mockClear()

    await store.switchWorkspace('D:/Two')

    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/Two/src')
  })


  it('opens a project without loading legacy terminal state and never saves terminal tabs', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      terminalSessions: [{ id: 'old', title: 'Old server', providerKind: 'project-service', cwd: 'D:/One' }],
      activeLocalTerminalSessionId: 'old',
    }))
    const store = useWorkspaceStore()
    await store.openProject('D:/One')
    expect(store.terminalSessions).toEqual([])
    expect(store.activeLocalTerminalSessionId).toBeNull()
    expect(mocks.readFile).not.toHaveBeenCalledWith('D:/One/.superhigh/terminal-state.json')
    await store.createTerminalSession('codex')
    store.setTerminalDraft('session-1', 'temporary draft')
    store.renameTerminalSession('session-1', 'temporary name')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.writeFile).not.toHaveBeenCalledWith('D:/One/.superhigh/terminal-state.json', expect.anything())
  })

  it('removes exited background sessions and cached active copies before switching back', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [
      { id: 'old', title: 'Server', providerKind: 'project-service', cwd: 'D:/One' },
      { id: 'live', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' },
    ]
    store.activeTerminalSessionId = 'old'
    store.activeLocalTerminalSessionId = 'old'
    store.terminalDrafts.old = 'discard me'
    store.terminalConversation.old = []
    store.stashActiveWorkspaceState()
    store.restoreWorkspaceScopedState(workspace('D:/Two'))
    await store.closeTerminalSession('old')
    store.queueTerminalOutput('old', 'late output')
    store.restoreWorkspaceScopedState(workspace('D:/One'))
    expect(store.terminalSessions.map(session => session.id)).toEqual(['live'])
    expect(store.activeTerminalSessionId).toBe('live')
    expect(store.activeLocalTerminalSessionId).toBeNull()
    expect(store.terminalDrafts.old).toBeUndefined()
    expect(store.terminalConversation.old).toBeUndefined()
    await store.closeTerminalSession('live')
    store.restoreWorkspaceScopedState(workspace('D:/One'))
    expect(store.terminalSessions).toEqual([])
  })

  it.each(['project-startup', 'minecraft-client'])('restarts %s repeatedly with exactly one fresh tab', async (providerKind) => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    const session = (id: string) => ({ id, providerKind, title: 'Server', cwd: 'D:/One' })
    store.terminalSessions = [session('old')]
    store.setActiveTerminalSession('old')
    const operations: string[] = []
    mocks.closeTerminal.mockImplementation(async (id) => { operations.push(`close:${id}`) })
    mocks.stopMinecraftClient.mockResolvedValue({ state: 'stopped' })
    for (let index = 0; index < 3; index++) {
      const id = `new-${index}`
      const create = async () => { operations.push(`create:${id}`); return session(id) }
      mocks.createProjectStartupTerminalSession.mockImplementation(create)
      mocks.startMinecraftClient.mockImplementation(async () => ({ session: await create(), status: { state: 'running' } }))
      const restart = providerKind === 'minecraft-client'
        ? store.restartMinecraftClient()
        : store.restartProjectFromTerminalAction({ id: 'restart', label: 'Restart', kind: 'restart-project', input: 'stop', startAfterCommand: true, restartDelayMs: 800 })
      await vi.advanceTimersByTimeAsync(800)
      await restart
      expect(store.terminalSessions.map(item => item.id)).toEqual([id])
      expect(store.activeLocalTerminalSessionId).toBe(id)
    }
    expect(operations).toEqual(['close:old', 'create:new-0', 'close:new-0', 'create:new-1', 'close:new-1', 'create:new-2'])
  })

  it('closes stale service consoles before starting the chain again', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.projectStartupConfig = {
      name: 'Chain', mode: 'services',
      services: [{ id: 'server', name: 'Server', workingDirectory: 'D:/One' }],
    } as never
    store.terminalSessions = [
      { id: 'paused', title: 'Server', providerKind: 'project-service', cwd: 'D:/One' },
      { id: 'shell', title: 'PowerShell', providerKind: 'local', cwd: 'D:/One' },
    ]
    const operations: string[] = []
    mocks.closeTerminal.mockImplementation(async (id) => { operations.push(`close:${id}`) })
    mocks.startProjectServices.mockImplementation(async () => {
      operations.push('start')
      return {
        projectPath: 'D:/One', runId: 'run-2',
        services: [{ serviceId: 'server', status: 'running', message: null, session: { id: 'fresh', title: 'Server', providerKind: 'project-service', cwd: 'D:/One' } }],
      }
    })
    await store.startProjectFromTerminalAction()
    expect(operations).toEqual(['close:paused', 'start'])
    expect(store.terminalSessions.map(item => item.id)).toEqual(['shell', 'fresh'])
  })

  it('clears a service that exited before its delayed startup response arrives', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.listLiveTerminalSessionIds.mockResolvedValue([])
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.applyProjectServiceStatus({
      projectPath: 'D:/One', runId: 'run-1', serviceId: 'server', status: 'running', message: null,
      session: { id: 'already-exited', title: 'Server', providerKind: 'project-service', cwd: 'D:/One' },
    })
    await flushPromises()
    expect(store.terminalSessions).toEqual([])
    expect(store.projectServiceRun?.services.server.sessionId).toBeNull()
    expect(store.projectServiceRun?.chainStatus).not.toBe('running')
  })

  it('preserves a live terminal if backend liveness checking fails', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.listLiveTerminalSessionIds.mockRejectedValueOnce(new Error('offline'))
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'live', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    await store.removeTerminalIfNotLive('live')
    expect(store.terminalSessions).toHaveLength(1)
    expect(mocks.closeTerminal).not.toHaveBeenCalled()
  })

  it('records background terminal replies into the matching workspace snapshot', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.writeFile.mockResolvedValue(undefined)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One', 'D:/Two']
    store.workspaceSnapshots = {
      'd:/two': {
        ...scopedState('D:/Two'),
        terminalSessions: [{ id: 'session-two', title: 'Codex', providerKind: 'codex', cwd: 'D:/Two' }],
        terminalConversation: {
          'session-two': [{ id: 'msg-two', sessionId: 'session-two', role: 'user', content: '后台任务', timestamp: '2026-05-09T00:00:00Z' }],
        },
        terminalConversationReplyPending: { 'session-two': true },
      },
    }

    store.appendTerminalConversationReply('session-two', '已完成后台任务。')

    const messages = store.workspaceSnapshots['d:/two'].terminalConversation?.['session-two'] ?? []
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toContain('已完成后台任务')

    await vi.advanceTimersByTimeAsync(510)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('clears terminal state when closing a background workspace without saving it', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.writeFile.mockResolvedValue(undefined)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One', 'D:/Two']
    store.workspaceSnapshots = {
      'd:/two': {
        ...scopedState('D:/Two'),
        terminalSessions: [{ id: 'session-two', title: 'Codex', providerKind: 'codex', cwd: 'D:/Two' }],
        terminalConversation: {
          'session-two': [{ id: 'msg-two', sessionId: 'session-two', role: 'user', content: '旧会话', timestamp: '2026-05-09T00:00:00Z' }],
        },
      },
    }

    await store.closeWorkspaceTab('D:/Two')
    await flushPromises()

    expect(mocks.closeTerminalSessionsForWorkspace).toHaveBeenCalledWith('D:/Two')
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(store.workspaceSnapshots['d:/two']).toBeUndefined()
  })






  it('opens SuperHigh editor HTML as a regular code-preview tab', async () => {
    const store = useWorkspaceStore()
    const path = 'D:/One/.superhigh/editor/items.html'
    store.workspace = workspace('D:/One')
    store.settings.activePreviewMode = 'code'
    mocks.readFile.mockResolvedValue('<main>Items</main>')

    await expect(store.openFile(path, { revealInExplorer: false })).resolves.toBe(true)

    expect(store.activeTab).toMatchObject({ path, content: '<main>Items</main>', contentType: 'text', language: 'html' })
    expect(store.activeWorkspaceSurface).toBe('project')
    expect(store.tabs).toHaveLength(1)
    await store.openFile(path, { revealInExplorer: false })
    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab?.path).toBe(path)
  })

  it('watches external image parents until their last tab closes and reloads changed pixels', async () => {
    const store = useWorkspaceStore()
    const root = 'D:/Server/plugins'
    const path = 'D:/Client/resourcepacks/gui/slot1.png'
    store.workspace = workspace(root)
    store.openWorkspacePaths = [root]
    mocks.readImageAsDataUrl.mockResolvedValueOnce('data:image/png;base64,before')
      .mockResolvedValueOnce('data:image/png;base64,after')
    await store.openFile(path, { revealInExplorer: false })
    const id = store.activeTabId
    expect(store.workspaceWatchTargets()[0]?.directories).toContain('D:/Client/resourcepacks/gui')

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: root,
      changedPaths: [path],
      affectedDirectories: [root],
      kind: 'modify',
      sequence: 1,
    })
    await vi.advanceTimersByTimeAsync(130)

    expect(store.activeTab).toMatchObject({ id, contentType: 'image', content: 'data:image/png;base64,after' })
    store.tabs = []
    expect(store.workspaceWatchTargets()[0]?.directories).not.toContain('D:/Client/resourcepacks/gui')
  })

  it('refreshes an open SuperHigh editor HTML tab after an external save', async () => {
    const store = useWorkspaceStore()
    const path = 'D:/One/.superhigh/editor/items.html'
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One']
    mocks.readFile.mockResolvedValueOnce('<main>Before</main>').mockResolvedValueOnce('<main>After</main>')
    await store.openFile(path, { revealInExplorer: false })

    store.scheduleWorkspaceFilesChangedRefresh({
      rootPath: 'D:/One',
      changedPaths: [path],
      affectedDirectories: ['D:/One/.superhigh/editor'],
      kind: 'modify',
      sequence: 1,
    })
    await vi.advanceTimersByTimeAsync(130)

    expect(store.activeTab?.content).toBe('<main>After</main>')
    expect(store.activeTab?.lastKnownDiskContent).toBe('<main>After</main>')
  })

  it.each(['doc', 'docx', 'PDF', 'XLSX'])('opens and refreshes Office %s files without text decoding or saving', async (extension) => {
    const store = useWorkspaceStore()
    const path = `D:/One/说明.${extension}`
    store.workspace = workspace('D:/One')
    mocks.readOfficeFileBase64.mockResolvedValue('UEsAAf8=')
    await expect(store.openFile(path, { revealInExplorer: false })).resolves.toBe(true)
    expect(store.activeTab).toMatchObject({ contentType: 'office', content: 'UEsAAf8=', isDirty: false })
    expect(store.activeTab?.lastKnownDiskContent).toBeUndefined()
    await store.openFile(path, { verifyExistingFile: true, revealInExplorer: false })
    store.updateActiveTabContent('should not replace binary content')
    await store.saveActiveTab()
    expect(store.activeTab?.content).toBe('UEsAAf8=')
    expect(mocks.writeFile).not.toHaveBeenCalledWith(path, expect.anything())
    mocks.readOfficeFileBase64.mockResolvedValue('UEsCAw==')
    await store.reloadOpenTabsForChangedPaths(store.tabs, new Set([path.toLowerCase()]))
    expect(store.activeTab).toMatchObject({ contentType: 'office', content: 'UEsCAw==' })
    expect(mocks.readFile).not.toHaveBeenCalledWith(path)
  })

  it.each(['MP4', 'mkv', 'mp3', 'WAV'])('opens and refreshes %s through streaming without reading or saving text', async (extension) => {
    const store = useWorkspaceStore()
    const path = `D:/One/原生运镜.${extension}`
    mocks.readMediaAsDataUrl.mockResolvedValue('http://asset.localhost/media')
    await store.openFile(path, { revealInExplorer: false })
    await store.openFile(path, { verifyExistingFile: true, revealInExplorer: false })
    await store.reloadOpenTabsForChangedPaths(store.tabs, new Set([path.toLowerCase()]))
    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab).toMatchObject({ contentType: 'media', content: 'http://asset.localhost/media' })
    store.updateActiveTabContent('overwrite')
    await store.saveActiveTab()
    expect(mocks.readFile).not.toHaveBeenCalledWith(path)
    expect(mocks.writeFile).not.toHaveBeenCalledWith(path, expect.anything())
  })

  it.each(['large.txt', 'unknown.blob', 'plugin.jar', 'program.exe', 'broken.mp4'])('keeps %s reachable when preview fails, including repeat terminal jumps', async (name) => {
    const store = useWorkspaceStore()
    const path = `D:/One/${name}`
    mocks.isFile.mockResolvedValue(true)
    mocks.readFile.mockRejectedValue(new Error('此文件无法在内置编辑器预览'))
    mocks.readMediaAsDataUrl.mockRejectedValue(new Error('无法预览此媒体'))
    const options = { createUnsupportedTabOnError: false, verifyExistingFile: true, revealInExplorer: false }
    await store.openFile(path, options)
    await store.openFile(path, options)
    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab).toMatchObject({ path, contentType: 'unsupported', isDirty: false })
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('does not replace dirty text or create a tab for a missing terminal target', async () => {
    const store = useWorkspaceStore()
    const path = 'D:/One/notes.txt'
    store.tabs = [textTab('dirty', path, true)]
    const content = store.tabs[0].content
    mocks.readFile.mockResolvedValue('changed on disk')
    await store.openFile(path, { verifyExistingFile: true, revealInExplorer: false })
    expect(store.tabs[0].content).toBe(content)
    mocks.readFile.mockRejectedValue(new Error('missing'))
    mocks.isFile.mockResolvedValue(false)
    await expect(store.openFile('D:/One/missing.txt', { createUnsupportedTabOnError: false })).resolves.toBe(false)
    expect(store.tabs).toHaveLength(1)
  })

  it('reveals opened files by expanding parent directories and focusing the file', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [] },
    }
    store.expandedPaths = ['D:/One']

    await store.openFile('D:/One/src/components/App.vue')

    expect(mocks.readFile).toHaveBeenCalledWith('D:/One/src/components/App.vue')
    expect(store.expandedPaths).toEqual(['D:/One', 'D:/One/src', 'D:/One/src/components'])
    expect(store.explorerFocusedPath).toBe('D:/One/src/components/App.vue')
    expect(store.explorerRevealRequestId).toBe(1)
    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/One/src')
    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/One/src/components')
  })

  it('reveals an already-open tab when the tab is activated', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.tabs = [textTab('tab-a', 'D:/One/src/App.vue', false)]
    store.activeTabId = null
    store.expandedPaths = ['D:/One']

    await store.setActiveTab('tab-a')

    expect(store.activeTabId).toBe('tab-a')
    expect(store.explorerFocusedPath).toBe('D:/One/src/App.vue')
    expect(store.explorerRevealRequestId).toBe(1)
  })

  it('verifies an already-open image with the image reader', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.tabs = [{
      ...textTab('image-tab', 'D:/One/outputs/result.PNG', false),
      content: 'data:image/png;base64,previous',
      contentType: 'image',
      language: 'image',
    }]

    await expect(store.openFile('D:/One/outputs/result.PNG', {
      createUnsupportedTabOnError: false,
      verifyExistingFile: true,
      revealInExplorer: false,
    })).resolves.toBe(true)

    expect(mocks.readImageAsDataUrl).toHaveBeenCalledWith('D:/One/outputs/result.PNG')
    expect(mocks.readFile).not.toHaveBeenCalledWith('D:/One/outputs/result.PNG')
  })

  it('opens breadcrumb file targets inside the code preview instead of system explorer', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.activeWorkspaceSurface = 'docs'
    store.settings.activePreviewMode = 'local_terminal'
    store.tabs = [textTab('tab-a', 'D:/One/src/App.vue', false)]
    store.activeTabId = null
    store.expandedPaths = ['D:/One']

    await store.openBreadcrumbTarget('D:/One/src/App.vue')

    expect(store.activeWorkspaceSurface).toBe('project')
    expect(store.settings.activePreviewMode).toBe('code')
    expect(store.activeTabId).toBe('tab-a')
    expect(store.explorerFocusedPath).toBe('D:/One/src/App.vue')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('reveals breadcrumb directory targets inside the explorer', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.settings.activePreviewMode = 'local_terminal'
    store.expandedPaths = ['D:/One']

    await store.openBreadcrumbTarget('D:/One/src/components')

    expect(store.settings.activePreviewMode).toBe('code')
    expect(store.expandedPaths).toEqual(['D:/One', 'D:/One/src', 'D:/One/src/components'])
    expect(store.explorerFocusedPath).toBe('D:/One/src/components')
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('does not reveal when closing or saving tabs', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.tabs = [textTab('tab-a', 'D:/One/a.txt', true, 'changed')]
    store.activeTabId = 'tab-a'

    await store.saveTab('tab-a')
    store.closeTab('tab-a')

    expect(store.explorerRevealRequestId).toBe(0)
    expect(store.explorerFocusedPath).toBeNull()
  })

  it('stores and restores scoped workspace state by reference', () => {
    const store = useWorkspaceStore()
    const cache = { 'D:/One': { path: 'D:/One', entries: [] } }
    const tabs = [textTab('a', 'D:/One/a.txt', false)]
    store.workspace = workspace('D:/One')
    store.directoryCache = cache
    store.tabs = tabs

    store.stashActiveWorkspaceState()
    const snapshot = store.workspaceSnapshots['d:/one']

    expect(snapshot.directoryCache).toBe(store.directoryCache)
    expect(snapshot.tabs).toBe(store.tabs)

    store.directoryCache = {}
    store.tabs = []
    store.restoreWorkspaceScopedState(workspace('D:/One'))

    expect(store.directoryCache).toBe(snapshot.directoryCache)
    expect(store.tabs).toBe(snapshot.tabs)
  })

  it('syncs visible CLI output into the conversation after a user message', async () => {
    mocks.isTauri.mockReturnValue(true)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'

    const send = store.sendTerminalConversationMessage('session-main', '现在回复我')
    await vi.advanceTimersByTimeAsync(250)
    await send
    store.appendTerminalConversationReply('session-main', '\u001b[32m已收到，我会处理。\u001b[0m\r\n')

    expect(store.terminalConversation['session-main'].map((message) => message.role)).toEqual(['user', 'system'])
    expect(store.terminalConversation['session-main'][1].content).toBe('已收到，我会处理。')
  })

  it('keeps a detected legacy encoding when editing and saving a file', async () => {
    const store = useWorkspaceStore()
    mocks.readEditorFile.mockResolvedValue({ content: '拒绝访问', encoding: 'gbk' })
    await store.openFile('D:/One/restart.log', { revealInExplorer: false })
    store.updateActiveTabContent('已修复')

    await store.saveActiveTab()

    expect(store.activeTab?.encoding).toBe('gbk')
    expect(mocks.writeEditorFile).toHaveBeenCalledWith('D:/One/restart.log', '已修复', 'gbk')
  })

  it('reopens using a selected encoding and blocks encoding changes for dirty tabs', async () => {
    const store = useWorkspaceStore()
    mocks.readEditorFile.mockResolvedValueOnce({ content: 'readable as UTF-8', encoding: 'utf-8' })
      .mockResolvedValueOnce({ content: '拒绝访问', encoding: 'gbk' })
    await store.openFile('D:/One/restart.log', { revealInExplorer: false })
    const tabId = store.activeTab!.id

    await expect(store.reopenTabWithEncoding(tabId, 'gbk')).resolves.toBe(true)
    expect(store.activeTab).toMatchObject({ content: '拒绝访问', encoding: 'gbk' })
    store.updateActiveTabContent('unsaved')
    await expect(store.reopenTabWithEncoding(tabId, 'utf-8')).resolves.toBe(false)
    expect(store.activeTab?.content).toBe('unsaved')
  })

  it('sends multiline AI prompts as one bracketed paste before a separate Enter', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'session-main', title: 'Claude', providerKind: 'claude', cwd: 'D:/One' }]

    const send = store.sendTerminalConversationMessage(
      'session-main',
      '请读取 D:/One/src/main.ts\n然后分两段说明结果',
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.writeTerminalInput).toHaveBeenCalledWith(
      'session-main',
      '\u001b[200~请读取 D:/One/src/main.ts\n然后分两段说明结果\u001b[201~',
    )
    expect(mocks.writeTerminalInput).not.toHaveBeenCalledWith('session-main', '\r')

    await vi.advanceTimersByTimeAsync(250)
    await expect(send).resolves.toBe(true)
    expect(mocks.writeTerminalInput).toHaveBeenLastCalledWith('session-main', '\r')
  })

  it('updates inactive and background terminal titles, including output before creation completes', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'title-active', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    store.workspaceSnapshots = {
      'd:/two': {
        ...scopedState('D:/Two'),
        terminalSessions: [{ id: 'title-background', title: 'Claude', providerKind: 'claude', cwd: 'D:/Two' }],
      },
    }
    store.queueTerminalOutput('title-active', '\x1b]2;前台\x07')
    store.queueTerminalOutput('title-background', '\x1b]2;后台')
    store.queueTerminalOutput('title-background', '任务\x1b\\')
    expect(store.terminalSessions[0].terminalTitle).toBe('前台')
    expect(store.workspaceSnapshots['d:/two'].terminalSessions[0].terminalTitle).toBe('后台任务')

    store.queueTerminalOutput('title-new', '\x1b]0;启动标题\x07')
    store.terminalSessions.push({ id: 'title-new', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' })
    store.setActiveTerminalSession('title-new')
    expect(store.activeCliTerminalSession?.terminalTitle).toBe('启动标题')
    await store.closeTerminalSession('title-new')
    store.terminalSessions.push({ id: 'title-new', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' })
    store.setActiveTerminalSession('title-new')
    expect(store.activeCliTerminalSession?.terminalTitle).toBeUndefined()
  })

  it('batches terminal output and cancels queued replies when the session closes', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    store.terminalConversation = {
      'session-main': [{ id: 'message-1', sessionId: 'session-main', role: 'user', content: '处理这个任务', timestamp: '2026-05-09T00:00:00Z' }],
    }
    store.terminalConversationReplyPending = { 'session-main': true }
    const planDetection = vi.spyOn(store, 'schedulePlanDetection')

    store.queueTerminalOutput('session-main', 'first ')
    store.queueTerminalOutput('session-main', 'second')
    await vi.advanceTimersByTimeAsync(79)

    expect(store.terminalConversation['session-main']).toHaveLength(1)
    expect(planDetection).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(store.terminalConversation['session-main']).toHaveLength(2)
    expect(store.terminalConversation['session-main'][1]?.content).toContain('first second')
    expect(planDetection).toHaveBeenCalledTimes(1)
    expect(planDetection).toHaveBeenLastCalledWith('session-main', 'first second')

    store.queueTerminalOutput('session-main', ' tail')
    await store.closeTerminalSession('session-main')
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.terminalConversation['session-main']).toBeUndefined()
    expect(store.terminalConversationReplyPending['session-main']).toBeUndefined()
    expect(planDetection).toHaveBeenCalledTimes(1)
  })

  it.each(['local', 'codex', 'claude', 'project-startup', 'project-service', 'minecraft-client'])('removes %s tabs on backend exit, including unknown exit codes', async (providerKind) => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'local-ended', title: 'PowerShell', providerKind, cwd: 'D:/One' }]
    store.activeTerminalSessionId = 'local-ended'
    store.activeLocalTerminalSessionId = 'local-ended'
    store.terminalDrafts['local-ended'] = '残留输入'

    mocks.isTauri.mockReturnValue(true)
    store.bindBackendEvents()
    const onExit = mocks.onTerminalExit.mock.calls.at(-1)![0]
    onExit({ sessionId: 'local-ended', exitCode: null })
    await Promise.resolve()

    expect(mocks.closeTerminal).toHaveBeenCalledWith('local-ended')
    expect(store.terminalSessions).toEqual([])
    expect(store.terminalDrafts['local-ended']).toBeUndefined()
    expect(store.activeTerminalSessionId).toBeNull()
    expect(store.activeLocalTerminalSessionId).toBeNull()
    store.unbindBackendEvents()
  })

  it('splits one oversized terminal event into 64 KiB Plan-detection batches', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    store.terminalConversation = {
      'session-main': [{ id: 'message-1', sessionId: 'session-main', role: 'user', content: '处理这个任务', timestamp: '2026-05-09T00:00:00Z' }],
    }
    store.terminalConversationReplyPending = { 'session-main': true }
    const planDetection = vi.spyOn(store, 'schedulePlanDetection')
    const output = 'x'.repeat(64 * 1024 + 1)

    store.queueTerminalOutput('session-main', output)
    await vi.advanceTimersByTimeAsync(80)

    expect(planDetection).toHaveBeenCalledTimes(1)
    expect(planDetection).toHaveBeenLastCalledWith('session-main', output.slice(0, 64 * 1024))

    await vi.advanceTimersByTimeAsync(15)
    expect(planDetection).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(planDetection).toHaveBeenCalledTimes(2)
    expect(planDetection).toHaveBeenLastCalledWith('session-main', 'x')
  })

  it('closing a CLI session removes related store state and active ids', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'cli-1', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' },
      { id: 'cli-2', title: 'Claude', providerKind: 'claude', cwd: 'D:/One' },
    ]
    store.activeTerminalSessionId = 'cli-1'
    store.activeCliSessionId = 'cli-1'
    store.terminalDrafts['cli-1'] = 'draft'
    store.terminalConversation['cli-1'] = [{
      id: 'message-1',
      sessionId: 'cli-1',
      role: 'user',
      content: 'hello',
      timestamp: '2026-05-09T00:00:00Z',
    }]

    await store.closeTerminalSession('cli-1')

    expect(mocks.closeTerminal).toHaveBeenCalledWith('cli-1')
    expect(store.terminalSessions.map((session) => session.id)).toEqual(['cli-2'])
    expect(store.activeTerminalSessionId).toBe('cli-2')
    expect(store.activeCliSessionId).toBe('cli-2')
    expect(store.terminalDrafts['cli-1']).toBeUndefined()
    expect(store.terminalConversation['cli-1']).toBeUndefined()
  })

  it('does not write terminal input when any decision is still pending', async () => {
    const store = useWorkspaceStore()
    store.cliPlans = {
      'session-1': [planProposal('session-1', [
        { key: 'step-1', title: 'Step 1', question: 'Proceed?', yesText: 'do it', noText: 'skip this', recommendation: 'do it', choice: 'pending' },
        { key: 'step-2', title: 'Step 2', question: 'Confirm?', yesText: 'yes', noText: 'no', recommendation: 'yes', choice: 'yes' },
      ])],
    }

    await store.submitPlanProposal('session-1', 'plan-sample')

    expect(mocks.writeTerminalInput).not.toHaveBeenCalled()
    expect(store.cliPlans['session-1']).toHaveLength(1)
  })

  it('writes terminal input when all decisions are non-pending', async () => {
    const store = useWorkspaceStore()
    store.cliPlans = {
      'session-1': [planProposal('session-1', [
        { key: 'step-1', title: 'Step 1', question: 'Proceed?', yesText: 'do it', noText: 'skip this', recommendation: 'do it', choice: 'yes' },
      ])],
    }

    await store.submitPlanProposal('session-1', 'plan-sample')

    expect(mocks.writeTerminalInput).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('采纳：do it'),
    )
    expect(mocks.writeTerminalInput.mock.calls[0][1]).toContain('请据此继续。')
  })

  it('includes the selected choice note in the plan receipt', async () => {
    const store = useWorkspaceStore()
    store.cliPlans = {
      'session-1': [planProposal('session-1', [
        { key: 'step-1', title: 'Step 1', question: 'Proceed?', yesText: 'do it', noText: 'skip this', recommendation: 'do it', choice: 'yes' },
      ])],
    }

    store.setPlanDecisionChoiceNote('session-1', 'plan-sample', 'step-1', 'yes', '只做最小改动')
    await store.submitPlanProposal('session-1', 'plan-sample')

    expect(mocks.writeTerminalInput.mock.calls[0][1]).toContain('补充：只做最小改动')
  })

  it('removes the plan from cliPlans on dismiss', () => {
    const store = useWorkspaceStore()
    store.cliPlans = {
      'session-1': [planProposal('session-1')],
    }

    store.dismissPlanProposal('session-1', 'plan-sample')

    expect(store.cliPlans['session-1'] ?? []).toHaveLength(0)
  })

  it('updates a decision choice via setPlanDecisionChoice', () => {
    const store = useWorkspaceStore()
    store.cliPlans = {
      'session-1': [planProposal('session-1')],
    }

    store.setPlanDecisionChoice('session-1', 'plan-sample', 'step-1', 'no')

    const decision = store.cliPlans['session-1'][0].decisions[0]
    expect(decision.choice).toBe('no')
  })
})


describe('file search request lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    mocks.searchProjectFiles.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('only searches the latest input after one short debounce', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/project')
    mocks.searchProjectFiles.mockResolvedValue({ files: [], textMatches: [] })
    const first = store.searchProject('app', 'app', { fileNameOnly: true })
    await vi.advanceTimersByTimeAsync(60)
    const last = store.searchProject('AppTopBar', 'AppTopBar', { fileNameOnly: true })
    await vi.advanceTimersByTimeAsync(120)
    await Promise.all([first, last])
    expect(mocks.searchProjectFiles).toHaveBeenCalledTimes(1)
    expect(mocks.searchProjectFiles).toHaveBeenCalledWith('AppTopBar', ['D:/project'], {
      fileNameOnly: true, includeText: false, limit: 80,
    })
    store.cancelSearch()
  })

  it('does not restore results or reopen the dropdown after dismissal', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/project')
    let finish!: (value: unknown) => void
    mocks.searchProjectFiles.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = store.searchProject('app')
    await vi.advanceTimersByTimeAsync(120)
    store.cancelSearch()
    store.searchOpen = false
    finish({ files: [{ path: 'D:/project/app.vue', name: 'app.vue', relativePath: 'app.vue' }], textMatches: [] })
    await pending
    expect(store.searchResults).toBeNull()
    expect(store.searchOpen).toBe(false)
    expect(store.searchLoading).toBe(false)
  })
})
