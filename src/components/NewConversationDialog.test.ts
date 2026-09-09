import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import NewConversationDialog from './NewConversationDialog.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Workspace } from '@/types'

const mocks = vi.hoisted(() => ({
  createTerminalSession: vi.fn(),
  saveSettings: vi.fn(),
  selectDirectory: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    createTerminalSession: mocks.createTerminalSession,
    saveSettings: mocks.saveSettings,
    selectDirectory: mocks.selectDirectory,
  },
  isTauri: () => false,
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function workspace(rootPath: string): Workspace {
  return {
    id: rootPath,
    name: rootPath.split('/').pop() ?? rootPath,
    displayName: rootPath.split('/').pop() ?? rootPath,
    rootPath,
    openedAt: '2026-07-07T00:00:00Z',
  }
}

function mountDialog(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({
    render: () => h(NewConversationDialog),
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

async function openDialog(rootPath = 'D:/Project') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.workspace = workspace(rootPath)
  const mounted = mountDialog(pinia)
  store.setNewConversationDialogOpen(true)
  await nextTick()
  await flushPromises()
  return { store, ...mounted }
}

describe('NewConversationDialog quick phrases', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.createTerminalSession.mockReset()
    mocks.saveSettings.mockReset()
    mocks.selectDirectory.mockReset()
    mocks.createTerminalSession.mockResolvedValue({
      id: 'session-1',
      title: 'Codex CLI',
      providerKind: 'codex',
      cwd: 'D:/Project',
    })
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.selectDirectory.mockResolvedValue(null)
  })

  it('inserts a saved quick phrase into the initial prompt', async () => {
    const { app, root, store } = await openDialog()
    store.settings.quickPhrases = [{
      id: 'phrase-1',
      title: '先审查',
      text: '先阅读代码并列出风险。',
      createdAt: '2026-07-07T00:00:00Z',
    }]
    await nextTick()

    const insertButton = root.querySelector('[data-testid="quick-phrase-insert"]') as HTMLButtonElement
    insertButton.click()
    await nextTick()

    const prompt = root.querySelector('[data-testid="new-session-prompt"]') as HTMLTextAreaElement
    expect(prompt.value).toBe('先阅读代码并列出风险。')
    app.unmount()
  })

  it('saves and deletes quick phrases from the dialog', async () => {
    const { app, root, store } = await openDialog()

    const prompt = root.querySelector('[data-testid="new-session-prompt"]') as HTMLTextAreaElement
    prompt.value = '复现问题，最小改动修复，并跑验证。'
    prompt.dispatchEvent(new Event('input'))
    const title = root.querySelector('[data-testid="quick-phrase-title"]') as HTMLInputElement
    title.value = '修复流程'
    title.dispatchEvent(new Event('input'))
    await nextTick()

    const saveButton = root.querySelector('[data-testid="save-quick-phrase"]') as HTMLButtonElement
    saveButton.click()
    await flushPromises()
    await nextTick()

    expect(store.settings.quickPhrases[0]).toMatchObject({
      title: '修复流程',
      text: '复现问题，最小改动修复，并跑验证。',
    })
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      quickPhrases: [expect.objectContaining({ title: '修复流程' })],
    }))

    const deleteButton = root.querySelector('[data-testid="quick-phrase-delete"]') as HTMLButtonElement
    deleteButton.click()
    await flushPromises()
    await nextTick()

    expect(store.settings.quickPhrases).toEqual([])
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      quickPhrases: [],
    }))
    app.unmount()
  })
})
