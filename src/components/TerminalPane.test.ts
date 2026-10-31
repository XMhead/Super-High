import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TerminalPane from './TerminalPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { promptHistoryCache } from '@/lib/promptHistoryCache'
import { getTheme } from '@/lib/theme'
import type { SkillCompletionItem } from '@/types'

const mocks = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  restoreServiceMonitors: vi.fn(async () => []),
  codexRendererInstances: [] as unknown[],
  createProjectStartupTerminalSession: vi.fn(),
  extractPastedImagesFromClipboardApi: vi.fn(),
  extractPastedImagesFromClipboardEvent: vi.fn(),
  getTerminalBuffer: vi.fn(),
  listLiveTerminalSessionIds: vi.fn(async () => [] as string[]),
  getProjectStartupConfig: vi.fn(),
  isFile: vi.fn(),
  isTauri: vi.fn(),
  listSkills: vi.fn(),
  listRegisteredCommands: vi.fn(async (): Promise<SkillCompletionItem[]> => []),
  listWorkspacePromptHistory: vi.fn(),
  onTerminalOutput: vi.fn(),
  openExternalCli: vi.fn(),
  openExternalCliSession: vi.fn(),
  openUrl: vi.fn(),
  resizeTerminal: vi.fn(),
  resolveTerminalPath: vi.fn(),
  readFilesFromClipboard: vi.fn(),
  savePastedImage: vi.fn(),
  savePastedText: vi.fn(),
  listPastedTexts: vi.fn(),
  saveSettings: vi.fn(),
  terminalInstances: [] as Array<{
    options: Record<string, unknown>
    parser: {
      registerCsiHandler: ReturnType<typeof vi.fn>
    }
    buffer: {
      active: {
        viewportY: number
        baseY: number
        length: number
        getLine: ReturnType<typeof vi.fn>
      }
    }
    scrollToBottom: ReturnType<typeof vi.fn>
    scrollLines: ReturnType<typeof vi.fn>
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>
    registerLinkProvider: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    cols: number
    rows: number
    refresh: ReturnType<typeof vi.fn>
    clearTextureAtlas: ReturnType<typeof vi.fn>
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
        viewportY: 0,
        baseY: 0,
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
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols
      this.rows = rows
    })
    reset = vi.fn()
    focus = vi.fn()
    scrollToBottom = vi.fn()
    scrollLines = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn()
    refresh = vi.fn()
    clearTextureAtlas = vi.fn()

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
    restoreServiceMonitors: mocks.restoreServiceMonitors,
    createProjectStartupTerminalSession: mocks.createProjectStartupTerminalSession,
    getTerminalBuffer: mocks.getTerminalBuffer,
    readTerminalChat: vi.fn(async () => ({ model: "", turns: [] })),
    listLiveTerminalSessionIds: mocks.listLiveTerminalSessionIds,
    getProjectStartupConfig: mocks.getProjectStartupConfig,
    getAppStorageInfo: vi.fn(async () => ({ dataDir: 'D:/data' })),
    isFile: mocks.isFile,
    listSkills: mocks.listSkills,
    listRegisteredCommands: mocks.listRegisteredCommands,
    listWorkspacePromptHistory: mocks.listWorkspacePromptHistory,
    openExternalCli: mocks.openExternalCli,
    openExternalCliSession: mocks.openExternalCliSession,
    openUrl: mocks.openUrl,
    readFile: vi.fn(async () => { throw new Error('No such file or directory (os error 2)') }),
    writeFile: vi.fn(async () => {}),
    savePastedImage: mocks.savePastedImage,
    savePastedText: mocks.savePastedText,
    listPastedTexts: mocks.listPastedTexts,
    saveSettings: mocks.saveSettings,
    resizeTerminal: mocks.resizeTerminal,
    resolveTerminalPath: mocks.resolveTerminalPath,
    readFilesFromClipboard: mocks.readFilesFromClipboard,
    writeTerminalInput: mocks.writeTerminalInput,
  },
  isTauri: mocks.isTauri,
  onTerminalOutput: mocks.onTerminalOutput,
  onWorkspaceFilesChanged: vi.fn(async () => () => {}),
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

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    Reflect.deleteProperty(document, 'fonts')
  })

  beforeEach(() => {
    promptHistoryCache.clear()
    pinia = createPinia()
    setActivePinia(pinia)
    mocks.closeTerminal.mockReset()
    mocks.closeTerminal.mockResolvedValue(undefined)
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
    mocks.savePastedText.mockReset()
    mocks.listPastedTexts.mockReset()
    mocks.readFilesFromClipboard.mockReset()
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

  it('updates the existing terminal when the selected style font role or resource changes', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'font-session', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'font-session'
    const fonts = [
      { id: 'font-first', name: 'First', family: 'First Mono', source: 'data:font/woff2;base64,AA==', format: 'woff2' as const },
      { id: 'font-second', name: 'Second', family: 'Second Mono', source: 'data:font/woff2;base64,AQ==', format: 'woff2' as const },
    ]
    await store.setCustomFonts(fonts, [{ id: 'font-test', name: 'Test', roles: { mono: 'font-first' } }])
    await store.setFontStyle('font-test')
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    await flushPromises()
    const target = mocks.terminalInstances[0]!
    expect(target.options.fontFamily).toContain('First Mono')
    let finishLoading!: () => void
    let pending = new Promise<FontFace[]>((resolve) => { finishLoading = () => resolve([]) })
    const load = vi.fn(() => pending)
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
    await store.setCustomFonts(fonts, [{ id: 'font-test', name: 'Test', roles: { mono: 'font-second' } }])
    await nextTick()
    expect(target.options.fontFamily).toContain('First Mono')
    expect(load).toHaveBeenCalledWith(expect.stringContaining('Second Mono'))
    finishLoading()
    await flushPromises()
    expect(target.options.fontFamily).toContain('Second Mono')
    pending = new Promise<FontFace[]>((resolve) => { finishLoading = () => resolve([]) })
    await store.setCustomFonts(fonts, [{ id: 'font-test', name: 'Test', roles: { mono: 'font-first' } }])
    await nextTick()
    target.clearTextureAtlas.mockClear()
    app.unmount()
    root.remove()
    finishLoading()
    await flushPromises()
    expect(target.clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('ignores stale font loads when styles change again before loading finishes', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'font-session', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'font-session'
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    await flushPromises()
    let finishOldLoad!: () => void
    const pending = new Promise<FontFace[]>((resolve) => { finishOldLoad = () => resolve([]) })
    const load = vi.fn((font: string) => font.includes('Old Mono') ? pending : Promise.resolve([]))
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
    const fonts = [
      { id: 'font-old', name: 'Old', family: 'Old Mono', source: 'data:font/woff2;base64,AA==', format: 'woff2' as const },
      { id: 'font-new', name: 'New', family: 'New Mono', source: 'data:font/woff2;base64,AQ==', format: 'woff2' as const },
    ]
    await store.setCustomFonts(fonts, [{ id: 'font-race', name: 'Race', roles: { mono: 'font-old' } }])
    await store.setFontStyle('font-race')
    await nextTick()
    await store.setCustomFonts(fonts, [{ id: 'font-race', name: 'Race', roles: { mono: 'font-new' } }])
    await nextTick()
    await flushPromises()
    const target = mocks.terminalInstances[0]!
    expect(target.options.fontFamily).toContain('New Mono')
    finishOldLoad()
    await flushPromises()
    expect(target.options.fontFamily).toContain('New Mono')
    app.unmount()
    root.remove()
  })

  it('reloads font roles and resources without replacing the terminal or sending input', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'font-session', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'font-session'
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    await flushPromises()
    const target = mocks.terminalInstances[0]!
    const load = vi.fn(async () => [])
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
    const fonts = [{ id: 'font-live', name: 'Live', family: 'Live Mono', source: 'data:font/woff2;base64,AA==', format: 'woff2' as const }]
    await store.setCustomFonts(fonts, [{ id: 'font-live-style', name: 'Live', roles: { mono: 'font-live' } }])
    await store.setFontStyle('font-live-style')
    await nextTick()
    await flushPromises()
    expect(target.options.fontFamily).toContain('Live Mono')
    const refreshCount = target.refresh.mock.calls.length
    await store.setCustomFonts([{ ...fonts[0]!, source: 'data:font/woff2;base64,AQ==' }], store.settings.customFontStyles)
    await nextTick()
    await flushPromises()
    expect(target.refresh.mock.calls.length).toBeGreaterThan(refreshCount)
    expect(target.clearTextureAtlas).toHaveBeenCalled()
    expect(target.options.fontSize).toBe(14)
    expect(mocks.terminalInstances).toHaveLength(1)
    expect(mocks.closeTerminal).not.toHaveBeenCalled()
    expect(mocks.writeTerminalInput).not.toHaveBeenCalled()
    app.unmount()
    root.remove()
  })

  it('shows configured project startup control in local terminal mode', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目目录名服务端',
      scriptPath: 'D:/示例项目/示例项目目录名服务端/start-server.bat',
      workingDirectory: 'D:/示例项目/示例项目目录名服务端',
    }

    const { app, root } = mountPane(pinia, { mode: 'local' })
    await nextTick()

    expect(root.textContent).toContain('启动服务端')

    app.unmount()
    root.remove()
  })

  it('forwards Alt arrows with the original modifier to the active CLI session exactly once', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    const { app, root } = mountPane(pinia, {
      mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    const handler = mocks.terminalInstances[0]!.attachCustomKeyEventHandler.mock.calls[0]![0]
    mocks.writeTerminalInput.mockClear()
    for (const [key, suffix] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D']]) {
      const event = new KeyboardEvent('keydown', { key, altKey: true, cancelable: true })
      expect(handler(event)).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      expect(mocks.writeTerminalInput).toHaveBeenLastCalledWith('session-main', `\x1b[1;3${suffix}`)
      expect(handler(new KeyboardEvent('keyup', { key, altKey: true }))).toBe(true)
    }
    expect(mocks.writeTerminalInput).toHaveBeenCalledTimes(4)
    for (const modifiers of [{}, { ctrlKey: true }, { altKey: true, shiftKey: true }, { altKey: true, ctrlKey: true }]) {
      expect(handler(new KeyboardEvent('keydown', { key: 'ArrowUp', ...modifiers }))).toBe(true)
    }
    expect(mocks.writeTerminalInput).toHaveBeenCalledTimes(4)
    app.unmount()
    root.remove()
  })

  it('passes arrows through and cycles CLI providers only with mouse side buttons', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-codex', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
      { id: 'session-claude', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' },
      { id: 'session-opencode', title: 'OpenCode', providerKind: 'opencode', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-codex'
    store.activeCliSessionId = 'session-codex'

    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    await flushPromises()

    root.querySelector('.cli-render-region')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const handler = mocks.terminalInstances[0]!.attachCustomKeyEventHandler.mock.calls[0]![0]

    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const arrow = new KeyboardEvent('keydown', { key, cancelable: true })
      expect(handler(arrow)).toBe(true)
      expect(arrow.defaultPrevented).toBe(false)
      expect(store.activeCliSessionId).toBe('session-codex')
    }

    const removedLetterShortcut = new KeyboardEvent('keydown', { key: 'd', cancelable: true })
    expect(handler(removedLetterShortcut)).toBe(true)
    expect(removedLetterShortcut.defaultPrevented).toBe(false)
    expect(store.activeCliSessionId).toBe('session-codex')

    const sideForward = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 4 })
    root.querySelector('.cli-render-region')?.dispatchEvent(sideForward)
    expect(sideForward.defaultPrevented).toBe(true)
    expect(store.activeCliSessionId).toBe('session-claude')

    const input = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    expect(store.activeCliSessionId).toBe('session-claude')

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
      scriptPath: 'D:/示例项目/示例项目目录名服务端/start-server.bat',
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
      projectPath: 'D:/Fixture/plugins',
      runId: 'run-fixture',
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
      projectPath: 'D:/Fixture/plugins',
      runId: 'run-fixture',
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
      projectPath: 'D:/Fixture/plugins',
      runId: 'run-fixture',
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

  it('ends the process when the user closes an Agent tab', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'manual', title: 'Codex', providerKind: 'codex', cwd: 'D:/One' }]
    store.activeCliSessionId = 'manual'
    store.activeTerminalSessionId = 'manual'
    const spy = vi.spyOn(store, 'closeTerminalSession').mockResolvedValue()
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    await nextTick()
    root.querySelector<HTMLButtonElement>('.terminal-tab-close')!.click()
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('manual', true)
    app.unmount()
    root.remove()
  })

  it('closes the live project startup session from the startup control', async () => {
    const store = useWorkspaceStore()
    store.projectStartupConfig = {
      name: '示例项目目录名服务端',
      scriptPath: 'D:/示例项目/示例项目目录名服务端/start-server.bat',
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
      scriptPath: 'D:/示例项目/示例项目目录名服务端/start-server.bat',
      workingDirectory: 'D:/示例项目/示例项目目录名服务端',
    }
    store.terminalSessions = [{
      id: 'server-exited',
      title: '示例项目目录名服务端',
      providerKind: 'project-startup',
      cwd: 'D:/示例项目/示例项目目录名服务端',
    }]
    await store.closeTerminalSession('server-exited')
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

  it('shows PowerShell alongside server and client start and restart actions in the local terminal toolbar', async () => {
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
    expect(labels).toEqual(['新建 PowerShell', '启动服务端', '重启服务端', '启动客户端', '重启客户端'])

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
      revealInExplorer: false,
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
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path, { createUnsupportedTabOnError: false, verifyExistingFile: true, revealInExplorer: false }))
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

    await store.setScrollSpeedPercent(200)
    await nextTick()
    expect(mocks.terminalInstances[0]?.options.scrollSensitivity).toBe(2.5)
    expect(mocks.terminalInstances).toHaveLength(1)
    await store.setScrollSpeedPercent(100)
    await nextTick()
    expect(mocks.terminalInstances[0]?.options.scrollSensitivity).toBe(1.25)

    app.unmount()
    root.remove()
  })

  it('waits for each xterm write callback, keeps frames whole, and batches closed DEC 2026 frames', async () => {
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
    const frame = '\x1b[?2026hframe\x1b[?2026l'
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
    expect(terminal.write.mock.calls[1]?.[0]).toBe(`secondthird${frame}${nextFrame}`)

    callbacks.shift()?.()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(terminal.write).toHaveBeenCalledTimes(2)
    app.unmount()
    root.remove()
  })

  it('resyncs queued ANSI updates on overflow instead of silently losing Chinese diffs', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main' })
    await flushPromises()
    await nextTick()
    const terminal = mocks.terminalInstances[0]!
    const callbacks: Array<() => void> = []
    terminal.write.mockImplementation((_data: string, callback?: () => void) => { if (callback) callbacks.push(callback) })
    const listener = mocks.onTerminalOutput.mock.calls.at(-1)?.[0]
    listener?.({ sessionId: 'session-main', chunk: 'first', startByte: 0, endByte: 5 })
    await new Promise(resolve => window.setTimeout(resolve, 20))
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const snapshot = '中文刷新完成\x1b[2K\r当前画面'
    mocks.getTerminalBuffer.mockResolvedValueOnce({ buffer: snapshot, startByte: 0, endByte: 5 + huge.length + 6 })
    mocks.getTerminalBuffer.mockClear()
    listener?.({ sessionId: 'session-main', chunk: huge, startByte: 5, endByte: 5 + huge.length })
    listener?.({ sessionId: 'session-main', chunk: '中文', startByte: 5 + huge.length, endByte: 5 + huge.length + 6 })
    await flushPromises()
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(mocks.getTerminalBuffer).toHaveBeenCalledOnce()
    expect(terminal.write.mock.calls.at(-1)?.[0]).toBe('\x1bc' + snapshot)
    callbacks.forEach(callback => callback())
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
    terminal.buffer.active.baseY = 200
    terminal.buffer.active.viewportY = 10
    finishWrite?.()
    expect(terminal.scrollToBottom).toHaveBeenCalled()
    await nextTick()
    expect((root.querySelector('.terminal-host') as HTMLElement).style.visibility).toBe('')
    app.unmount()
    root.remove()
  })

  it('drops a cut escape fragment from truncated history and forces one repaint', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeCliSessionId = 'session-main'
    const frame = '\x1b[?2026hready\x1b[?2026l'
    const history = '6h\x1b[2;3Hpartial\x1b[?2026l' + frame
    const modes = '\x1b[?1003h\x1b[?1006h'
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: history, startByte: 4096, endByte: 4096 + history.length, modes })
    const { app, root } = mountPane(pinia, {
      mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    const terminal = mocks.terminalInstances[0]!
    // 截断历史丢掉的鼠标上报模式在 RIS 后补回，Codex 的滚轮与点击才能继续生效。
    expect(terminal.write.mock.calls[0]?.[0]).toBe('\x1bc' + modes + frame)
    expect(mocks.resizeTerminal).toHaveBeenCalledWith('session-main', expect.any(Number), expect.any(Number), true)
    app.unmount()
    root.remove()
  })

  it('replays history at the recorded PTY sizes before fitting back to the pane', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    const first = '\x1b[?2026h宽屏\x1b[?2026l'
    const second = '\x1b[?2026hRan\x1b[?2026l'
    const firstBytes = new TextEncoder().encode(first).length
    const history = first + second
    const endByte = 100 + new TextEncoder().encode(history).length
    mocks.getTerminalBuffer.mockImplementation(async () => {
      // 真实 xterm 的写入回调是异步的，回放中的 resize 必须等前一段解析完成。
      mocks.terminalInstances[0]!.write.mockImplementation((_data: string, callback?: () => void) => {
        window.setTimeout(() => callback?.(), 0)
      })
      return {
        buffer: history,
        startByte: 100,
        endByte,
        sizes: [
          { atByte: 0, cols: 110, rows: 36 },
          { atByte: 100 + firstBytes, cols: 96, rows: 30 },
          { atByte: endByte, cols: 90, rows: 28 },
        ],
      }
    })
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.classList?.contains('terminal-host') ? 720 : 28 },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.classList?.contains('terminal-host') ? 360 : 28 },
    })
    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main' })
    try {
      await nextTick()
      await flushPromises()
      await new Promise((resolve) => window.setTimeout(resolve, 20))
      const terminal = mocks.terminalInstances[0]!
      const steps = terminal.write.mock.invocationCallOrder.map((order, index) => ({ order, step: `write:${terminal.write.mock.calls[index]![0]}` }))
        .concat(terminal.resize.mock.invocationCallOrder.map((order, index) => ({ order, step: `resize:${terminal.resize.mock.calls[index]!.join('x')}` })))
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.step)
      // 每段历史在生成时的尺寸下解析，结束后再按面板 fit，而不是停在最后记录的尺寸。
      expect(steps).toEqual([
        'resize:110x36',
        `write:\x1bc${first}`,
        'resize:96x30',
        `write:${second}`,
      ])
      expect([terminal.cols, terminal.rows]).toEqual([90, 20])
      // 截断历史的强制重绘必须用面板尺寸，不能把回放中的历史尺寸发给 PTY。
      expect(mocks.resizeTerminal).toHaveBeenLastCalledWith('session-main', 90, 20, true)
      expect(mocks.resizeTerminal.mock.calls.every((call) => call[1] === 90 && call[2] === 20)).toBe(true)
    } finally {
      app.unmount()
      root.remove()
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
      if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
    }
  })

  it('follows new output at bottom but lets the user scroll up during writes', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: 'ready', startByte: 0, endByte: 5 })
    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main', compactTeam: true })
    await nextTick()
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    const terminal = mocks.terminalInstances[0]!
    const output = mocks.onTerminalOutput.mock.calls.at(-1)![0]
    terminal.scrollToBottom.mockClear()
    terminal.buffer.active.baseY = 100
    terminal.buffer.active.viewportY = 50
    output({ sessionId: 'session-main', chunk: 'a', startByte: 5, endByte: 6 })
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
    terminal.buffer.active.viewportY = 100
    output({ sessionId: 'session-main', chunk: 'b', startByte: 6, endByte: 7 })
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce()
    terminal.scrollToBottom.mockClear()
    let finishWrite: (() => void) | undefined
    terminal.write.mockImplementation((_data, callback) => { finishWrite = callback })
    output({ sessionId: 'session-main', chunk: 'c', startByte: 7, endByte: 8 })
    await flushPromises()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    root.querySelector('.xterm')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    terminal.buffer.active.viewportY = 90
    finishWrite?.()
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
    app.unmount()
    root.remove()
  })

  it('keeps one renderer for CLI tabs when switching between Claude and Codex', async () => {
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

    store.activeCliSessionId = 'session-codex'
    await nextTick()
    await flushPromises()
    store.activeCliSessionId = 'session-claude'
    await nextTick()
    await flushPromises()
    expect(mocks.webglInstances).toHaveLength(0)
    expect(root.querySelector('.terminal-host')).not.toBeNull()
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
    const write = vi.spyOn(store, 'writeTerminalInput').mockResolvedValue()
    ;(root.querySelector('[data-testid="terminal-clear-draft"]') as HTMLButtonElement).click()
    await nextTick()
    await flushPromises()
    expect(store.terminalDrafts['session-main']).toBe('')
    expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value).toBe('')
    const clear = write.mock.calls.find(([input, id]) => id === 'session-main' && input === '\u0015\u000b'.repeat(256))
    expect(clear).toBeTruthy()
    expect(clear![0]).not.toMatch(/[\r\n\u0003]/)
    app.unmount()
    root.remove()
  })

  it('schedules messages for the active CLI session from the input toolbar', async () => {
    const store = useWorkspaceStore()
    store.workspace = {
      id: 'workspace-demo',
      name: 'Demo Files',
      displayName: 'Demo Files',
      rootPath: 'D:/Demo Files',
      openedAt: '2026-07-15T00:00:00Z',
    }
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

    ;(root.querySelector('[data-testid="terminal-scheduled-toggle"]') as HTMLButtonElement).click()
    await nextTick()
    const text = root.querySelector('[data-testid="terminal-scheduled-text"]') as HTMLTextAreaElement
    text.value = '继续检查构建结果'
    text.dispatchEvent(new Event('input'))
    const hours = root.querySelector('[data-testid="terminal-scheduled-hours"]') as HTMLInputElement
    hours.value = '7'
    hours.dispatchEvent(new Event('input'))
    await nextTick()
    const add = root.querySelector('[data-testid="terminal-scheduled-add"]') as HTMLButtonElement
    expect(add.disabled).toBe(true)

    hours.value = '1'
    hours.dispatchEvent(new Event('input'))
    await nextTick()
    add.click()
    await nextTick()

    expect(store.scheduledTerminalMessages['session-main']).toEqual([
      expect.objectContaining({ text: '继续检查构建结果' }),
    ])
    expect(root.querySelectorAll('[data-testid="terminal-scheduled-item"]')).toHaveLength(1)
    expect(root.querySelector('.cli-schedule-count')?.textContent).toBe('1')
    const originalId = store.scheduledTerminalMessages['session-main'][0].id
    ;(root.querySelector('[data-testid="terminal-scheduled-edit"]') as HTMLButtonElement).click()
    await nextTick()
    expect(text.value).toBe('继续检查构建结果')
    expect(document.activeElement).toBe(text)
    text.value = '调整后的检查消息'
    text.dispatchEvent(new Event('input'))
    hours.value = '0'
    hours.dispatchEvent(new Event('input'))
    const minutes = root.querySelector('[data-testid="terminal-scheduled-minutes"]') as HTMLInputElement
    minutes.value = '5'
    minutes.dispatchEvent(new Event('input'))
    await nextTick()
    expect(add.textContent).toContain('保存并重新计时')
    add.click()
    await nextTick()
    expect(store.scheduledTerminalMessages['session-main']).toEqual([
      expect.objectContaining({ id: originalId, text: '调整后的检查消息' }),
    ])

    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      ;(root.querySelector('[data-testid="terminal-scheduled-item-copy"]') as HTMLButtonElement).click()
      await flushPromises()
      expect(writeText).toHaveBeenLastCalledWith('调整后的检查消息')
      ;(root.querySelector('[data-testid="terminal-scheduled-edit"]') as HTMLButtonElement).click()
      await nextTick()
      text.value = '立即发送前再次修改'
      text.dispatchEvent(new Event('input'))
      hours.value = '7'
      hours.dispatchEvent(new Event('input'))
      await nextTick()
      ;(root.querySelector('[data-testid="terminal-scheduled-copy"]') as HTMLButtonElement).click()
      await flushPromises()
      expect(writeText).toHaveBeenLastCalledWith('立即发送前再次修改')
      expect(store.scheduledTerminalMessages['session-main'][0].text).toBe('调整后的检查消息')
      expect(add.disabled).toBe(true)
      const send = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
      const sendNow = root.querySelector('[data-testid="terminal-scheduled-send-now"]') as HTMLButtonElement
      expect(sendNow.disabled).toBe(false)
      sendNow.click()
      await flushPromises()
      await nextTick()
      expect(send).toHaveBeenCalledWith('session-main', '立即发送前再次修改', { preserveDraft: true })
      expect(store.scheduledTerminalMessages['session-main']).toBeUndefined()
      expect(text.value).toBe('')
      send.mockRestore()
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
    store.scheduleTerminalMessage('session-main', '待取消', 1)
    await nextTick()
    ;(root.querySelector('[data-testid="terminal-scheduled-edit"]') as HTMLButtonElement).click()
    await nextTick()
    ;(root.querySelector('[data-testid="terminal-scheduled-edit-cancel"]') as HTMLButtonElement).click()
    await nextTick()
    expect(text.value).toBe('')
    expect(store.scheduledTerminalMessages['session-main'][0].text).toBe('待取消')
    ;(root.querySelector('[data-testid="terminal-scheduled-cancel"]') as HTMLButtonElement).click()
    await nextTick()
    expect(store.scheduledTerminalMessages['session-main']).toBeUndefined()
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

  it('refreshes changed Skills while the slash menu stays open and preserves its category and selection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    mocks.isTauri.mockReturnValue(true)
    const shared: SkillCompletionItem = { name: 'agent-shared', description: '旧的全局描述', scope: 'global', path: 'C:/skills/shared/SKILL.md' }
    const project: SkillCompletionItem = { name: 'agent-project', description: '旧的项目描述', scope: 'project', path: 'D:/skills/project/SKILL.md' }
    mocks.listSkills.mockResolvedValue([shared, project, { ...shared, name: 'agent-removed', path: 'C:/skills/removed/SKILL.md' }])
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    try {
      await nextTick()
      await flushPromises()
      const input = root.querySelector('.cli-message-input') as HTMLTextAreaElement
      input.value = '/agent'
      input.setSelectionRange(input.value.length, input.value.length)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      await flushPromises()
      const globalCategory = Array.from(root.querySelectorAll('.skill-completion-categories button'))
        .find((button) => button.textContent === '全局 Skills') as HTMLButtonElement
      globalCategory.click()
      await nextTick()
      const sharedItem = Array.from(root.querySelectorAll('.skill-completion-item'))
        .find((item) => item.textContent?.includes('/agent-shared'))!
      sharedItem.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      await nextTick()

      mocks.listSkills.mockResolvedValue([
        { ...shared, description: '新的全局描述' },
        { ...project, description: '新的项目描述' },
        { ...shared, name: 'agent-added', description: '新增技能', path: 'C:/skills/added/SKILL.md' },
      ])
      vi.advanceTimersByTime(2000)
      await flushPromises()
      await nextTick()
      expect(input.value).toBe('/agent')
      expect(root.querySelector('.skill-completion-categories [aria-selected="true"]')?.textContent).toBe('全局 Skills')
      expect(root.querySelector('.skill-completion-item.selected')?.textContent).toContain('/agent-shared')
      expect(root.querySelector('.skill-completion-detail-description')?.textContent).toBe('新的全局描述')
      expect(root.querySelector('.skill-completion-list')?.textContent).toContain('/agent-added')
      expect(root.querySelector('.skill-completion-list')?.textContent).not.toContain('/agent-removed')
      const projectCategory = Array.from(root.querySelectorAll('.skill-completion-categories button'))
        .find((button) => button.textContent === '项目 Skills') as HTMLButtonElement
      projectCategory.click()
      await nextTick()
      expect(root.querySelector('.skill-completion-detail-description')?.textContent).toBe('新的项目描述')

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await nextTick()
      const calls = mocks.listSkills.mock.calls.length
      vi.advanceTimersByTime(4000)
      await flushPromises()
      expect(mocks.listSkills).toHaveBeenCalledTimes(calls)
    } finally {
      app.unmount()
      root.remove()
      visible.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reloads filtered Skills on reopen and focus without overlapping requests or reopening a dismissed menu', async () => {
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Kimi', providerKind: 'kimi', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    mocks.isTauri.mockReturnValue(true)
    const skill: SkillCompletionItem = { name: 'agent-shared', description: '初始描述', scope: 'global', path: 'C:/skills/shared/SKILL.md' }
    mocks.listSkills.mockResolvedValue([skill])
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    try {
      await nextTick()
      await flushPromises()
      const input = root.querySelector('.cli-message-input') as HTMLTextAreaElement
      const enterQuery = async () => {
        input.value = '/agent'
        input.setSelectionRange(input.value.length, input.value.length)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await nextTick()
        await flushPromises()
      }
      await enterQuery()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await nextTick()
      mocks.listSkills.mockResolvedValue([{ ...skill, description: '重新打开后更新' }])
      await enterQuery()
      expect(root.querySelector('.skill-completion-detail-description')?.textContent).toBe('重新打开后更新')

      let finishRefresh!: (skills: SkillCompletionItem[]) => void
      mocks.listSkills.mockImplementationOnce(() => new Promise<SkillCompletionItem[]>((resolve) => { finishRefresh = resolve }))
      window.dispatchEvent(new Event('focus'))
      const calls = mocks.listSkills.mock.calls.length
      window.dispatchEvent(new Event('focus'))
      expect(mocks.listSkills).toHaveBeenCalledTimes(calls)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await nextTick()
      finishRefresh([{ ...skill, description: '迟到的更新' }])
      await flushPromises()
      await nextTick()
      expect(root.querySelector('.skill-completion-popup')).toBeNull()
      expect(input.value).toBe('/agent')
    } finally {
      app.unmount()
      root.remove()
      visible.mockRestore()
    }
    const calls = mocks.listSkills.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    expect(mocks.listSkills).toHaveBeenCalledTimes(calls)
  })

  it('selects a project or global Skill with arrow keys and Enter, then sends a compatible instruction', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Kimi', providerKind: 'kimi', cwd: 'D:/Demo Files' },
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
    // SuperHigh commands stay on top; project skills precede global ones by default.
    expect(items[0]?.textContent).toContain('/prompt')
    expect(items[1]?.textContent).toContain('/agents-updater')
    expect(items[2]?.textContent).toContain('/agent-review')
    expect(items[2]?.textContent).toContain('代码审查')
    expect(Array.from(root.querySelectorAll('.skill-completion-categories button')).map((tag) => tag.textContent))
      .toEqual(['全部', '系统', 'Agent CLI', '全局指令', '项目指令', '全局 Skills', '项目 Skills'])
    expect(root.querySelector('.skill-completion-group')).toBeNull()
    expect(root.querySelector('.skill-completion-detail-description')?.textContent).toBe('搜索并复用当前工作区的提示词')
    items[2]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('.skill-completion-detail-heading')?.textContent).toContain('/agent-review')
    expect(root.querySelector('.skill-completion-detail-heading')?.textContent).toContain('全局')
    expect(root.querySelector('.skill-completion-detail-description')?.textContent).toBe('代码审查')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    await nextTick()
    // Removing and reopening the slash menu must retain the selected skill.
    textarea.value = ''
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('.skill-completion-popup')).toBeNull()
    textarea.value = '/'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('.skill-completion-item.selected')?.textContent).toContain('/agents-updater')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()

    expect(root.querySelector('[data-testid="skill-invocation-chip"]')?.textContent).toContain('/agents-updater')
    expect(textarea.value).toBe('')

    textarea.value = '检查并更新配置'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith('session-main', '使用agents-updater\nSkill 文件：D:/Demo Files/.codex/skills/agents-updater/SKILL.md\nSkill 目录：D:/Demo Files/.codex/skills/agents-updater\n请先读取该 Skill 文件，并以 Skill 目录解析其中的相对路径。\n\n检查并更新配置'))
    expect(root.querySelector('[data-testid="skill-invocation-chip"]')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('cycles categories through empty lists and inserts registered content without sending', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', cwd: 'D:/Demo Files', title: 'Codex', providerKind: 'codex' }]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = { 'session-main': [] }
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
    mocks.isTauri.mockReturnValue(true)
    mocks.listSkills.mockResolvedValue([])
    mocks.listRegisteredCommands.mockResolvedValue([
      { commandId: 'review', name: 'review', description: '检查代码', content: '检查代码\n保留现有行为', scope: 'project', path: 'D:/Demo Files/.superhigh/commands.json' },
    ])
    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main' })
    await flushPromises()
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    textarea.value = '/'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const category = () => root.querySelector('.skill-completion-categories [aria-selected="true"]')?.textContent
    const arrow = async (key: string) => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await nextTick()
    }
    await arrow('ArrowLeft')
    expect(category()).toBe('项目 Skills')
    expect(root.querySelector('.skill-completion-popup')).not.toBeNull()
    expect(root.querySelectorAll('.skill-completion-item')).toHaveLength(0)
    await arrow('ArrowRight')
    expect(category()).toBe('全部')
    await arrow('ArrowRight')
    expect(category()).toBe('系统')
    expect(root.querySelector('.skill-completion-item')?.textContent).toContain('/prompt')
    await arrow('ArrowRight')
    expect(category()).toBe('Agent CLI')
    await arrow('ArrowRight')
    expect(category()).toBe('全局指令')
    await arrow('ArrowRight')
    expect(category()).toBe('项目指令')
    expect(root.querySelector('.skill-completion-item')?.textContent).toContain('/review')
    root.querySelector('.skill-completion-categories button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(category()).toBe('全部')
    root.querySelectorAll('.skill-completion-categories button')[4]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(textarea.value).toBe('检查代码\n保留现有行为')
    expect(sendMessage).not.toHaveBeenCalled()
    mocks.listRegisteredCommands.mockResolvedValue([])
    expect(root.querySelector('.skill-completion-popup')).toBeNull()
    expect(root.querySelector('[data-testid="skill-invocation-chip"]')).toBeNull()
    app.unmount()
    root.remove()
  })

  it('returns from a native question to chat without cancelling it and can reopen the same form', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    store.settings.cliViewMode = 'chat'
    mocks.isTauri.mockReturnValue(true)
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    try {
      await nextTick()
      await flushPromises()
      const terminal = mocks.terminalInstances[0]!
      const rows = ['Question 1/2', 'Choose colour', '› 1. Blue', '  2. Green', 'tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt']
      terminal.buffer.active.getLine.mockImplementation((row: number) => ({ translateToString: () => rows[row] ?? '', getCell: () => undefined }))
      const output = mocks.onTerminalOutput.mock.calls.at(-1)![0]
      output({ sessionId: 'session-main', chunk: 'question', startByte: 0, endByte: 8 })
      await vi.waitFor(() => expect(root.querySelector('.with-native-cli')).not.toBeNull())
      mocks.writeTerminalInput.mockClear()
      const back = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '返回聊天')!
      back.click()
      await nextTick()
      expect(root.querySelector('.with-native-cli')).toBeNull()
      expect(mocks.writeTerminalInput).not.toHaveBeenCalled()
      const reopen = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('继续操作 CLI 面板'))!
      reopen.click()
      await nextTick()
      expect(root.querySelector('.with-native-cli')).not.toBeNull()
      expect(mocks.writeTerminalInput).not.toHaveBeenCalled()
    } finally { app.unmount(); root.remove() }
  })

  it.each(['chat', 'work'] as const)('uses the built-in Agent CLI catalog without scanning the terminal in %s mode', async (mode) => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    store.settings.cliViewMode = mode
    mocks.isTauri.mockReturnValue(true)
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    try {
      await nextTick()
      await flushPromises()
      mocks.writeTerminalInput.mockClear()
      const input = root.querySelector(mode === 'chat' ? '.cli-chat-input' : '.cli-message-input') as HTMLTextAreaElement
      input.value = '/'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.waitFor(() => {
        expect([...root.querySelectorAll('.skill-completion-item')].some(item => item.textContent?.includes('/model'))).toBe(true)
      }, { interval: 5 })
      const items = () => [...root.querySelectorAll('.skill-completion-item')]
      expect(items().length).toBeGreaterThan(10)
      expect(items().find(item => item.textContent?.includes('/model'))?.textContent).toContain('选择模型和推理强度')
      expect(mocks.writeTerminalInput.mock.calls.filter(([, value]) => value === '\u001b[A')).toHaveLength(0)

      input.value = '/model'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
      expect(items()).toHaveLength(1)
      expect(items()[0]?.textContent).toContain('/model')

      store.settings.agentCliCommandTranslation = false
      await nextTick()
      expect(items()[0]?.textContent).toContain('Choose what model and reasoning effort to use')
      expect(items()[0]?.textContent).not.toContain('选择模型和推理强度')
    } finally { app.unmount(); root.remove() }
  })

  it.each(['claude', 'codex', 'kimi', 'grok', 'gemini', 'opencode', 'codebuddy'] as const)('shares %s chat drafts and slash completions with the work composer', async (providerKind) => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Agent CLI', providerKind, cwd: 'D:/Demo Files' }]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.settings.cliViewMode = 'chat'
    mocks.isTauri.mockReturnValue(true)
    mocks.listSkills.mockResolvedValue([{ name: 'review-skill', description: 'Review code', scope: 'project', path: 'D:/Demo Files/.codex/skills/review-skill/SKILL.md' }])
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
    const { app, root } = mountPane(pinia, { mode: 'cli' })
    try {
      await nextTick()
      await flushPromises()
      const input = root.querySelector('.cli-chat-input') as HTMLTextAreaElement
      input.value = '/review-skill'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
      expect(store.terminalDrafts['session-main']).toBe('/review-skill')
      expect(root.querySelectorAll('.skill-completion-popup')).toHaveLength(1)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      await nextTick()
      expect(root.querySelectorAll('[data-testid="skill-invocation-chip"]')).toHaveLength(1)
      expect(sendMessage).not.toHaveBeenCalled()
      root.querySelector('.cli-chat-send')!.dispatchEvent(new MouseEvent('click'))
      await flushPromises()
      expect(sendMessage).toHaveBeenCalledWith('session-main', expect.stringContaining('Skill 文件：D:/Demo Files/.codex/skills/review-skill/SKILL.md'))
      store.setTerminalDraft('session-main', 'keep this draft')
      await nextTick()
      store.settings.cliViewMode = 'work'
      await nextTick()
      expect((root.querySelector('.cli-message-input') as HTMLTextAreaElement).value).toBe('keep this draft')
    } finally { app.unmount(); root.remove() }
  })

  it('stacks several Skills from repeated slash menus and sends them together', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Kimi', providerKind: 'kimi', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = { 'session-main': [] }
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
    mocks.isTauri.mockReturnValue(true)
    mocks.listSkills.mockResolvedValue([
      { name: 'agent-review', description: '代码审查', scope: 'global', path: 'C:/skills/agent-review/SKILL.md' },
      { name: 'agents-updater', description: '维护 Agent 资源', scope: 'project', path: 'D:/skills/agents-updater/SKILL.md' },
    ])
    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main' })
    await nextTick()
    await flushPromises()
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    const pick = async (query: string) => {
      textarea.value = query
      textarea.setSelectionRange(query.length, query.length)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await nextTick()
    }
    const chips = () => Array.from(root.querySelectorAll('[data-testid="skill-invocation-chip"]')).map((chip) => chip.textContent?.trim())

    await pick('/agents')
    await pick('/')
    // Already selected skills and /prompt leave the second menu.
    expect(chips()).toEqual(['/agents-updater', '/agent-review'])
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    await nextTick()
    expect(chips()).toEqual(['/agents-updater'])
    await pick('/agent-r')
    textarea.value = '开始'
    textarea.setSelectionRange(2, 2)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(sendMessage.mock.calls[0]?.[1]).toMatch(/^使用agents-updater、agent-review\n\[agents-updater\]\n/)
    expect(chips()).toEqual([])
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
      { id: 'session-main', title: 'Kimi', providerKind: 'kimi', cwd: 'D:/Demo Files' },
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
    // Filtering alone also establishes the remembered selection, without an arrow or hover.
    textarea.value = ''
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    textarea.value = '/'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root.querySelector('.skill-completion-item.selected')?.textContent).toContain('/Agent Browser')
    textarea.value = '/Agent'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    store.settings.activePreviewMode = 'local_terminal'
    root.querySelector('.skill-completion-item')?.dispatchEvent(
      new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }),
    )
    await nextTick()
    expect(root.querySelector('[data-testid="skill-invocation-chip"]')).toBeNull()
    expect(root.querySelector('.skill-completion-popup')).not.toBeNull()
    root.querySelector('.skill-completion-item')?.dispatchEvent(
      new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(openFile).toHaveBeenCalledWith('C:/skills/agent-browser/SKILL.md', {
      createUnsupportedTabOnError: false, verifyExistingFile: true, revealInExplorer: false,
    })
    expect(store.settings.activePreviewMode).toBe('code')
    expect(textarea.value).toBe('/Agent')
    expect(root.querySelector('.skill-completion-popup')).not.toBeNull()
    expect(root.querySelector('.skill-completion-item.selected')?.textContent).toContain('/Agent Browser')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    root.querySelector('.skill-completion-item')?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }),
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



  it('ignores global inserts while the terminal pane is hidden', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeCliSessionId = 'session-main'
    const { app, root } = mountPane(pinia, { mode: 'cli', visible: false })
    await nextTick()
    await flushPromises()
    window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', { detail: { text: 'wrong session', insertMode: 'plain' } }))
    await nextTick()
    expect(store.terminalDrafts['session-main'] ?? '').toBe('')
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

  it('replays raw terminal colors when switching themes without sending input to the CLI', async () => {
    const store = useWorkspaceStore()
    store.settings.themeId = 'dark'
    store.terminalSessions = [{ id: 'session-main', title: 'Claude', providerKind: 'claude', cwd: 'D:/Demo Files' }]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    const output = '\x1b[48;2;41;41;41mPrompt\x1b[0m'
    mocks.getTerminalBuffer.mockResolvedValue({ buffer: output, startByte: 0, endByte: output.length })
    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main' })
    await flushPromises()
    const terminal = mocks.terminalInstances[0]!
    terminal.write.mockClear()
    mocks.writeTerminalInput.mockClear()
    store.settings.themeId = 'opencode-github-light'
    await nextTick()
    await flushPromises()
    const rgb = getTheme('opencode-github-light').colors.bg.secondary.match(/\w\w/g)!.map((part) => parseInt(part, 16)).join(';')
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toContain(`\x1b[48;2;${rgb}mPrompt`)
    terminal.write.mockClear()
    store.settings.themeId = 'dark'
    await nextTick()
    await flushPromises()
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toContain(output)
    expect(mocks.writeTerminalInput).not.toHaveBeenCalled()
    app.unmount()
    root.remove()
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

  it('turns copied system files into paths in the CLI draft', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' },
    ]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.terminalDrafts = { 'session-main': '请检查这些文件' }
    store.showActivityMessage = vi.fn()
    store.showErrorMessage = vi.fn()
    mocks.readFilesFromClipboard.mockResolvedValue([
      'E:/AnthropicMono-Roman-Web.woff2',
      'E:/AnthropicSans-Roman-Web.woff2',
      'E:/AnthropicSerif-Roman-Web.woff2',
    ])

    const { app, root } = mountPane(pinia, {
      mode: 'cli',
      sessionIds: ['session-main'],
      activeSessionId: 'session-main',
    })
    await nextTick()
    await flushPromises()
    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [new File([], 'AnthropicMono-Roman-Web.woff2')],
        items: [],
        types: ['Files'],
      },
    })
    textarea.dispatchEvent(pasteEvent)
    await flushPromises()
    await nextTick()

    expect(pasteEvent.defaultPrevented).toBe(true)
    expect(mocks.readFilesFromClipboard).toHaveBeenCalledOnce()
    expect(textarea.value).toBe(
      '请检查这些文件\nE:/AnthropicMono-Roman-Web.woff2\nE:/AnthropicSans-Roman-Web.woff2\nE:/AnthropicSerif-Roman-Web.woff2',
    )
    expect(store.showActivityMessage).toHaveBeenCalledWith('已插入 3 个文件路径')

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
        + '图片5路径：D:/Demo Files/.superhigh/pasted-images/image-5.png',
    )
    expect(root.querySelector('[data-testid="terminal-image-attachments"]')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('exports long pasted text as a card and references marked files with @', async () => {
    mocks.isTauri.mockReturnValue(true)
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
    const saved = { path: 'D:/Demo Files/.agent/tmp/SH粘贴-2026年10月21日14时05分33秒.txt', name: 'SH粘贴-2026年10月21日14时05分33秒.txt', size: 1503, modifiedMs: 2 }
    const older = { path: 'D:/Demo Files/.agent/tmp/SH粘贴-2026年10月20日09时00分00秒.txt', name: 'SH粘贴-2026年10月20日09时00分00秒.txt', size: 900, modifiedMs: 1 }
    mocks.savePastedText.mockResolvedValue(saved)
    mocks.listPastedTexts.mockResolvedValue([saved, older])

    const { app, root } = mountPane(pinia, { mode: 'cli', sessionIds: ['session-main'], activeSessionId: 'session-main' })
    await nextTick()
    await flushPromises()

    const textarea = root.querySelector('.cli-message-input') as HTMLTextAreaElement
    const longText = '长'.repeat(501)
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [], items: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? longText : '' },
    })
    textarea.dispatchEvent(pasteEvent)
    await flushPromises()
    await nextTick()

    expect(pasteEvent.defaultPrevented).toBe(true)
    expect(mocks.savePastedText).toHaveBeenCalledWith('D:/Demo Files', expect.stringMatching(/^\d{4}年\d{2}月\d{2}日\d{2}时\d{2}分\d{2}秒$/), longText)
    expect(root.querySelectorAll('[data-testid="terminal-text-attachments"] .cli-image-chip')).toHaveLength(1)

    textarea.value = '看 @20日'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await nextTick()
    expect(mocks.listPastedTexts).toHaveBeenCalledWith('D:/Demo Files')
    const popup = root.querySelector('[aria-label="粘贴文本引用"]')
    expect(popup?.textContent).toContain(older.name)
    expect(popup?.textContent).not.toContain(saved.name)
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    await nextTick()

    expect(root.querySelector('[aria-label="粘贴文本引用"]')).toBeNull()
    expect(root.querySelectorAll('[data-testid="terminal-text-attachments"] .cli-image-chip')).toHaveLength(2)
    expect(store.sendTerminalConversationMessage).not.toHaveBeenCalled()
    ;(root.querySelector('.cli-input-shell .primary-button') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()

    expect(store.sendTerminalConversationMessage).toHaveBeenCalledWith(
      'session-main',
      `文本1路径：${saved.path}\n文本2路径：${older.path}\n看`,
    )
    expect(root.querySelector('[data-testid="terminal-text-attachments"]')).toBeNull()
    app.unmount()
    root.remove()
  })

})
