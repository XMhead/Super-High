import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConversationSidebar from './ConversationSidebar.vue'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function mountSidebar(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(ConversationSidebar) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('ConversationSidebar keyboard navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('switches CLI conversations with ArrowUp and ArrowDown without wrapping', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-1', title: 'Codex', providerKind: 'codex', cwd: 'D:/Project' },
      { id: 'session-2', title: 'Claude', providerKind: 'claude', cwd: 'D:/Project' },
      { id: 'session-3', title: 'Kimi', providerKind: 'kimi', cwd: 'D:/Project' },
    ]
    store.activeCliSessionId = 'session-2'
    store.activeTerminalSessionId = 'session-2'
    const { app, root } = mountSidebar(pinia)
    await nextTick()

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    window.dispatchEvent(up)
    await nextTick()
    expect(store.activeCliSessionId).toBe('session-1')
    expect(store.activeTerminalSessionId).toBe('session-1')
    expect(up.defaultPrevented).toBe(true)

    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    window.dispatchEvent(down)
    await nextTick()
    expect(store.activeCliSessionId).toBe('session-2')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await nextTick()
    expect(store.activeCliSessionId).toBe('session-1')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const bottom = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    window.dispatchEvent(bottom)
    await nextTick()
    expect(store.activeCliSessionId).toBe('session-3')
    expect(bottom.defaultPrevented).toBe(false)

    app.unmount()
    root.remove()
  })

  it('leaves arrow keys in editable controls untouched', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-1', title: 'Codex', providerKind: 'codex', cwd: 'D:/Project' },
      { id: 'session-2', title: 'Claude', providerKind: 'claude', cwd: 'D:/Project' },
    ]
    store.activeCliSessionId = 'session-1'
    store.activeTerminalSessionId = 'session-1'
    const { app, root } = mountSidebar(pinia)
    await nextTick()

    const input = document.createElement('textarea')
    root.appendChild(input)
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    input.dispatchEvent(down)
    await nextTick()

    expect(store.activeCliSessionId).toBe('session-1')
    expect(down.defaultPrevented).toBe(false)

    app.unmount()
    root.remove()
  })
})
