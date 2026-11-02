import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MinecraftPanel from './MinecraftPanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { MinecraftClientConfig, MinecraftClientStatus, Workspace } from '@/types'

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function mountPanel(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(MinecraftPanel) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

function mountCachedPanel(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const active = ref(true)
  const app = createApp(defineComponent({
    render: () => h(KeepAlive, null, {
      default: () => active.value ? h(MinecraftPanel) : null,
    }),
  }))
  app.use(pinia)
  app.mount(root)
  return { app, root, active }
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
  await nextTick()
}

function workspace(): Workspace {
  return {
    id: 'workspace-1',
    name: 'Test',
    displayName: 'Test',
    rootPath: 'D:/One',
    openedAt: '2026-07-15T00:00:00Z',
  }
}

function minecraftConfig(): MinecraftClientConfig {
  return {
    projectPath: 'D:/One',
    configPath: 'D:/One/.superhigh/minecraft-client.json',
    displayName: 'Test Minecraft',
    clientRoot: 'D:/One/client',
    launcherPath: 'D:/One/client/launcher.exe',
    embedTarget: 'final-game-window',
    windowTitleIncludes: ['Minecraft'],
    processNames: ['javaw.exe'],
    startupTimeoutMs: 180000,
  }
}

function minecraftStatus(state: string, overrides: Partial<MinecraftClientStatus> = {}): MinecraftClientStatus {
  return {
    state,
    message: '',
    config: null,
    windowTitle: null,
    processId: null,
    embedded: false,
    ...overrides,
  }
}

function installHideMinecraftClientSpy(store: ReturnType<typeof useWorkspaceStore>) {
  const hideMinecraftClient = vi.fn().mockResolvedValue(undefined)
  ;(store as typeof store & { hideMinecraftClient: typeof hideMinecraftClient }).hideMinecraftClient = hideMinecraftClient
  return hideMinecraftClient
}

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('MinecraftPanel', () => {
  let pinia: Pinia
  let rectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      width: 800,
      height: 450,
      top: 20,
      left: 10,
      right: 810,
      bottom: 470,
      toJSON: () => ({}),
    } as DOMRect)
  })

  it('starts, embeds, and releases the Minecraft client through the workspace store', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfigError = 'skip auto attach'
    store.minecraftClientStatus = minecraftStatus('embedded', { embedded: true })
    store.startMinecraftClient = vi.fn().mockImplementation(async () => {
      store.minecraftClientStatus = minecraftStatus('embedded', { embedded: true })
    })
    store.embedMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValue(store.minecraftClientStatus)
    const { app, root } = mountPanel(pinia)
    await nextTick()

    root.querySelector<HTMLButtonElement>('[data-testid="minecraft-start"]')!.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="minecraft-embed"]')!.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="minecraft-release"]')!.click()
    await nextTick()

    expect(store.startMinecraftClient).toHaveBeenCalledOnce()
    expect(store.embedMinecraftClient).toHaveBeenCalledTimes(2)
    expect(store.releaseMinecraftClient).toHaveBeenCalledOnce()

    app.unmount()
    root.remove()
  })

  it('automatically starts and embeds a ready Minecraft client when opened', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfig = minecraftConfig()
    store.minecraftClientStatus = minecraftStatus('ready')
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValueOnce(store.minecraftClientStatus)
    store.startMinecraftClient = vi.fn().mockImplementation(async () => {
      store.minecraftClientStatus = minecraftStatus('running', {
        windowTitle: '地平线 v1.1-持续更新中',
        processId: 123,
      })
    })
    store.embedMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    expect(store.refreshMinecraftClientStatus).toHaveBeenCalledOnce()
    expect(store.startMinecraftClient).toHaveBeenCalledOnce()
    expect(store.embedMinecraftClient).toHaveBeenCalledWith({ x: 10, y: 20, width: 800, height: 450 })

    app.unmount()
    root.remove()
  })

  it('automatically embeds an already running Minecraft window when opened', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfig = minecraftConfig()
    store.minecraftClientStatus = minecraftStatus('running', {
      windowTitle: '地平线 v1.1-持续更新中',
      processId: 123,
    })
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValue(store.minecraftClientStatus)
    store.embedMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.startMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    expect(store.refreshMinecraftClientStatus).toHaveBeenCalledOnce()
    expect(store.embedMinecraftClient).toHaveBeenCalledOnce()
    expect(store.startMinecraftClient).not.toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('waits for an already running Minecraft window to stabilize before embedding', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfig = minecraftConfig()
    store.minecraftClientStatus = minecraftStatus('starting')
    store.refreshMinecraftClientStatus = vi.fn()
      .mockResolvedValueOnce(minecraftStatus('starting'))
      .mockResolvedValueOnce(minecraftStatus('running', {
        windowTitle: '地平线 v1.1-持续更新中',
        processId: 123,
      }))
    store.embedMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.startMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    expect(store.refreshMinecraftClientStatus).toHaveBeenCalledTimes(2)
    expect(store.startMinecraftClient).not.toHaveBeenCalled()
    expect(store.embedMinecraftClient).toHaveBeenCalledWith({ x: 10, y: 20, width: 800, height: 450 })

    app.unmount()
    root.remove()
  })

  it('waits for a non-zero viewport before embedding a running Minecraft window', async () => {
    rectSpy
      .mockReturnValueOnce({
        x: 10,
        y: 20,
        width: 800,
        height: 0,
        top: 20,
        left: 10,
        right: 810,
        bottom: 20,
        toJSON: () => ({}),
      } as DOMRect)
      .mockReturnValue({
        x: 10,
        y: 20,
        width: 800,
        height: 450,
        top: 20,
        left: 10,
        right: 810,
        bottom: 470,
        toJSON: () => ({}),
      } as DOMRect)
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfig = minecraftConfig()
    store.minecraftClientStatus = minecraftStatus('running', {
      windowTitle: '地平线 v1.1-持续更新中',
      processId: 123,
    })
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValue(store.minecraftClientStatus)
    store.embedMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.startMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    expect(store.embedMinecraftClient).toHaveBeenCalledOnce()
    expect(store.embedMinecraftClient).toHaveBeenCalledWith({ x: 10, y: 20, width: 800, height: 450 })

    app.unmount()
    root.remove()
  })



  it('shows a diagnostic status when auto start succeeds but embed fails', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfig = minecraftConfig()
    store.minecraftClientStatus = minecraftStatus('ready')
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValueOnce(store.minecraftClientStatus)
    store.startMinecraftClient = vi.fn().mockImplementation(async () => {
      store.minecraftClientStatus = minecraftStatus('running', { processId: 123 })
    })
    store.embedMinecraftClient = vi.fn().mockRejectedValue(new Error('final Java window handle not found'))
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    expect(store.startMinecraftClient).toHaveBeenCalledOnce()
    expect(store.embedMinecraftClient).toHaveBeenCalledOnce()
    expect(root.querySelector('.minecraft-panel-status')?.textContent).toContain('final Java window handle not found')

    app.unmount()
    root.remove()
  })

  it('does not render successful backend status messages as a layout row', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientBusy = true
    store.minecraftClientStatus = minecraftStatus('embedded', {
      embedded: true,
      message: 'Minecraft game window resized',
    })
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    installHideMinecraftClientSpy(store)
    const { app, root } = mountPanel(pinia)
    await nextTick()

    expect(root.querySelector('.minecraft-panel-status')).toBeNull()

    app.unmount()
    root.remove()
  })



  it('restores the cached embedded window after switching workspace surfaces', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfigError = 'skip auto attach'
    store.minecraftClientStatus = minecraftStatus('embedded', { embedded: true })
    const hideMinecraftClient = installHideMinecraftClientSpy(store)
    store.showMinecraftClient = vi.fn().mockResolvedValue(undefined)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const { app, root, active } = mountCachedPanel(pinia)
    await flushPromises()

    active.value = false
    await flushPromises()
    expect(hideMinecraftClient).toHaveBeenCalledOnce()

    active.value = true
    await flushPromises()
    expect(store.showMinecraftClient).toHaveBeenCalledOnce()

    app.unmount()
    root.remove()
  })

  it('hides again when a pending embed finishes after switching workspace surfaces', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfig = minecraftConfig()
    store.minecraftClientStatus = minecraftStatus('running', { processId: 123 })
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValue(store.minecraftClientStatus)
    const embed = deferred()
    const calls: string[] = []
    store.embedMinecraftClient = vi.fn().mockImplementation(async () => {
      await embed.promise
      calls.push('embed-finished')
      store.minecraftClientStatus = minecraftStatus('embedded', { embedded: true })
    })
    store.hideMinecraftClient = vi.fn().mockImplementation(async () => {
      calls.push('hide')
    })
    const { app, root, active } = mountCachedPanel(pinia)
    await flushPromises()
    expect(store.embedMinecraftClient).toHaveBeenCalledOnce()

    active.value = false
    await flushPromises()
    embed.resolve()
    await flushPromises()

    expect(store.hideMinecraftClient).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['hide', 'embed-finished', 'hide'])

    app.unmount()
    root.remove()
  })

  it('makes hide the final native operation when a pending resize finishes after deactivation', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfigError = 'skip auto attach'
    store.minecraftClientStatus = minecraftStatus('embedded', { embedded: true })
    const resize = deferred()
    const calls: string[] = []
    store.resizeMinecraftClient = vi.fn().mockImplementation(async () => {
      await resize.promise
      calls.push('resize-finished')
    })
    store.hideMinecraftClient = vi.fn().mockImplementation(async () => {
      calls.push('hide')
    })
    const { app, root, active } = mountCachedPanel(pinia)
    await flushPromises()
    expect(store.resizeMinecraftClient).toHaveBeenCalledOnce()

    active.value = false
    await flushPromises()
    resize.resolve()
    await flushPromises()

    expect(store.hideMinecraftClient).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['hide', 'resize-finished', 'hide'])

    app.unmount()
    root.remove()
  })

  it('always hides on unmount even if the current store state never reported an embed', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfigError = 'skip auto attach'
    store.minecraftClientStatus = minecraftStatus('running', { embedded: false })
    const hideMinecraftClient = installHideMinecraftClientSpy(store)
    const { app, root } = mountPanel(pinia)
    await nextTick()

    app.unmount()
    await flushPromises()

    expect(hideMinecraftClient).toHaveBeenCalledOnce()
    root.remove()
  })

  it('hides the native embedded window on unmount even after workspace state is reset', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace()
    store.minecraftClientConfigError = 'skip auto attach'
    store.minecraftClientStatus = minecraftStatus('embedded', { embedded: true })
    store.refreshMinecraftClientStatus = vi.fn().mockResolvedValue(store.minecraftClientStatus)
    store.releaseAllMinecraftClients = vi.fn().mockResolvedValue(undefined)
    const hideMinecraftClient = installHideMinecraftClientSpy(store)
    const { app, root } = mountPanel(pinia)
    await nextTick()

    store.workspace = null
    store.minecraftClientStatus = null
    await nextTick()
    app.unmount()

    expect(hideMinecraftClient).toHaveBeenCalledOnce()
    expect(store.releaseAllMinecraftClients).not.toHaveBeenCalled()

    root.remove()
  })
})
