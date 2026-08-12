import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryListing, EditorTab, PlanProposal, Workspace } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  getSettings: vi.fn(),
  writeFile: vi.fn(),
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
  readImageAsDataUrl: vi.fn(),
  saveSettings: vi.fn(),
  listRecentProjects: vi.fn(),
  detectVitePressDocs: vi.fn(),
  createTerminalSession: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    getSettings: mocks.getSettings,
    writeFile: mocks.writeFile,
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
    readImageAsDataUrl: mocks.readImageAsDataUrl,
    saveSettings: mocks.saveSettings,
    listRecentProjects: mocks.listRecentProjects,
    detectVitePressDocs: mocks.detectVitePressDocs,
    createTerminalSession: mocks.createTerminalSession,
  },
  isTauri: mocks.isTauri,
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

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
describe('workspace dirty tab handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.isTauri.mockReset()
    mocks.getSettings.mockReset()
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
    mocks.isTauri.mockReturnValue(false)
    mocks.getSettings.mockResolvedValue({})
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.deletePath.mockResolvedValue(undefined)
    mocks.listDirectory.mockImplementation(async (path: string) => ({ path, entries: [] }))
    mocks.closeTerminal.mockResolvedValue(undefined)
    mocks.closeTerminalSessionsForWorkspace.mockResolvedValue(undefined)
    mocks.writeTerminalInput.mockResolvedValue(undefined)
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: '', startByte: 0, endByte: 0 })
    mocks.listLiveTerminalSessionIds.mockResolvedValue([])
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
      height: 620,
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

    expect(mocks.writeFile).toHaveBeenCalledWith('D:/One/a.txt', 'current')
    expect(mocks.writeFile).toHaveBeenCalledWith('D:/Two/a.txt', 'snapshot')
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
    mocks.isTauri.mockReturnValue(false)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.deletePath.mockResolvedValue(undefined)
    mocks.listDirectory.mockImplementation(async (path: string) => ({ path, entries: [] }))
    mocks.closeTerminal.mockResolvedValue(undefined)
    mocks.closeTerminalSessionsForWorkspace.mockResolvedValue(undefined)
    mocks.writeTerminalInput.mockResolvedValue(undefined)
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: '', startByte: 0, endByte: 0 })
    mocks.listLiveTerminalSessionIds.mockResolvedValue([])
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
      'D:/One/docs',
      'D:/One/docs/guide',
    ]

    await store.refreshExplorer('D:/One/docs')

    expect(mocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, 'D:/One/docs')
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(2, 'D:/One/docs/guide')
  })

  it('collapses every expanded directory, keeping only the root', () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.expandedPaths = [
      'D:/One',
      'D:/One/src',
      'D:/One/config',
      'D:/One/config/cards',
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

  it('ignores a delayed watcher event for the last confirmed write', async () => {
    const store = useWorkspaceStore()
    const tab = textTab('docs', 'D:/One/docs/guide/menu.yml', true, 'next draft')
    tab.lastKnownDiskContent = 'saved by editor'
    store.tabs = [tab]
    store.fileConflictPaths['d:/one/docs/guide/menu.yml'] = true
    mocks.readFile.mockResolvedValueOnce('saved by editor')

    await store.reloadOpenTabsForChangedPaths(
      store.tabs,
      new Set(['d:/one/docs/guide/menu.yml']),
    )

    expect(tab.content).toBe('next draft')
    expect(tab.isDirty).toBe(true)
    expect(store.fileConflictPaths['d:/one/docs/guide/menu.yml']).toBeUndefined()
  })

  it('keeps a dirty draft and reports a real external file change', async () => {
    const store = useWorkspaceStore()
    const tab = textTab('docs', 'D:/One/docs/guide/menu.yml', true, 'local draft')
    tab.lastKnownDiskContent = 'known disk content'
    store.tabs = [tab]
    mocks.readFile.mockResolvedValueOnce('external disk content')

    await store.reloadOpenTabsForChangedPaths(
      store.tabs,
      new Set(['d:/one/docs/guide/menu.yml']),
    )

    expect(tab.content).toBe('local draft')
    expect(tab.isDirty).toBe(true)
    expect(store.fileConflictPaths['d:/one/docs/guide/menu.yml']).toBe(true)
  })

  it('records clean preview content and clears mixed-case conflicts', () => {
    const store = useWorkspaceStore()
    const tab = textTab('docs', 'D:/One/docs/guide/Menu.yml', true, 'old')
    store.tabs = [tab]
    store.fileConflictPaths['d:/one/docs/guide/menu.yml'] = true

    const updated = store.setScopedCodePreviewContent(
      'd:/one/docs/guide/menu.yml',
      'saved by editor',
      { isDirty: false },
    )

    expect(updated).toBe(true)
    expect(tab.content).toBe('saved by editor')
    expect(tab.isDirty).toBe(false)
    expect(tab.lastKnownDiskContent).toBe('saved by editor')
    expect(store.fileConflictPaths['d:/one/docs/guide/menu.yml']).toBeUndefined()
  })

  it('reloads an open text tab from disk and resets its conflict baseline', async () => {
    const store = useWorkspaceStore()
    const tab = textTab('docs', 'D:/One/docs/guide/menu.yml', true, 'local draft')
    tab.lastKnownDiskContent = 'old disk content'
    store.tabs = [tab]
    store.activeTabId = tab.id
    store.fileConflictPaths['d:/one/docs/guide/menu.yml'] = true
    mocks.readFile.mockResolvedValueOnce('current disk content')

    await expect(store.reloadActiveTabFromDisk()).resolves.toBe(true)

    expect(tab.content).toBe('current disk content')
    expect(tab.isDirty).toBe(false)
    expect(tab.lastKnownDiskContent).toBe('current disk content')
    expect(store.fileConflictPaths['d:/one/docs/guide/menu.yml']).toBeUndefined()
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

  it('writes delayed terminal state for the original workspace snapshot', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.writeFile.mockResolvedValue(undefined)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.openWorkspacePaths = ['D:/One', 'D:/Two']
    store.terminalSessions = [{ id: 'session-one', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    store.terminalConversation = {
      'session-one': [{ id: 'msg-one', sessionId: 'session-one', role: 'user', content: 'One task', timestamp: '2026-05-09T00:00:00Z' }],
    }

    store.schedulePersistTerminalState()
    store.stashActiveWorkspaceState()
    store.restoreWorkspaceScopedState(workspace('D:/Two'))
    store.terminalSessions = [{ id: 'session-two', title: 'Codex', providerKind: 'codex', cwd: 'D:/Two' }]
    store.terminalConversation = {
      'session-two': [{ id: 'msg-two', sessionId: 'session-two', role: 'user', content: 'Two task', timestamp: '2026-05-09T00:00:00Z' }],
    }

    await vi.advanceTimersByTimeAsync(510)

    expect(mocks.writeFile).toHaveBeenCalledWith(
      'D:/One/.superhigh/terminal-state.json',
      expect.stringContaining('session-one'),
    )
    const saved = mocks.writeFile.mock.calls.find((call) => call[0] === 'D:/One/.superhigh/terminal-state.json')?.[1] as string
    expect(saved).not.toContain('session-two')
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
    expect(mocks.writeFile).toHaveBeenCalledWith(
      'D:/Two/.superhigh/terminal-state.json',
      expect.stringContaining('已完成后台任务'),
    )
  })

  it('clears persisted terminal state when closing a background workspace', async () => {
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
    const saved = mocks.writeFile.mock.calls.find((call) => call[0] === 'D:/Two/.superhigh/terminal-state.json')?.[1] as string
    expect(saved).toContain('"terminalSessions": []')
    expect(store.workspaceSnapshots['d:/two']).toBeUndefined()
  })

  it('restores visible ended CLI history from disk without treating it as a live terminal', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      savedAt: '2026-05-09T00:00:00Z',
      terminalSessions: [{ id: 'session-old', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }],
      activeTerminalSessionId: 'session-old',
      activeCliSessionId: 'session-old',
      activeLocalTerminalSessionId: null,
      terminalDrafts: {},
      terminalConversation: {
        'session-old': [{ id: 'msg-old', sessionId: 'session-old', role: 'user', content: '历史任务', timestamp: '2026-05-09T00:00:00Z' }],
      },
      terminalExitCodes: {},
    }))
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')

    await store.loadPersistedTerminalState('D:/One')

    expect(mocks.listLiveTerminalSessionIds).toHaveBeenCalledOnce()
    expect(store.terminalSessions[0].restoredFromDisk).toBe(true)
    expect(store.cliTerminalSessions.map((session) => session.id)).toEqual(['session-old'])
    expect(store.activeCliSessionId).toBe('session-old')
    expect(store.activeCliTerminalSession?.id).toBe('session-old')
    expect(store.activeTerminalSession).toBeNull()
    expect(store.terminalExitCodes['session-old']).toBe(0)
    expect(store.terminalConversation['session-old'][0].content).toBe('历史任务')
  })

  it('drops stale project-managed terminal sessions instead of restoring dead service tabs', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.listLiveTerminalSessionIds.mockResolvedValue([])
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      savedAt: '2026-05-09T00:00:00Z',
      terminalSessions: [{ id: 'server-old', title: '示例服务端', providerKind: 'project-service', cwd: 'D:/Server' }],
      activeTerminalSessionId: 'server-old',
      activeCliSessionId: null,
      activeLocalTerminalSessionId: 'server-old',
      terminalDrafts: {},
      terminalConversation: {},
      terminalExitCodes: {},
    }))
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')

    await store.loadPersistedTerminalState('D:/One')

    expect(store.terminalSessions).toEqual([])
    expect(store.activeLocalTerminalSessionId).toBeNull()
  })

  it('reattaches live project service sessions and rebuilds the service run state', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.listLiveTerminalSessionIds.mockResolvedValue(['server-live'])
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      savedAt: '2026-05-09T00:00:00Z',
      terminalSessions: [{ id: 'server-live', title: '示例服务端', providerKind: 'project-service', cwd: 'D:/Server' }],
      activeTerminalSessionId: 'server-live',
      activeCliSessionId: null,
      activeLocalTerminalSessionId: 'server-live',
      terminalDrafts: {},
      terminalConversation: {},
      terminalExitCodes: {},
    }))
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.projectStartupConfig = {
      name: '示例服务端',
      mode: 'services',
      services: [
        { id: 'server', name: '示例服务端', scriptPath: 'D:/Server/start.bat', args: [], workingDirectory: 'D:/Server', startAfter: [] },
      ],
    }

    await store.loadPersistedTerminalState('D:/One')

    expect(store.terminalSessions[0].restoredFromDisk).toBeUndefined()
    expect(store.projectServiceRun?.services.server).toEqual({
      serviceId: 'server',
      status: 'running',
      sessionId: 'server-live',
      message: null,
    })
    expect(store.projectServiceRun?.chainStatus).toBe('running')
  })

  it('reattaches persisted CLI sessions that are still live in the backend', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.listLiveTerminalSessionIds.mockResolvedValue(['session-live'])
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      savedAt: '2026-05-09T00:00:00Z',
      terminalSessions: [{ id: 'session-live', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }],
      activeTerminalSessionId: 'session-live',
      activeCliSessionId: 'session-live',
      activeLocalTerminalSessionId: null,
      terminalDrafts: { 'session-live': '继续处理' },
      terminalConversation: {
        'session-live': [{ id: 'msg-live', sessionId: 'session-live', role: 'user', content: '正在运行', timestamp: '2026-05-09T00:00:00Z' }],
      },
      terminalExitCodes: { 'session-live': 1 },
    }))
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')

    await store.loadPersistedTerminalState('D:/One')

    expect(store.terminalSessions[0].restoredFromDisk).toBeUndefined()
    expect(store.activeTerminalSessionId).toBe('session-live')
    expect(store.activeCliSessionId).toBe('session-live')
    expect(store.activeTerminalSession?.id).toBe('session-live')
    expect(store.activeCliTerminalSession?.id).toBe('session-live')
    expect(store.terminalExitCodes['session-live']).toBeNull()

    await expect(store.sendTerminalConversationMessage('session-live', '继续')).resolves.toBe(true)
    expect(mocks.writeTerminalInput).toHaveBeenCalledWith('session-live', '继续\r')
  })

  it('allows selecting and deleting restored CLI history without closing a nonexistent backend terminal', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.terminalSessions = [
      { id: 'session-live', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' },
      { id: 'session-old', title: 'Codex', providerKind: 'codex', cwd: 'D:/One', restoredFromDisk: true },
    ]
    store.activeTerminalSessionId = 'session-live'

    store.setActiveTerminalSession('session-old')

    expect(store.activeCliSessionId).toBe('session-old')
    expect(store.activeCliTerminalSession?.id).toBe('session-old')
    expect(store.activeTerminalSessionId).toBeNull()

    await expect(store.sendTerminalConversationMessage('session-old', '继续')).resolves.toBe(false)
    expect(mocks.writeTerminalInput).not.toHaveBeenCalledWith(expect.anything(), 'session-old')

    await store.closeTerminalSession('session-old')

    expect(mocks.closeTerminal).not.toHaveBeenCalledWith('session-old')
    expect(store.cliTerminalSessions.map((session) => session.id)).toEqual(['session-live'])
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

    await store.sendTerminalConversationMessage('session-main', '现在回复我')
    store.appendTerminalConversationReply('session-main', '\u001b[32m已收到，我会处理。\u001b[0m\r\n')

    expect(store.terminalConversation['session-main'].map((message) => message.role)).toEqual(['user', 'system'])
    expect(store.terminalConversation['session-main'][1].content).toBe('已收到，我会处理。')
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
    store.terminalExitCodes['cli-1'] = 0

    await store.closeTerminalSession('cli-1')

    expect(mocks.closeTerminal).toHaveBeenCalledWith('cli-1')
    expect(store.terminalSessions.map((session) => session.id)).toEqual(['cli-2'])
    expect(store.activeTerminalSessionId).toBe('cli-2')
    expect(store.activeCliSessionId).toBe('cli-2')
    expect(store.terminalDrafts['cli-1']).toBeUndefined()
    expect(store.terminalConversation['cli-1']).toBeUndefined()
    expect(store.terminalExitCodes['cli-1']).toBeUndefined()
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
