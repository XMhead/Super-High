import { createApp, defineComponent, h, nextTick, onMounted, onUnmounted } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import WorkspaceShell from './WorkspaceShell.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn() }))
vi.mock('./AppTopBar.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ActivityBar.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ConversationSidebar.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./DragonCoreToolsWindowManager.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ExplorerPane.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./FileManagerPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ItemLibrarySearchDialog.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./MinecraftPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./MemoWindow.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./NewConversationDialog.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ChannelProbePanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ConversationMapPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./DocsWorkspacePanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ProjectEditorPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./ScriptToolsPanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('./DragonImagePanel.vue', () => ({ __esModule: true, default: { render: () => null } }))
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

