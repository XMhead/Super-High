import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import TerminalPane from './TerminalPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  createProjectStartupTerminalSession: vi.fn(),
  extractPastedImagesFromClipboardApi: vi.fn(),
  extractPastedImagesFromClipboardEvent: vi.fn(),
  getTerminalBuffer: vi.fn(),
  getProjectStartupConfig: vi.fn(),
  isTauri: vi.fn(),
  onTerminalOutput: vi.fn(),
  openExternalCli: vi.fn(),
  resizeTerminal: vi.fn(),
  savePastedImage: vi.fn(),
  saveSettings: vi.fn(),
  terminalInstances: [] as Array<{
    options: Record<string, unknown>
    parser: {
      registerCsiHandler: ReturnType<typeof vi.fn>
    }
    scrollLines: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
  }>,
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
    loadAddon = vi.fn()
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
    dispose = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      mocks.terminalInstances.push(this)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = vi.fn()
    dispose = vi.fn()
  },
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    closeTerminal: mocks.closeTerminal,
    createProjectStartupTerminalSession: mocks.createProjectStartupTerminalSession,
    getTerminalBuffer: mocks.getTerminalBuffer,
    getProjectStartupConfig: mocks.getProjectStartupConfig,
    openExternalCli: mocks.openExternalCli,
    savePastedImage: mocks.savePastedImage,
    saveSettings: mocks.saveSettings,
    resizeTerminal: mocks.resizeTerminal,
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
    pinia = createPinia()
    setActivePinia(pinia)
    mocks.closeTerminal.mockReset()
    mocks.createProjectStartupTerminalSession.mockReset()
    mocks.getTerminalBuffer.mockReset()
    mocks.getProjectStartupConfig.mockReset()
    mocks.isTauri.mockReset()
    mocks.onTerminalOutput.mockReset()
    mocks.openExternalCli.mockReset()
    mocks.resizeTerminal.mockReset()
    mocks.saveSettings.mockReset()
    mocks.savePastedImage.mockReset()
    mocks.extractPastedImagesFromClipboardApi.mockReset()
    mocks.extractPastedImagesFromClipboardEvent.mockReset()
    mocks.terminalInstances.length = 0
    mocks.writeTerminalInput.mockReset()
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: '', startByte: 0, endByte: 0 })
    mocks.isTauri.mockReturnValue(false)
    mocks.onTerminalOutput.mockResolvedValue(() => undefined)
    mocks.openExternalCli.mockResolvedValue(undefined)
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.savePastedImage.mockResolvedValue('D:/Super High/.superhigh/pasted-images/paste-test.png')
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
      name: '示例服务端',
      scriptPath: 'D:/Work/server/start.bat',
      workingDirectory: 'D:/Work/server',
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务端')

    app.unmount()
    root.remove()
  })

  it('starts the configured project server from the startup control', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例服务端',
      scriptPath: 'D:/Work/server/start.bat',
      workingDirectory: 'D:/Work/server',
    }
    const spy = vi.spyOn(store, 'createProjectStartupTerminalSession').mockResolvedValue({
      id: 'server-1',
      title: '示例服务端',
      providerKind: 'project-startup',
      cwd: 'D:/Work/server',
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
      name: '示例服务链',
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

  it('keeps the local terminal toolbar dedicated to the service chain', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例服务链',
      mode: 'services',
      services: [
        { id: 'mysql', name: 'MySQL', commandPath: 'D:/mysql/mysqld.exe', args: [], workingDirectory: 'D:/mysql', startAfter: [] },
      ],
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务链')
    expect(root.textContent).not.toContain('PowerShell')
    expect(root.textContent).not.toContain('服务端日志(GBK)')

    app.unmount()
    root.remove()
  })

  it('uses the service name instead of its internal provider kind in the terminal tab', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例服务链',
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
      name: '示例服务链',
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
      name: '示例服务端',
      scriptPath: 'D:/Work/server/start.bat',
      workingDirectory: 'D:/Work/server',
    }
    store.terminalSessions = [{
      id: 'server-1',
      title: '示例服务端',
      providerKind: 'project-startup',
      cwd: 'D:/Work/server',
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
      name: '示例服务端',
      scriptPath: 'D:/Work/server/start.bat',
      workingDirectory: 'D:/Work/server',
    }
    store.terminalSessions = [{
      id: 'server-exited',
      title: '示例服务端',
      providerKind: 'project-startup',
      cwd: 'D:/Work/server',
    }]
    store.terminalExitCodes = { 'server-exited': 0 }
    const createSpy = vi.spyOn(store, 'createProjectStartupTerminalSession').mockResolvedValue({
      id: 'server-2',
      title: '示例服务端',
      providerKind: 'project-startup',
      cwd: 'D:/Work/server',
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
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
      rootPath: 'D:/Super High',
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
    expect(mocks.openExternalCli).toHaveBeenCalledWith('codex', 'D:/Super High')
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
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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

  it('streams split Codex inline-history bytes to xterm without rewriting them', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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

  it('renders Plan decisions as a compact three-row work panel', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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

  it('inserts plain external text without wrapping it as a code selection', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
        text: 'docs/guide/shop.yml',
        insertMode: 'plain',
      },
    }))
    await nextTick()

    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value).toBe('docs/guide/shop.yml')

    app.unmount()
    root.remove()
  })

  it('does not resize the backing CLI terminal when draft wrapping only changes height', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
      { id: 'session-main', title: 'Claude', providerKind: 'claude', cwd: 'D:/Super High' },
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
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
      rootPath: 'D:/Super High',
      openedAt: '2026-07-15T00:00:00Z',
    }
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Super High' },
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
      `D:/Super High/.superhigh/pasted-images/${preferredName}`
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
      'D:/Super High',
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
      '图片1路径：D:/Super High/.superhigh/pasted-images/image-1.png\n'
        + '图片2路径：D:/Super High/.superhigh/pasted-images/image-2.png\n'
        + '图片3路径：D:/Super High/.superhigh/pasted-images/image-3.png\n'
        + '图片4路径：D:/Super High/.superhigh/pasted-images/image-4.png\n'
        + '图片5路径：D:/Super High/.superhigh/pasted-images/image-5.png\n'
        + '请查看上面的图片。',
    )
    expect(root.querySelector('[data-testid="terminal-image-attachments"]')).toBeNull()

    app.unmount()
    root.remove()
  })

})
