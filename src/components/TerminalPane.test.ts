import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TerminalPane from './TerminalPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { promptHistoryCache } from '@/lib/promptHistoryCache'

const mocks = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  enhancePromptWithCodex: vi.fn(),
  codexRendererInstances: [] as unknown[],
  createProjectStartupTerminalSession: vi.fn(),
  extractPastedImagesFromClipboardApi: vi.fn(),
  extractPastedImagesFromClipboardEvent: vi.fn(),
  getTerminalBuffer: vi.fn(),
  getProjectStartupConfig: vi.fn(),
  isFile: vi.fn(),
  isTauri: vi.fn(),
  listSkills: vi.fn(),
  listWorkspacePromptHistory: vi.fn(),
  onTerminalOutput: vi.fn(),
  openExternalCli: vi.fn(),
  openExternalCliSession: vi.fn(),
  openUrl: vi.fn(),
  resizeTerminal: vi.fn(),
  resolveTerminalPath: vi.fn(),
  savePastedImage: vi.fn(),
  saveSettings: vi.fn(),
  terminalInstances: [] as Array<{
    options: Record<string, unknown>
    parser: {
      registerCsiHandler: ReturnType<typeof vi.fn>
    }
    buffer: {
      active: {
        length: number
        getLine: ReturnType<typeof vi.fn>
      }
    }
    scrollLines: ReturnType<typeof vi.fn>
    registerLinkProvider: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
  }>,
  webglInstances: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  writeTerminalInput: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    element: HTMLElement | null = null
    rows = 24
    options: Record<string, unknown> = {}
    parser = {
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
    }
    buffer = {
      active: {
        length: 0,
        getLine: vi.fn(),
      },
    }
    loadAddon = vi.fn((addon: { activate?: (terminal: unknown) => void }) => {
      addon.activate?.(this)
    })
    open = vi.fn((host: HTMLElement) => {
      const element = document.createElement('div')
      element.className = 'xterm'
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      element.append(viewport, screen)
      host.appendChild(element)
      this.element = element
    })
    onData = vi.fn()
    onSelectionChange = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    write = vi.fn((_data: string, callback?: () => void) => callback?.())
    reset = vi.fn()
    focus = vi.fn()
    scrollLines = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      mocks.terminalInstances.push(this)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    terminal: { cols: number; rows: number; element: HTMLElement | null } | null = null
    activate = vi.fn((terminal: { cols: number; rows: number; element: HTMLElement | null }) => {
      this.terminal = terminal
    })
    fit = vi.fn(() => {
      const host = this.terminal?.element?.parentElement
      if (!this.terminal || !host) return
      this.terminal.cols = Math.max(1, Math.floor(host.offsetWidth / 8))
      this.terminal.rows = Math.max(1, Math.floor(host.offsetHeight / 18))
    })
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = vi.fn()
    dispose = vi.fn()
    constructor() { mocks.webglInstances.push(this) }
  },
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    closeTerminal: mocks.closeTerminal,
    enhancePromptWithCodex: mocks.enhancePromptWithCodex,
    createProjectStartupTerminalSession: mocks.createProjectStartupTerminalSession,
    getTerminalBuffer: mocks.getTerminalBuffer,
    getProjectStartupConfig: mocks.getProjectStartupConfig,
    isFile: mocks.isFile,
    listSkills: mocks.listSkills,
    listWorkspacePromptHistory: mocks.listWorkspacePromptHistory,
    openExternalCli: mocks.openExternalCli,
    openExternalCliSession: mocks.openExternalCliSession,
    openUrl: mocks.openUrl,
    savePastedImage: mocks.savePastedImage,
    saveSettings: mocks.saveSettings,
    resizeTerminal: mocks.resizeTerminal,
    resolveTerminalPath: mocks.resolveTerminalPath,
    writeTerminalInput: mocks.writeTerminalInput,
  },
  isTauri: mocks.isTauri,
  onTerminalOutput: mocks.onTerminalOutput,
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
  loadMonaco: vi.fn(),
}))

vi.mock('@/lib/cliImagePaste', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cliImagePaste')>('@/lib/cliImagePaste')
  return {
    ...actual,
    extractPastedImagesFromClipboardApi: mocks.extractPastedImagesFromClipboardApi,
    extractPastedImagesFromClipboardEvent: mocks.extractPastedImagesFromClipboardEvent,
  }
})

function mountPane(pinia: Pinia, props: Record<string, unknown>) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({
    render: () => h(TerminalPane, props),
}))

vi.mock('@/lib/codexTerminalRenderer', () => ({
  CodexTerminalRenderer: class {
    render = vi.fn((data: string) => data)
    resize = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()

    constructor() {
      mocks.codexRendererInstances.push(this)
    }
  },
}))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

describe('TerminalPane', () => {
  let pinia: Pinia

  beforeEach(() => {
    promptHistoryCache.clear()
    pinia = createPinia()
    setActivePinia(pinia)
    mocks.closeTerminal.mockReset()
    mocks.closeTerminal.mockResolvedValue(undefined)
    mocks.enhancePromptWithCodex.mockReset()
    mocks.codexRendererInstances.length = 0
    mocks.createProjectStartupTerminalSession.mockReset()
    mocks.getTerminalBuffer.mockReset()
    mocks.getProjectStartupConfig.mockReset()
    mocks.isFile.mockReset()
    mocks.isTauri.mockReset()
    mocks.listSkills.mockReset()
    mocks.listWorkspacePromptHistory.mockReset()
    mocks.listWorkspacePromptHistory.mockResolvedValue([])
    mocks.onTerminalOutput.mockReset()
    mocks.openExternalCli.mockReset()
    mocks.openExternalCliSession.mockReset()
    mocks.openUrl.mockReset()
    mocks.openUrl.mockResolvedValue(undefined)
    mocks.resizeTerminal.mockReset()
    mocks.saveSettings.mockReset()
    mocks.savePastedImage.mockReset()
    mocks.extractPastedImagesFromClipboardApi.mockReset()
    mocks.extractPastedImagesFromClipboardEvent.mockReset()
    mocks.terminalInstances.length = 0
    mocks.writeTerminalInput.mockReset()
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: '', startByte: 0, endByte: 0 })
    mocks.isTauri.mockReturnValue(false)
    mocks.listSkills.mockResolvedValue([])
    mocks.onTerminalOutput.mockResolvedValue(() => undefined)
    mocks.openExternalCli.mockResolvedValue(undefined)
    mocks.openExternalCliSession.mockResolvedValue(undefined)
    mocks.enhancePromptWithCodex.mockResolvedValue('增强后的提示词')
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.savePastedImage.mockResolvedValue('D:/Demo Files/.superhigh/pasted-images/paste-test.png')
    mocks.extractPastedImagesFromClipboardApi.mockResolvedValue([])
    mocks.extractPastedImagesFromClipboardEvent.mockResolvedValue([])

    class MockResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
    class MockIntersectionObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  it('shows configured project startup control in local terminal mode', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目目录名服务端',
      scriptPath: 'D:/示例项目/示例项目目录名服务端/天灾服务端开启.bat',
      workingDirectory: 'D:/示例项目/示例项目目录名服务端',
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务端')

    app.unmount()
    root.remove()
  })

  it('opens OSC 8 terminal hyperlinks through the system browser without xterm confirmation', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const linkHandler = mocks.terminalInstances[0]?.options.linkHandler as {
      activate: (event: MouseEvent, url: string) => void
      allowNonHttpProtocols: boolean
    }
    linkHandler.activate(new MouseEvent('click'), 'https://learn.chatgpt.com/docs/windows/windows-app')
    await flushPromises()

    expect(linkHandler.allowNonHttpProtocols).toBe(false)
    expect(mocks.openUrl).toHaveBeenCalledWith('https://learn.chatgpt.com/docs/windows/windows-app')

    app.unmount()
    root.remove()
  })

  it('starts the configured project server from the startup control', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目目录名服务端',
      scriptPath: 'D:/示例项目/示例项目目录名服务端/天灾服务端开启.bat',
      workingDirectory: 'D:/示例项目/示例项目目录名服务端',
    }
    const spy = vi.spyOn(store, 'createProjectStartupTerminalSession').mockResolvedValue({
      id: 'server-1',
      title: '示例项目目录名服务端',
      providerKind: 'project-startup',
      cwd: 'D:/示例项目/示例项目目录名服务端',
    })

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()
    ;(Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('启动服务端')) as HTMLButtonElement).click()
    await flushPromises()

    expect(spy).toHaveBeenCalledTimes(1)

    app.unmount()
    root.remove()
  })

  it('shows the configured service chain and starts it from the local terminal', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目完整服务链',
      mode: 'services',
      services: [
        { id: 'mysql', name: 'MySQL', commandPath: 'D:/mysql/mysqld.exe', args: [], workingDirectory: 'D:/mysql', startAfter: [] },
        { id: 'bc', name: 'BC 代理', scriptPath: 'D:/bc/start.bat', args: [], workingDirectory: 'D:/bc', startAfter: ['mysql'] },
      ],
    }
    const spy = vi.spyOn(store, 'startProjectServices').mockResolvedValue({
      projectPath: 'D:/Tide/plugins',
      runId: 'run-tide',
      services: [],
    })

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务链')
    ;(Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('启动服务链')) as HTMLButtonElement).click()
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)

    app.unmount()
    root.remove()
  })

  it('keeps PowerShell available alongside the service chain', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目完整服务链',
      mode: 'services',
      services: [
        { id: 'mysql', name: 'MySQL', commandPath: 'D:/mysql/mysqld.exe', args: [], workingDirectory: 'D:/mysql', startAfter: [] },
      ],
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务链')
    expect(root.textContent).toContain('新建 PowerShell')
    expect(root.textContent).not.toContain('服务端日志(GBK)')

    app.unmount()
    root.remove()
  })

  it('uses the service name instead of its internal provider kind in the terminal tab', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目完整服务链',
      mode: 'services',
      services: [
        { id: 'mysql', name: 'MySQL', commandPath: 'D:/mysql/mysqld.exe', args: [], workingDirectory: 'D:/mysql', startAfter: [] },
      ],
    }
    store.projectServiceRun = {
      projectPath: 'D:/Tide/plugins',
      runId: 'run-tide',
      chainStatus: 'running',
      services: {
        mysql: { serviceId: 'mysql', status: 'running', sessionId: 'mysql-session' },
      },
    }
    store.terminalSessions = [{
      id: 'mysql-session',
      title: 'MySQL',
      providerKind: 'project-service',
      cwd: 'D:/mysql',
    }]
    store.activeTerminalSessionId = 'mysql-session'
    store.activeLocalTerminalSessionId = 'mysql-session'

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()
    await flushPromises()

    expect(root.querySelector('.terminal-tab-name')?.textContent).toContain('MySQL')
    expect(root.querySelector('.terminal-tab-name')?.textContent).not.toContain('project-service')
    expect(root.querySelector('.terminal-tab-state')?.textContent).toContain('运行中')
    expect(root.querySelector('.project-service-summary')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('shows an external service only as a compact status summary', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目完整服务链',
      mode: 'services',
      services: [
        { id: 'mysql', name: 'MySQL', commandPath: 'D:/mysql/mysqld.exe', args: [], workingDirectory: 'D:/mysql', startAfter: [] },
      ],
    }
    store.projectServiceRun = {
      projectPath: 'D:/Tide/plugins',
      runId: 'run-tide',
      chainStatus: 'running',
      services: {
        mysql: { serviceId: 'mysql', status: 'externalRunning', sessionId: null },
      },
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('外部运行')
    expect(root.querySelector('.project-service-summary')?.textContent).toContain('MySQL 外部运行')
    expect(root.querySelector('.project-service-summary button')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('does not attach a startup session to a workspace selected while startup was pending', async () => {
    const store = useWorkspaceStore()
    let resolveStartup: (session: {
      id: string
      title: string
      providerKind: string
      cwd: string
    }) => void = () => undefined
    mocks.createProjectStartupTerminalSession.mockImplementation(() => new Promise((resolve) => {
      resolveStartup = resolve
    }))
    store.workspace = {
      id: 'workspace-a',
      name: 'A',
      displayName: 'A',
      rootPath: 'D:/A',
      openedAt: '2026-07-15T00:00:00Z',
    }

    const startup = store.createProjectStartupTerminalSession()
    await flushPromises()

    store.workspace = {
      id: 'workspace-b',
      name: 'B',
      displayName: 'B',
      rootPath: 'D:/B',
      openedAt: '2026-07-15T00:00:00Z',
    }
    store.terminalSessions = [{
      id: 'b-terminal',
      title: 'PowerShell',
      providerKind: 'local',
      cwd: 'D:/B',
    }]
    store.activeTerminalSessionId = 'b-terminal'
    store.activeLocalTerminalSessionId = 'b-terminal'

    resolveStartup({
      id: 'a-startup',
      title: 'A 服务端',
      providerKind: 'project-startup',
      cwd: 'D:/A',
    })
    await startup

    expect(store.terminalSessions.map((session) => session.id)).toEqual(['b-terminal'])
    expect(store.activeTerminalSessionId).toBe('b-terminal')
    expect(mocks.closeTerminal).toHaveBeenCalledWith('a-startup')
  })

  it('closes the live project startup session from the startup control', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目目录名服务端',
      scriptPath: 'D:/示例项目/示例项目目录名服务端/天灾服务端开启.bat',
      workingDirectory: 'D:/示例项目/示例项目目录名服务端',
    }
    store.terminalSessions = [{
      id: 'server-1',
      title: '示例项目目录名服务端',
      providerKind: 'project-startup',
      cwd: 'D:/示例项目/示例项目目录名服务端',
    }]
    const spy = vi.spyOn(store, 'closeTerminalSession').mockResolvedValue()

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()
    ;(Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('关闭服务端')) as HTMLButtonElement).click()
    await flushPromises()

    expect(spy).toHaveBeenCalledWith('server-1')

    app.unmount()
    root.remove()
  })

  it('starts a new project server when the previous startup session has exited', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目目录名服务端',
      scriptPath: 'D:/示例项目/示例项目目录名服务端/天灾服务端开启.bat',
      workingDirectory: 'D:/示例项目/示例项目目录名服务端',
    }
    store.terminalSessions = [{
      id: 'server-exited',
      title: '示例项目目录名服务端',
      providerKind: 'project-startup',
      cwd: 'D:/示例项目/示例项目目录名服务端',
    }]
    store.terminalExitCodes = { 'server-exited': 0 }
    const createSpy = vi.spyOn(store, 'createProjectStartupTerminalSession').mockResolvedValue({
      id: 'server-2',
      title: '示例项目目录名服务端',
      providerKind: 'project-startup',
      cwd: 'D:/示例项目/示例项目目录名服务端',
    })
    const closeSpy = vi.spyOn(store, 'closeTerminalSession').mockResolvedValue()

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务端')
    expect(root.textContent).not.toContain('关闭服务端')
    ;(Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('启动服务端')) as HTMLButtonElement).click()
    await flushPromises()

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(closeSpy).not.toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('does not apply a late project startup config after switching workspaces', async () => {
    const store = useWorkspaceStore()
    const resolvers: Array<(value: {
      name: string
      scriptPath: string
      workingDirectory: string
    } | null) => void> = []
    mocks.isTauri.mockReturnValue(true)
    mocks.getProjectStartupConfig.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    store.workspace = {
      id: 'workspace-a',
      name: 'A',
      displayName: 'A',
      rootPath: 'D:/A',
      openedAt: '2026-07-15T00:00:00Z',
    }

    const refreshA = store.refreshProjectStartupConfig()
    await flushPromises()
    store.projectStartupConfig = {
      name: 'A 服务端',
      scriptPath: 'D:/A/start.bat',
      workingDirectory: 'D:/A',
    }
    store.projectStartupConfigRootPath = 'D:/A'
    store.workspace = {
      id: 'workspace-b',
      name: 'B',
      displayName: 'B',
      rootPath: 'D:/B',
      openedAt: '2026-07-15T00:00:00Z',
    }

    const refreshB = store.refreshProjectStartupConfig()
    await flushPromises()

    expect(store.projectStartupConfig).toBeNull()
    expect(store.projectStartupConfigRootPath).toBe('D:/B')

    resolvers[0]({
      name: 'A 服务端',
      scriptPath: 'D:/A/start.bat',
      workingDirectory: 'D:/A',
    })
    await refreshA

    expect(store.projectStartupConfig).toBeNull()
    expect(store.projectStartupConfigRootPath).toBe('D:/B')

    resolvers[1]({
      name: 'B 服务端',
      scriptPath: 'D:/B/start.bat',
      workingDirectory: 'D:/B',
    })
    await refreshB

    expect(store.projectStartupConfig?.name).toBe('B 服务端')
  })

  it('does not apply an older startup config after switching from A to B and back to A', async () => {
    const store = useWorkspaceStore()
    const resolvers: Array<(value: {
      name: string
      scriptPath: string
      workingDirectory: string
    } | null) => void> = []
    mocks.isTauri.mockReturnValue(true)
    mocks.getProjectStartupConfig.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    store.workspace = {
      id: 'workspace-a',
      name: 'A',
      displayName: 'A',
      rootPath: 'D:/A',
      openedAt: '2026-07-15T00:00:00Z',
    }
    const firstRefreshA = store.refreshProjectStartupConfig()
    await flushPromises()

    store.workspace = {
      id: 'workspace-b',
      name: 'B',
      displayName: 'B',
      rootPath: 'D:/B',
      openedAt: '2026-07-15T00:00:00Z',
    }
    const refreshB = store.refreshProjectStartupConfig()
    await flushPromises()

    store.workspace = {
      id: 'workspace-a',
      name: 'A',
      displayName: 'A',
      rootPath: 'D:/A',
      openedAt: '2026-07-15T00:00:00Z',
    }
    const secondRefreshA = store.refreshProjectStartupConfig()
    await flushPromises()

    resolvers[2]({
      name: '新版 A 服务端',
      scriptPath: 'D:/A/new-start.bat',
      workingDirectory: 'D:/A',
    })
    await secondRefreshA

    expect(store.projectStartupConfig?.name).toBe('新版 A 服务端')
    expect(store.projectStartupConfigLoading).toBe(false)

    resolvers[0]({
      name: '旧版 A 服务端',
      scriptPath: 'D:/A/old-start.bat',
      workingDirectory: 'D:/A',
    })
    await firstRefreshA

    expect(store.projectStartupConfig?.name).toBe('新版 A 服务端')
    expect(store.projectStartupConfigLoading).toBe(false)

    resolvers[1](null)
    await refreshB
  })

  it('does not show a startup control when the project has no startup config', async () => {
    const store = useWorkspaceStore()
    mocks.isTauri.mockReturnValue(true)
    mocks.getProjectStartupConfig.mockResolvedValue(null)
    mocks.isFile.mockResolvedValue(false)
    store.workspace = {
      id: 'workspace-without-config',
      name: 'No Config',
      displayName: 'No Config',
      rootPath: 'D:/NoConfig',
      openedAt: '2026-07-15T00:00:00Z',
    }
    const showErrorMessage = vi.spyOn(store, 'showErrorMessage')

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await flushPromises()
    await nextTick()

    expect(root.textContent).not.toContain('启动服务端')
    expect(showErrorMessage).not.toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('does not duplicate the project new-conversation action in the CLI pane toolbar', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    expect(root.textContent).not.toContain('新建对话')
    expect(root.querySelector('.terminal-actions')?.textContent).toContain('Codex')

    app.unmount()
    root.remove()
  })

  it('does not duplicate the project new-conversation action in the CLI empty state', async () => {
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    await flushPromises()
    await nextTick()

    expect(root.textContent).not.toContain('新建对话')
    expect(root.querySelector('.terminal-empty-actions')?.textContent).toContain('Codex')

    app.unmount()
    root.remove()
  })

  it('opens a CLI in external CMD on right click and keeps left click embedded', async () => {
    const store = useWorkspaceStore()
    store.workspace = {
      id: 'workspace-main',
      name: 'Super High',
      displayName: 'Super High',
      rootPath: 'D:/Demo Files',
      openedAt: '2026-07-31T00:00:00Z',
    }
    const createTerminalSession = vi.spyOn(store, 'createTerminalSession').mockResolvedValue(undefined)

    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    const codexButton = Array.from(root.querySelectorAll<HTMLButtonElement>('.terminal-empty-actions button'))
      .find((button) => button.textContent?.includes('Codex'))
    expect(codexButton).toBeTruthy()

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    codexButton?.dispatchEvent(contextMenu)
    await flushPromises()

    expect(contextMenu.defaultPrevented).toBe(true)
    expect(mocks.openExternalCli).toHaveBeenCalledWith('codex', 'D:/Demo Files')
    expect(createTerminalSession).not.toHaveBeenCalled()

    codexButton?.click()
    await flushPromises()
    expect(createTerminalSession).toHaveBeenCalledWith('codex', expect.objectContaining({ cwd: '' }))

    app.unmount()
    root.remove()
  })

  it('keeps Codex wheel events for xterm native handling', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 })
    root.querySelector('.xterm-screen')?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(mocks.terminalInstances[0]?.scrollLines).not.toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('shows PowerShell alongside the server and client start actions in the local terminal toolbar', async () => {
    const store = useWorkspaceStore()
    store.projectTerminalActions = [
      { id: 'server-start', label: '启动服务端', kind: 'start-project', startAfterCommand: false, restartDelayMs: 5000 },
      { id: 'server-restart', label: '重启服务端', kind: 'restart-project', startAfterCommand: true, restartDelayMs: 5000 },
      { id: 'client-start', label: '启动客户端', kind: 'minecraft-client', operation: 'start', startAfterCommand: false, restartDelayMs: 5000 },
      { id: 'client-restart', label: '重启客户端', kind: 'minecraft-client', operation: 'restart', startAfterCommand: false, restartDelayMs: 5000 },
    ]
    store.projectServiceRun = {
      projectPath: 'D:/One',
      runId: 'run-1',
      chainStatus: 'running',
      services: {},
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    const labels = Array.from(root.querySelectorAll<HTMLButtonElement>('.terminal-actions button'))
      .map((button) => button.textContent?.trim())
    expect(labels).toEqual(['新建 PowerShell', '启动服务端', '启动客户端'])

    app.unmount()
    root.remove()
  })

  it('moves the active Codex conversation to an external terminal', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()

    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent?.includes('移到外部继续'))
    button?.click()
    await flushPromises()

    expect(mocks.openExternalCliSession).toHaveBeenCalledWith('session-main')
    expect(mocks.closeTerminal).toHaveBeenCalledWith('session-main')
    expect(store.terminalSessions).toEqual([])

    app.unmount()
    root.remove()
  })

  it('does not move a Codex conversation while a reply is still running', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversationReplyPending['session-main'] = true

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()

    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent?.includes('移到外部继续'))
    expect(button?.disabled).toBe(true)
    expect(button?.title).toContain('仍在生成')
    button?.click()
    await flushPromises()

    expect(mocks.openExternalCliSession).not.toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('opens a verified CLI terminal path in the normal code preview', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.settings.activePreviewMode = 'local_terminal'
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\analysis.json'
    mocks.isFile.mockResolvedValue(true)
    mocks.resolveTerminalPath.mockResolvedValue({ path, isFile: true })

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const terminal = mocks.terminalInstances[0]
    terminal.buffer.active.length = 1
    terminal.buffer.active.getLine.mockReturnValue({
      isWrapped: false,
      translateToString: () => `"${path}"`,
      getCell: (column: number) => {
        const char = `"${path}"`[column]
        return char === undefined ? undefined : { getChars: () => char, getWidth: () => 1 }
      },
    })
    const provider = terminal.registerLinkProvider.mock.calls[0]?.[0] as {
      provideLinks: (line: number, callback: (links: Array<{ activate: (event: MouseEvent, text: string) => void }> | undefined) => void) => void
    }
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const link = callback.mock.calls[0]?.[0]?.[0]
    expect(link).toBeTruthy()
    link.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path, {
      createUnsupportedTabOnError: false,
      verifyExistingFile: true,
    }))
    expect(store.settings.activePreviewMode).toBe('code')

    app.unmount()
    root.remove()
  })

  it.each(['jar', 'JAR', 'MP4', 'mp3'])('routes a verified .%s CLI link through the shared file opener', async (extension) => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.settings.activePreviewMode = 'local_terminal'
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    const openPath = vi.spyOn(store, 'openPath').mockResolvedValue(undefined)
    const path = `D:/示例项目/示例项目目录名服务端/plugins/反编译/workspaces/GermExtract/build/libs/GermExtract-0.7.0.${extension}`
    mocks.isFile.mockResolvedValue(true)
    mocks.resolveTerminalPath.mockResolvedValue({ path, isFile: true })

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const terminal = mocks.terminalInstances[0]
    terminal.buffer.active.length = 1
    terminal.buffer.active.getLine.mockReturnValue({
      isWrapped: false,
      translateToString: () => `"${path}"`,
      getCell: (column: number) => {
        const char = `"${path}"`[column]
        return char === undefined ? undefined : { getChars: () => char, getWidth: () => 1 }
      },
    })
    const provider = terminal.registerLinkProvider.mock.calls[0]?.[0] as {
      provideLinks: (line: number, callback: (links: Array<{ activate: (event: MouseEvent, text: string) => void }> | undefined) => void) => void
    }
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const link = callback.mock.calls[0]?.[0]?.[0]
    expect(link).toBeTruthy()
    link.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path, { createUnsupportedTabOnError: false, verifyExistingFile: true }))
    expect(openPath).not.toHaveBeenCalled()
    expect(store.settings.activePreviewMode).toBe('code')

    app.unmount()
    root.remove()
  })

  it('streams split Codex inline-history bytes to xterm without rewriting them', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    const outputListener = mocks.onTerminalOutput.mock.calls.at(-1)?.[0]
    const firstChunk = '\x1b[1;20r\x1b['
    const secondChunk = '20;1H\r\nfinalized transcript\x1b[r'
    outputListener?.({
      sessionId: 'session-main',
      chunk: firstChunk,
      startByte: 0,
      endByte: firstChunk.length,
    })
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    outputListener?.({
      sessionId: 'session-main',
      chunk: secondChunk,
      startByte: firstChunk.length,
      endByte: firstChunk.length + secondChunk.length,
    })
    await new Promise((resolve) => window.setTimeout(resolve, 20))

    const writes = mocks.terminalInstances[0]?.write.mock.calls.map(([data]) => String(data)).join('') ?? ''
    expect(writes).toContain('\x1b[1;20r\x1b[20;1H\r\nfinalized transcript\x1b[r')
    expect(writes).not.toContain('\x1b[1;24r\x1b[24;1H')
    expect(mocks.terminalInstances[0]?.parser.registerCsiHandler).not.toHaveBeenCalled()
    expect(mocks.terminalInstances[0]?.options).toMatchObject({
      scrollback: 10_000,
      scrollSensitivity: 1.25,
    })
    expect(root.querySelector('.terminal-host')?.classList.contains('codex-terminal-host')).toBe(true)

    app.unmount()
    root.remove()
  })

  it('waits for each xterm write callback before rendering queued output and keeps a closed DEC 2026 frame whole', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const terminal = mocks.terminalInstances[0]!
    const callbacks: Array<() => void> = []
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      if (callback) callbacks.push(callback)
    })
    const outputListener = mocks.onTerminalOutput.mock.calls.at(-1)?.[0]
    const frame = `\x1b[?2026h${'x'.repeat(128 * 1024)}\x1b[?2026l`
    const nextFrame = '\x1b[?2026hnext frame\x1b[?2026l'

    outputListener?.({ sessionId: 'session-main', chunk: 'first', startByte: 0, endByte: 5 })
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    outputListener?.({ sessionId: 'session-main', chunk: 'second', startByte: 5, endByte: 11 })
    outputListener?.({ sessionId: 'session-main', chunk: 'third', startByte: 11, endByte: 16 })
    outputListener?.({ sessionId: 'session-main', chunk: frame, startByte: 16, endByte: 16 + frame.length })
    outputListener?.({ sessionId: 'session-main', chunk: nextFrame, startByte: 16 + frame.length, endByte: 16 + frame.length + nextFrame.length })
    await new Promise((resolve) => window.setTimeout(resolve, 20))

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write.mock.calls[0]?.[0]).toBe('first')

    callbacks.shift()?.()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(terminal.write).toHaveBeenCalledTimes(2)
    expect(terminal.write.mock.calls[1]?.[0]).toBe('secondthird')

    callbacks.shift()?.()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(terminal.write).toHaveBeenCalledTimes(3)
    expect(terminal.write.mock.calls[2]?.[0]).toBe(frame)

    callbacks.shift()?.()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(terminal.write).toHaveBeenCalledTimes(4)
    expect(terminal.write.mock.calls[3]?.[0]).toBe(nextFrame)

    callbacks.shift()?.()
    app.unmount()
    root.remove()
  })

  it('restores history in one hidden write instead of replaying synchronized frames', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeCliSessionId = 'session-main'
    let resolveSnapshot!: (snapshot: { buffer: string; startByte: number; endByte: number }) => void
    mocks.getTerminalBuffer.mockImplementation(() => new Promise((resolve) => { resolveSnapshot = resolve }))
    const { app, root } = mountPane(pinia, {
      mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    const terminal = mocks.terminalInstances[0]!
    let finishWrite: (() => void) | undefined
    terminal.write.mockImplementation((_data: string, callback?: () => void) => { finishWrite = callback })
    const history = '\x1b[?2026hworking\x1b[?2026l'.repeat(5000)
      + '\x1b[?2026hfinished\x1b[?2026l'
    resolveSnapshot({ buffer: history, startByte: 0, endByte: history.length })
    await flushPromises()
    await nextTick()
    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write.mock.calls[0]?.[0]).toBe('\x1bc' + history)
    expect((root.querySelector('.terminal-host') as HTMLElement).style.visibility).toBe('hidden')
    finishWrite?.()
    await nextTick()
    expect((root.querySelector('.terminal-host') as HTMLElement).style.visibility).toBe('')
    app.unmount()
    root.remove()
  })

  it('disposes WebGL when switching from Claude to Codex', async () => {
    mocks.webglInstances.length = 0
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-claude', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' },
      { id: 'session-codex', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeCliSessionId = 'session-claude'
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    await flushPromises()
    expect(mocks.webglInstances).toHaveLength(1)

    store.activeCliSessionId = 'session-codex'
    await nextTick()
    await flushPromises()
    expect(mocks.webglInstances[0]?.dispose).toHaveBeenCalledOnce()
    expect(mocks.webglInstances).toHaveLength(1)
    expect(root.querySelector('.codex-terminal-host')).not.toBeNull()
    app.unmount()
    root.remove()
  })


  it('renders Plan decisions as a compact three-row work panel', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.cliPlans = {
      'session-main': [{
        id: 'plan-sample',
        sessionId: 'session-main',
        createdAt: '2026-05-09T00:00:00Z',
        decisions: [
          {
            key: 'decision-1',
            title: '决策 1',
            question: '是否按紧凑布局显示 Plan？',
            yesText: '使用标题行、三行选择和右侧 ANSI 示意图。',
            noText: '保留旧布局。',
            recommendation: '推荐使用紧凑布局，减少 CLI 对话区浪费。',
            recommendedChoice: 'yes',
            choice: 'pending',
            choiceNotes: {},
          },
          {
            key: 'decision-2',
            title: '决策 2',
            question: '是否继续？',
            yesText: '继续。',
            noText: '停止。',
            recommendation: '推荐继续。',
            recommendedChoice: 'yes',
            choice: 'pending',
            choiceNotes: {},
          },
        ],
      }],
    }

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    expect(root.querySelector('.plan-form-title')?.textContent).toContain('决策1 / 决策2')
    expect(root.querySelector('.plan-form-header .primary-button')?.textContent).toContain('发送回执')
    expect(root.querySelectorAll('.plan-choice-row')).toHaveLength(3)
    expect(root.querySelectorAll('.plan-choice-note')).toHaveLength(3)
    expect(root.querySelector('.plan-ascii-panel pre')?.textContent).toContain('推荐')
    expect(root.textContent).not.toContain('@PLAN')
    expect(root.textContent).not.toContain('跳过此 Plan')

    app.unmount()
    root.remove()
  })

  it('inserts a quick phrase into the active CLI draft', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.settings.quickPhrases = [{
      id: 'phrase-1',
      title: '先审查',
      text: '先阅读代码并列出风险。',
      createdAt: '2026-07-07T00:00:00Z',
    }]

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    ;(root.querySelector('[data-testid="terminal-quick-phrase-toggle"]') as HTMLButtonElement).click()
    await nextTick()
    ;(root.querySelector('[data-testid="terminal-quick-phrase-insert"]') as HTMLButtonElement).click()
    await nextTick()

    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value).toBe('先阅读代码并列出风险。')
    app.unmount()
    root.remove()
  })

  it('enhances the CLI draft in its session cwd and can undo the replacement', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalDrafts = { 'session-main': '  修复终端按钮\n' }
    let resolveEnhancement: (value: string) => void = () => undefined
    mocks.enhancePromptWithCodex.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveEnhancement = resolve
    }))

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const enhanceButton = root.querySelector('[data-testid="terminal-enhance-prompt"]') as HTMLButtonElement
    enhanceButton.click()
    await nextTick()

    expect(mocks.enhancePromptWithCodex).toHaveBeenCalledWith('D:/Demo Files', '  修复终端按钮\n')
    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).disabled).toBe(true)
    expect(root.textContent).toContain('Codex 正在增强提示词 · 已用时')

    resolveEnhancement('检查 TerminalPane 的现有实现并修复终端按钮，完成后运行对应测试。')
    await flushPromises()
    await nextTick()

    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value)
      .toBe('检查 TerminalPane 的现有实现并修复终端按钮，完成后运行对应测试。')
    expect(root.textContent).toContain('已增强（用时')
    ;(root.querySelector('[data-testid="terminal-undo-prompt-enhancement"]') as HTMLButtonElement).click()
    await nextTick()
    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value).toBe('  修复终端按钮\n')

    app.unmount()
    root.remove()
  })

  // The history completion implementation remains available for a later re-enable.
  it.skip('shows a preview popup and completes the newest unique user input on Tab', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
      { id: 'session-claude', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [{
        id: 'main-old',
        sessionId: 'session-main',
        role: 'user',
        content: 'deploy old version',
        timestamp: '2026-08-18T10:00:00.000Z',
      }],
      'session-claude': [
        {
          id: 'claude-duplicate',
          sessionId: 'session-claude',
          role: 'user',
          content: 'Deploy newest\nwith details',
          timestamp: '2026-08-20T10:00:00.000Z',
        },
        {
          id: 'claude-system',
          sessionId: 'session-claude',
          role: 'system',
          content: 'deploy system reply',
          timestamp: '2026-08-20T12:00:00.000Z',
        },
      ],
    }

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = 'deP'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // 输入后弹窗自动打开，预览去重后的候选（最新优先），且不替换输入框内容
    const items = root.querySelectorAll('.history-completion-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('Deploy newest')
    expect(items[0]?.classList.contains('selected')).toBe(true)
    expect(textarea.value).toBe('deP')

    const firstTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(firstTab)
    await nextTick()
    expect(firstTab.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('Deploy newest\nwith details')
    expect(root.querySelector('.history-completion-popup')).toBeNull()

    // 确认后输入即完整历史消息：再按 Tab 不再弹窗，也不改变内容
    const secondTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(secondTab)
    await nextTick()
    expect(secondTab.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('Deploy newest\nwith details')
    expect(root.querySelector('.history-completion-popup')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('selects a project or global Skill with arrow keys and Enter, then sends a compatible instruction', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = { 'session-main': [] }
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
    mocks.isTauri.mockReturnValue(true)
    mocks.listSkills.mockResolvedValue([
      { name: 'agent-review', description: '代码审查', scope: 'global', path: 'C:/skills/agent-review/SKILL.md' },
      { name: 'agents-updater', description: '维护 Agent 资源', scope: 'project', path: 'D:/Demo Files/.codex/skills/agents-updater/SKILL.md' },
    ])

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    expect(mocks.listSkills).toHaveBeenCalledWith('D:/Demo Files')
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '/'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const items = root.querySelectorAll('.skill-completion-item')
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain('/prompt')
    expect(items[1]?.textContent).toContain('/agent-review')
    expect(items[1]?.textContent).toContain('全局')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()

    expect(root.querySelector('[data-testid="skill-invocation-chip"]')?.textContent).toContain('/agents-updater')
    expect(textarea.value).toBe('')

    textarea.value = '检查并更新配置'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledWith('session-main', '使用agents-updater\n\n检查并更新配置')
    expect(root.querySelector('[data-testid="skill-invocation-chip"]')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('opens workspace prompts first, searches full text and pastes without sending', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
    const timestamp = new Date(Date.now() - 1000).toISOString()
    mocks.listWorkspacePromptHistory.mockResolvedValue([
      { id: 'native-1', sessionId: 'native-session', role: 'user', content: '终端直接发送\n查找物品图标', timestamp },
      { id: 'input-2', sessionId: 'session-main', role: 'user', content: '输入框发送的提示词', timestamp },
    ])
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '/'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('.skill-completion-item')?.textContent).toContain('/prompt')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    await nextTick()
    expect(mocks.listWorkspacePromptHistory).toHaveBeenCalledWith('D:/Demo Files')
    expect(root.querySelectorAll('.prompt-history-item')).toHaveLength(2)
    expect(root.querySelector('time')?.getAttribute('datetime')).toBe(timestamp)
    const search = root.querySelector('.prompt-history-search') as HTMLInputElement
    search.value = '物品'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root.querySelectorAll('.prompt-history-item')).toHaveLength(1)
    root.querySelector('.prompt-history-item')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(textarea.value).toBe('终端直接发送\n查找物品图标')
    expect(root.querySelector('.prompt-history-popup')).toBeNull()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(textarea)
    app.unmount()
    root.remove()
  })

  it('keeps prompt loading results out of a different terminal session', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
      { id: 'session-other', title: 'Claude', providerKind: 'claude', cwd: 'D:/Other' },
    ]
    store.activeCliSessionId = 'session-main'
    let resolveHistory!: (entries: unknown[]) => void
    mocks.listWorkspacePromptHistory.mockImplementation(() => new Promise((resolve) => { resolveHistory = resolve }))
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '/prompt'
    textarea.setSelectionRange(7, 7)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(root.querySelector('.prompt-history-status')?.textContent).toContain('正在读取')
    store.activeCliSessionId = 'session-other'
    await nextTick()
    resolveHistory([{ id: 'old', sessionId: 'session-main', role: 'user', content: '旧工作区提示词', timestamp: new Date().toISOString() }])
    await flushPromises()
    await nextTick()
    expect(root.querySelector('.prompt-history-popup')).toBeNull()
    expect(textarea.value).toBe('')
    app.unmount()
    root.remove()
  })

  it('shows cached prompts immediately while checking for new terminal input', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    const timestamp = new Date(Date.now() - 1000).toISOString()
    const saved = { id: 'saved', sessionId: 'native', role: 'user', content: '已缓存的提示词', timestamp }
    mocks.listWorkspacePromptHistory.mockResolvedValueOnce([saved])
    await promptHistoryCache.refresh('D:/Demo Files')
    let finish!: (entries: unknown[]) => void
    mocks.listWorkspacePromptHistory.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '/prompt'
    textarea.setSelectionRange(7, 7)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(root.querySelector('.prompt-history-item')?.textContent).toContain('已缓存的提示词')
    expect(root.querySelector('.prompt-history-status')).toBeNull()
    finish([{ ...saved, id: 'new', content: '刚从终端发送的提示词' }, saved])
    await flushPromises()
    await nextTick()
    expect(root.querySelectorAll('.prompt-history-item')).toHaveLength(2)
    expect(root.querySelector('.prompt-history-item.selected')?.textContent).toContain('已缓存的提示词')
    app.unmount()
    root.remove()
  })

  it('fills the selected Skill display tag with a mouse click', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = { 'session-main': [] }
    mocks.isTauri.mockReturnValue(true)
    mocks.listSkills.mockResolvedValue([
      { name: 'Agent Browser', description: '浏览器自动化', scope: 'global', path: 'C:/skills/agent-browser/SKILL.md' },
    ])

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '/Agent'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    root.querySelector('.skill-completion-item')?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    await nextTick()

    expect(root.querySelector('[data-testid="skill-invocation-chip"]')?.textContent).toContain('/Agent Browser')
    expect(root.querySelector('.skill-completion-popup')).toBeNull()

    app.unmount()
    root.remove()
  })

  it.skip('selects candidates with arrow keys and confirms with Tab', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [
        {
          id: 'oldest',
          sessionId: 'session-main',
          role: 'user',
          content: 'task oldest',
          timestamp: '2026-08-18T10:00:00.000Z',
        },
        {
          id: 'middle',
          sessionId: 'session-main',
          role: 'user',
          content: 'task middle',
          timestamp: '2026-08-19T10:00:00.000Z',
        },
        {
          id: 'newest',
          sessionId: 'session-main',
          role: 'user',
          content: 'Task newest',
          timestamp: '2026-08-20T10:00:00.000Z',
        },
      ],
    }

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = 'TASK'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const items = root.querySelectorAll('.history-completion-item')
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain('Task newest')

    // 下箭头选中第二条，Tab 确认
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    expect(items[1]?.classList.contains('selected')).toBe(true)
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(textarea.value).toBe('task middle')

    // 重新输入后弹窗回到第一条；Shift+Tab 向上循环到最后一条再确认
    textarea.value = 'TASK'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const itemsAfterReset = root.querySelectorAll('.history-completion-item')
    expect(itemsAfterReset).toHaveLength(3)
    expect(itemsAfterReset[0]?.classList.contains('selected')).toBe(true)
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    await nextTick()
    expect(itemsAfterReset[2]?.classList.contains('selected')).toBe(true)
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(textarea.value).toBe('task oldest')

    app.unmount()
    root.remove()
  })

  it.skip('filters history completion again after the draft is edited', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [
        {
          id: 'alpha',
          sessionId: 'session-main',
          role: 'user',
          content: 'alpha history',
          timestamp: '2026-08-20T10:00:00.000Z',
        },
        {
          id: 'beta',
          sessionId: 'session-main',
          role: 'user',
          content: 'beta history',
          timestamp: '2026-08-20T11:00:00.000Z',
        },
      ],
    }

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = 'a'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(textarea.value).toBe('alpha history')

    textarea.value = 'b'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(textarea.value).toBe('beta history')

    app.unmount()
    root.remove()
  })

  it.skip('completes the current word fragment when the draft start does not match', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [{
        id: 'known',
        sessionId: 'session-main',
        role: 'user',
        content: '帮我用 mythicmobs 配置物品',
        timestamp: '2026-08-20T10:00:00.000Z',
      }],
    }

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '帮我用 myt'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // 整条开头匹配不到 → 词级兜底：弹出以 myt 开头的词
    const items = root.querySelectorAll('.history-completion-item')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('mythicmobs')
    expect(textarea.value).toBe('帮我用 myt')

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(tab)
    await nextTick()
    // 只替换词片段，保留「帮我用 」前缀
    expect(textarea.value).toBe('帮我用 mythicmobs')
    expect(root.querySelector('.history-completion-popup')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('keeps history completion inactive and preserves Enter behavior', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [{
        id: 'known',
        sessionId: 'session-main',
        role: 'user',
        content: 'known history',
        timestamp: '2026-08-20T10:00:00.000Z',
      }],
    }
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = ''
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const emptyTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(emptyTab)
    expect(emptyTab.defaultPrevented).toBe(false)

    textarea.value = 'missing'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const missingTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(missingTab)
    await nextTick()
    expect(missingTab.defaultPrevented).toBe(false)
    expect(root.querySelector('.history-completion-popup')).toBeNull()
    expect(root.querySelector('.history-no-match')).toBeNull()

    textarea.value = 'send this'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    textarea.dispatchEvent(shiftEnter)
    expect(shiftEnter.defaultPrevented).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    textarea.dispatchEvent(enter)
    await flushPromises()
    expect(enter.defaultPrevented).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith('session-main', 'send this')

    app.unmount()
    root.remove()
  })



  it('inserts plain external text without wrapping it as a code selection', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', {
      detail: {
        text: 'DragonCore/Gui/s商店-交易行-交易/SystemShop-在线币.yml',
        insertMode: 'plain',
      },
    }))
    await nextTick()

    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value).toBe('DragonCore/Gui/s商店-交易行-交易/SystemShop-在线币.yml')

    app.unmount()
    root.remove()
  })

  it('does not resize the backing CLI terminal when draft wrapping only changes height', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    let hostWidth = 720
    let hostHeight = 360
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return this.classList?.contains('terminal-host') ? hostWidth : 28
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('terminal-host') ? hostHeight : 28
      },
    })

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    try {
      await nextTick()
      await flushPromises()
      await new Promise((resolve) => window.setTimeout(resolve, 180))
      mocks.resizeTerminal.mockClear()

      const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
      Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 54 })
      textarea.value = '这是一段足够长的输入，会在 CLI 对话框里软换行。'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      hostHeight = 342
      window.dispatchEvent(new Event('resize'))
      await new Promise((resolve) => window.setTimeout(resolve, 120))

      expect(mocks.resizeTerminal).not.toHaveBeenCalled()

      hostWidth = 680
      window.dispatchEvent(new Event('resize'))
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      expect(mocks.resizeTerminal).toHaveBeenCalledTimes(1)
    } finally {
      app.unmount()
      root.remove()
      if (originalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
      } else {
        delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
      }
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
      } else {
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
      }
    }
  })

  it('passes the same inline-history bytes through unchanged for Claude', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    const output = '\x1b[1;20r\x1b[20;1H\r\nClaude output\x1b[r'
    mocks.getTerminalBuffer.mockResolvedValue({
      buffer: output,
      startByte: 0,
      endByte: output.length,
    })

    const { app } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))

    const writes = mocks.terminalInstances[0]?.write.mock.calls.map(([data]) => String(data)).join('') ?? ''
    expect(writes).toContain(output)
    expect(writes).not.toContain('\x1b[1;24r\x1b[24;1H')

    app.unmount()
  })

  it('passes Codex alternate-screen and alternate-scroll modes through unchanged', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    mocks.getTerminalBuffer.mockResolvedValue({
      buffer: '\x1b[?1049h\x1b[?1007hoverlay\x1b[?1007l\x1b[?1049l',
      startByte: 0,
      endByte: 44,
    })

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))

    const writes = mocks.terminalInstances[0]?.write.mock.calls.map(([data]) => String(data)).join('') ?? ''
    expect(writes).toContain('\x1b[?1049h\x1b[?1007hoverlay\x1b[?1007l\x1b[?1049l')
    expect(mocks.terminalInstances[0]?.parser.registerCsiHandler).not.toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('saves quick phrases from their own content field and can fill it from the active CLI draft', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalDrafts['session-main'] = ''

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    ;(root.querySelector('[data-testid="terminal-quick-phrase-toggle"]') as HTMLButtonElement).click()
    await nextTick()
    const title = root.querySelector('[data-testid="terminal-quick-phrase-title"]') as HTMLInputElement
    title.value = '修复流程'
    title.dispatchEvent(new Event('input'))
    const text = root.querySelector('[data-testid="terminal-quick-phrase-text"]') as HTMLTextAreaElement
    text.value = '复现问题，最小改动修复，并跑验证。'
    text.dispatchEvent(new Event('input'))
    await nextTick()
    ;(root.querySelector('[data-testid="terminal-save-quick-phrase"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()

    expect(store.settings.quickPhrases[0]).toMatchObject({
      title: '修复流程',
      text: '复现问题，最小改动修复，并跑验证。',
    })
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      quickPhrases: [expect.objectContaining({ title: '修复流程' })],
    }))

    store.terminalDrafts['session-main'] = '把当前草稿填进短语内容。'
    await nextTick()
    ;(root.querySelector('[data-testid="terminal-quick-phrase-fill-draft"]') as HTMLButtonElement).click()
    await nextTick()
    expect((root.querySelector('[data-testid="terminal-quick-phrase-text"]') as HTMLTextAreaElement).value)
      .toBe('把当前草稿填进短语内容。')

    ;(root.querySelector('[data-testid="terminal-quick-phrase-delete"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()

    expect(store.settings.quickPhrases).toEqual([])
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      quickPhrases: [],
    }))
    app.unmount()
    root.remove()
  })

  it('pastes five clipboard images into CLI draft attachments and sends all paths', async () => {
    const store = useWorkspaceStore()
    store.workspace = {
      id: 'ws-1',
      name: 'Super High',
      displayName: 'Super High',
      rootPath: 'D:/Demo Files',
      openedAt: '2026-07-15T00:00:00Z',
    }
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.showActivityMessage = vi.fn()
    store.showErrorMessage = vi.fn()
    store.sendTerminalConversationMessage = vi.fn().mockResolvedValue(true)

    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      dataUrl,
      mimeType: 'image/png',
      preferredName: `image-${index + 1}.png`,
      previewUrl: dataUrl,
    }))
    mocks.extractPastedImagesFromClipboardEvent.mockResolvedValue(candidates)
    mocks.savePastedImage.mockImplementation(async (_projectPath, _dataUrl, preferredName) => (
      `D:/Demo Files/.superhigh/pasted-images/${preferredName}`
    ))

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await nextTick()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [new File([], 'image-1.png', { type: 'image/png' })],
        items: [{ type: 'image/png', getAsFile: () => null }],
      },
    })
    textarea.dispatchEvent(pasteEvent)
    await flushPromises()
    await nextTick()
    await flushPromises()

    expect(mocks.extractPastedImagesFromClipboardEvent).toHaveBeenCalled()
    expect(mocks.savePastedImage).toHaveBeenCalledTimes(5)
    expect(mocks.savePastedImage).toHaveBeenNthCalledWith(
      1,
      'D:/Demo Files',
      dataUrl,
      'image-1.png',
    )
    expect(root.querySelector('[data-testid="terminal-image-attachments"]')).toBeTruthy()
    expect(root.querySelectorAll('.cli-image-chip')).toHaveLength(5)

    const sendButton = root.querySelector('.cli-input-shell .primary-button') as HTMLButtonElement
    expect(sendButton.disabled).toBe(false)
    sendButton.click()
    await flushPromises()
    await nextTick()

    expect(store.sendTerminalConversationMessage).toHaveBeenCalledWith(
      'session-main',
      '图片1路径：D:/Demo Files/.superhigh/pasted-images/image-1.png\n'
        + '图片2路径：D:/Demo Files/.superhigh/pasted-images/image-2.png\n'
        + '图片3路径：D:/Demo Files/.superhigh/pasted-images/image-3.png\n'
        + '图片4路径：D:/Demo Files/.superhigh/pasted-images/image-4.png\n'
        + '图片5路径：D:/Demo Files/.superhigh/pasted-images/image-5.png\n'
        + '请读取并查看上述本地图片文件后再回答；若无法访问该路径，请明确说明。',
    )
    expect(root.querySelector('[data-testid="terminal-image-attachments"]')).toBeNull()

    app.unmount()
    root.remove()
  })

})
