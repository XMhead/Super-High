import { createApp, defineComponent, h, nextTick, onMounted, onUnmounted } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import WorkspaceShell from './WorkspaceShell.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
beforeEach(() => { lifecycle.mounts = 0; lifecycle.unmounts = 0 })
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn() }))
vi.mock('./AppTopBar.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ActivityBar.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ExplorerPane.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./FileManagerPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./MinecraftPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./MemoWindow.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./NewConversationDialog.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ChannelProbePanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ConversationMapPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ScriptToolsPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./SettingsDrawer.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./PreviewPane.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./TerminalPane.vue', () => ({
  default: defineComponent({
    setup() {
      onMounted(() => lifecycle.mounts++)
      onUnmounted(() => lifecycle.unmounts++)
      return () => h('div', { 'data-terminal': '' })
    },
  }),
}))

function pointer(target: EventTarget, type: string, values: Record<string, number> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...values })
  Object.defineProperty(event, 'pointerId', { value: values.pointerId ?? 7 })
  target.dispatchEvent(event)
}

it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'released-buttons', 'hidden', 'unmount'])(
  'ends panel resizing after %s and removes gesture listeners', async (ending) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.activeWorkspaceSurface = 'project'
    store.settings.multiTerminalMode = false
    store.settings.dialogueMapMode = false
    const save = vi.spyOn(store, 'saveSettings').mockResolvedValue()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(WorkspaceShell).use(pinia)
    app.mount(root)
    const separator = root.querySelector('[aria-label="调整 CLI 终端和代码预览宽度"]') as HTMLElement
    const capture = vi.fn()
    const release = vi.fn()
    separator.setPointerCapture = capture
    separator.hasPointerCapture = () => true
    separator.releasePointerCapture = release
    let mounted = true
    try {
      const initial = store.settings.panelLayout.conversationWidth
      pointer(separator, 'pointerdown', { clientX: 100, button: 2 })
      expect(capture).not.toHaveBeenCalled()
      pointer(separator, 'pointerdown', { clientX: 100 })
      expect(capture).toHaveBeenCalledWith(7)
      pointer(window, 'pointermove', { clientX: 120, pointerId: 8 })
      pointer(window, 'pointerup', { pointerId: 8 })
      expect(store.settings.panelLayout.conversationWidth).toBe(initial)
      pointer(window, 'pointermove', { clientX: 120 })
      expect(store.settings.panelLayout.conversationWidth).toBe(initial + 20)
      if (ending === 'blur') window.dispatchEvent(new Event('blur'))
      else if (ending === 'released-buttons') pointer(window, 'pointermove', { clientX: 180, buttons: 0 })
      else if (ending === 'hidden') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        document.dispatchEvent(new Event('visibilitychange'))
      } else if (ending === 'unmount') { app.unmount(); mounted = false }
      else pointer(ending === 'lostpointercapture' ? separator : window, ending)
      pointer(window, 'pointermove', { clientX: 220 })
      expect(store.settings.panelLayout.conversationWidth).toBe(initial + 20)
      expect(document.documentElement.classList.contains('is-resizing-panels')).toBe(false)
      expect(release).toHaveBeenCalledWith(7)
      expect(save).toHaveBeenCalledTimes(1)
    } finally {
      if (mounted) app.unmount()
      root.remove()
      vi.restoreAllMocks()
    }
  },
)

it('preserves the workspace terminal across repeated settings switches without background probes', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.activeWorkspaceSurface = 'project'
  store.settings.multiTerminalMode = false
  store.settings.dialogueMapMode = false
  const cli = vi.spyOn(store, 'refreshCliEnvironments').mockResolvedValue()
  const storage = vi.spyOn(store, 'refreshAppStorageInfo').mockResolvedValue()
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(WorkspaceShell).use(pinia)
  app.mount(root)
  try {
    await nextTick()
    const terminal = root.querySelector('[data-terminal]')
    expect(terminal).not.toBeNull()
    for (let index = 0; index < 3; index++) {
      store.setSettingsOpen(true)
      await nextTick()
      expect((root.querySelector('.workspace-surface') as HTMLElement).style.display).toBe('none')
      expect(root.querySelector('[data-terminal]')).toBe(terminal)
      store.setSettingsOpen(false)
      await nextTick()
      expect((root.querySelector('.workspace-surface') as HTMLElement).style.display).not.toBe('none')
      expect(root.querySelector('[data-terminal]')).toBe(terminal)
    }
    vi.spyOn(store, 'saveSettings').mockResolvedValue()
    store.setConversationSidebarVisible(false)
    const f1 = new KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true })
    terminal!.dispatchEvent(f1)
    await nextTick()
    expect(f1.defaultPrevented).toBe(true)
    expect(store.settings.explorerVisible).toBe(false)
    expect((root.querySelector('.workspace-main') as HTMLElement).style.gridTemplateColumns)
      .toBe('44px minmax(300px, 520px) 1px minmax(280px, 1fr)')
    terminal!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', repeat: true, bubbles: true }))
    expect(store.settings.explorerVisible).toBe(false)
    terminal!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }))
    await nextTick()
    expect(store.settings.explorerVisible).toBe(true)
    expect(root.querySelector('[data-terminal]')).toBe(terminal)
    expect(lifecycle.mounts).toBe(1)
    expect(lifecycle.unmounts).toBe(0)
    expect(cli).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  } finally {
    app.unmount()
    root.remove()
    vi.restoreAllMocks()
  }
})
