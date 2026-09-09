import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConversationPane from './ConversationPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
  loadMonaco: vi.fn(),
}))

vi.mock('@/lib/voiceInput', () => ({
  appendVoiceText: (current: string, text: string) => `${current}${text}`,
  useVoiceInput: () => ({
    isVoiceListening: false,
    voiceButtonTitle: '',
    voiceInputAvailable: false,
    voiceInputState: 'idle',
    voiceStatusMessage: '',
    toggleVoiceInput: vi.fn(),
  }),
}))

describe('ConversationPane', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function mountPane() {
    const app = createApp(ConversationPane)
    app.use(pinia)
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    return { app, root }
  }

  function seedHistory() {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/ExampleProject' },
    ]
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [
        {
          id: 'oldest',
          sessionId: 'session-main',
          role: 'user',
          content: 'deploy old version',
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
          content: 'Deploy newest\nwith details',
          timestamp: '2026-08-20T10:00:00.000Z',
        },
      ],
    }
  }

  it('does not show history completion or intercept Tab while disabled', async () => {
    seedHistory()
    const { app, root } = mountPane()
    await nextTick()

    const textarea = root.querySelector('.conversation-input') as HTMLTextAreaElement
    textarea.value = 'deP'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const items = root.querySelectorAll('.history-completion-item')
    expect(items).toHaveLength(0)
    expect(textarea.value).toBe('deP')

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(tab)
    await nextTick()
    expect(tab.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('deP')
    expect(root.querySelector('.history-completion-popup')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('does not reveal a matching history item while disabled', async () => {
    seedHistory()
    const { app, root } = mountPane()
    await nextTick()

    const textarea = root.querySelector('.conversation-input') as HTMLTextAreaElement
    textarea.value = 'TASK'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(root.querySelectorAll('.history-completion-item')).toHaveLength(0)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(tab)
    await nextTick()
    expect(tab.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('TASK')

    app.unmount()
    root.remove()
  })

  it('leaves Tab alone and keeps Enter behavior', async () => {
    seedHistory()
    const store = useWorkspaceStore()
    const sendMessage = vi.spyOn(store, 'sendTerminalConversationMessage').mockResolvedValue(true)
    const { app, root } = mountPane()
    await nextTick()

    const textarea = root.querySelector('.conversation-input') as HTMLTextAreaElement
    textarea.value = ''
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const emptyTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(emptyTab)
    expect(emptyTab.defaultPrevented).toBe(false)

    textarea.value = 'missing'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const missingTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(missingTab)
    expect(missingTab.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('missing')
    await nextTick()
    expect(root.querySelector('.history-completion-popup')).toBeNull()
    expect(root.querySelector('.history-no-match')).toBeNull()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    textarea.dispatchEvent(enter)
    await nextTick()
    expect(enter.defaultPrevented).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith('session-main', 'missing')

    app.unmount()
    root.remove()
  })

  it('does not complete the current word fragment while disabled', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/ExampleProject' },
    ]
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': [{
        id: 'known',
        sessionId: 'session-main',
        role: 'user',
        content: '使用agents-updater skills',
        timestamp: '2026-08-20T10:00:00.000Z',
      }],
    }

    const { app, root } = mountPane()
    await nextTick()

    const textarea = root.querySelector('.conversation-input') as HTMLTextAreaElement
    textarea.value = '使用ag'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(root.querySelectorAll('.history-completion-item')).toHaveLength(0)
    expect(textarea.value).toBe('使用ag')

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(tab)
    await nextTick()
    expect(tab.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('使用ag')
    expect(root.querySelector('.history-completion-popup')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('browses the latest 50 sent inputs with arrow keys and restores the draft', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/ExampleProject' },
    ]
    store.activeCliSessionId = 'session-main'
    store.terminalConversation = {
      'session-main': Array.from({ length: 51 }, (_, index) => ({
        id: `message-${index}`,
        sessionId: 'session-main',
        role: 'user' as const,
        content: `message ${index + 1}`,
        timestamp: `2026-08-20T10:${String(index).padStart(2, '0')}:00.000Z`,
      })),
    }
    const { app, root } = mountPane()
    await nextTick()

    const textarea = root.querySelector('.conversation-input') as HTMLTextAreaElement
    textarea.value = 'unfinished draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    const up = () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      textarea.dispatchEvent(event)
      return event
    }
    const down = () => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      textarea.dispatchEvent(event)
      return event
    }

    expect(up().defaultPrevented).toBe(true)
    await nextTick()
    expect(textarea.value).toBe('message 51')

    for (let index = 0; index < 49; index += 1) up()
    await nextTick()
    expect(textarea.value).toBe('message 2')

    up()
    await nextTick()
    expect(textarea.value).toBe('message 2')

    for (let index = 0; index < 50; index += 1) down()
    await nextTick()
    expect(textarea.value).toBe('unfinished draft')

    app.unmount()
    root.remove()
  })

  it('does not intercept arrow keys when no sent input exists', async () => {
    const store = useWorkspaceStore()
    store.terminalSessions = [
      { id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/ExampleProject' },
    ]
    store.activeCliSessionId = 'session-main'
    const { app, root } = mountPane()
    await nextTick()

    const textarea = root.querySelector('.conversation-input') as HTMLTextAreaElement
    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    textarea.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('')

    app.unmount()
    root.remove()
  })
})
