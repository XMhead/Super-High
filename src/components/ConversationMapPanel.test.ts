import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConversationMapPanel from './ConversationMapPanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { CliNativeConversationSummary, Workspace } from '@/types'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listWorkspaceCliConversations: vi.fn(),
  readWorkspaceCliConversation: vi.fn(),
  resumeCliConversation: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listWorkspaceCliConversations: mocks.listWorkspaceCliConversations,
    readWorkspaceCliConversation: mocks.readWorkspaceCliConversation,
    resumeCliConversation: mocks.resumeCliConversation,
    saveSettings: mocks.saveSettings,
  },
  isTauri: mocks.isTauri,
}))

vi.mock('@/components/TerminalPane.vue', () => ({
  default: {
    props: ['sessionIds', 'activeSessionId'],
    template: '<div data-testid="map-live-terminal">{{ activeSessionId }}</div>',
  },
}))

function workspace(rootPath: string): Workspace {
  return {
    id: 'workspace-1',
    name: 'One',
    displayName: 'One',
    rootPath,
    openedAt: '2026-08-25T01:00:00Z',
  }
}

function conversation(): CliNativeConversationSummary {
  return {
    id: 'codex:session-1',
    providerKind: 'codex',
    nativeSessionId: 'session-1',
    title: 'Map mode task',
    summary: 'The native session is ready to resume.',
    cwd: 'D:/One',
    createdAt: '2026-08-25T01:00:00Z',
    updatedAt: new Date().toISOString(),
    messageCount: 2,
    sourcePath: 'C:/Users/ExampleUser01/.codex/sessions/rollout.jsonl',
    resumeSupported: true,
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function mountPanel(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(ConversationMapPanel)
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('ConversationMapPanel', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mocks.isTauri.mockReset()
    mocks.listWorkspaceCliConversations.mockReset()
    mocks.readWorkspaceCliConversation.mockReset()
    mocks.resumeCliConversation.mockReset()
    mocks.saveSettings.mockReset()
    mocks.isTauri.mockReturnValue(true)
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.listWorkspaceCliConversations.mockResolvedValue([conversation()])
    mocks.readWorkspaceCliConversation.mockResolvedValue({
      ...conversation(),
      messages: [{
        id: 'message-1',
        role: 'user',
        content: 'Read this session before resuming it.',
        timestamp: '2026-08-25T01:00:00Z',
      }],
    })
    mocks.resumeCliConversation.mockResolvedValue({
      id: 'terminal-1',
      title: 'Codex CLI',
      providerKind: 'codex',
      cwd: 'D:/One',
    })
  })

  it('renders provider-distinct cards and resumes a card into the embedded terminal', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    const card = root.querySelector('.conversation-map-card') as HTMLElement
    expect(card.classList).toContain('provider-codex')
    expect(root.textContent).toContain('Codex CLI')

    ;(root.querySelector('.conversation-map-card-content') as HTMLButtonElement).click()
    await nextTick()
    await flushPromises()

    expect(mocks.resumeCliConversation).toHaveBeenCalledWith('workspace-1', 'codex', 'D:/One', 'session-1')
    expect(root.querySelector('[data-testid="map-live-terminal"]')?.textContent).toBe('terminal-1')

    app.unmount()
    root.remove()
  })

  it('filters old and hi-only probe conversations, then pages other CLI suppliers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'))
    mocks.listWorkspaceCliConversations.mockResolvedValue([
      { ...conversation(), id: 'codex:old', title: 'Old session', updatedAt: '2026-08-18T11:59:59Z' },
      { ...conversation(), id: 'codex:probe', title: 'hi', messageCount: 2, updatedAt: '2026-08-25T11:00:00Z' },
      { ...conversation(), id: 'kimi:recent', providerKind: 'kimi', title: 'Recent session', updatedAt: '2026-08-19T12:00:00Z' },
    ])
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    expect(root.querySelectorAll('.conversation-map-card')).toHaveLength(1)
    expect(root.textContent).toContain('Claude Code')
    expect(root.textContent).toContain('Codex CLI')
    store.settings.hiddenCliProviderIds = []
    await nextTick()
    expect(root.textContent).not.toContain('已隐藏')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(root.querySelectorAll('.conversation-map-card')).toHaveLength(0)
    expect(root.textContent).toContain('Grok Build CLI')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await nextTick()
    expect(root.querySelectorAll('.conversation-map-card')).toHaveLength(1)
    expect(root.textContent).toContain('Recent session')
    expect(root.querySelector('[aria-label="Kimi"]')).not.toBeNull()

    app.unmount()
    root.remove()
    vi.useRealTimers()
  })

  it('opens the full transcript without starting the CLI until resume is chosen', async () => {
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    const { app, root } = mountPanel(pinia)
    await flushPromises()

    ;(root.querySelector('.conversation-map-card-actions button') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.readWorkspaceCliConversation).toHaveBeenCalledWith(
      'D:/One',
      'C:/Users/ExampleUser01/.codex/sessions/rollout.jsonl',
    )
    expect(mocks.resumeCliConversation).not.toHaveBeenCalled()
    expect(root.textContent).toContain('Read this session before resuming it.')

    app.unmount()
    root.remove()
  })
})
