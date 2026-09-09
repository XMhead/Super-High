import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DragonCoreCliDialog from './DragonCoreCliDialog.vue'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('./TerminalPane.vue', () => ({
  default: defineComponent({
    name: 'TerminalPaneStub',
    render: () => h('div', { 'data-testid': 'terminal-pane' }, 'TerminalPane'),
  }),
}))

function mountDialog(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(DragonCoreCliDialog) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('DragonCoreCliDialog', () => {
  let pinia: Pinia

  beforeEach(() => {
    document.body.innerHTML = ''
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('only opens on the Minecraft surface while DragonCore mode is active', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceSurface = 'project'
    store.dragonCoreModeOpen = true
    const { app, root } = mountDialog(pinia)
    await nextTick()

    window.dispatchEvent(new CustomEvent('superhigh:open-dragoncore-cli-dialog'))
    await nextTick()
    expect(root.querySelector('[data-testid="dragoncore-cli-dialog"]')).toBeNull()

    store.activeWorkspaceSurface = 'minecraft'
    await nextTick()
    window.dispatchEvent(new CustomEvent('superhigh:open-dragoncore-cli-dialog'))
    await nextTick()

    expect(root.querySelector('[data-testid="dragoncore-cli-dialog"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="terminal-pane"]')).toBeTruthy()

    store.dragonCoreModeOpen = false
    await nextTick()
    expect(root.querySelector('[data-testid="dragoncore-cli-dialog"]')).toBeNull()

    app.unmount()
    root.remove()
  })
})
