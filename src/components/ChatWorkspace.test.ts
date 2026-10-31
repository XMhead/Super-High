import { createApp, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ChatWorkspace from './ChatWorkspace.vue'
import type { CliNativeConversationSummary } from '@/types'

const mocks = vi.hoisted(() => ({ list: vi.fn(), switch: vi.fn(), resume: vi.fn(), send: vi.fn(), active: vi.fn(), save: vi.fn(), ready: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ backend: { listCliConversations: mocks.list, savePastedImage: mocks.save } }))
vi.mock('@/components/CliChatView.vue', () => ({ default: {
  props: ['session', 'history', 'draft', 'submitHistory'], emits: ['update:draft', 'draft-paste'],
  template: '<div data-testid="history-view">{{ history.title }}<template v-if="history.resumeSupported"><textarea :value="draft" @input="$emit(\'update:draft\', $event.target.value)" @paste="$emit(\'draft-paste\', $event)" /><button data-testid="send-history" @click="submitHistory(draft)">发送</button></template><slot name="history-actions" /></div>',
} }))
vi.mock('@/components/TerminalPane.vue', () => ({ default: { methods: { waitForSessionReady: mocks.ready }, template: '<div data-testid="live-terminal" />' } }))
vi.mock('@/components/EditorPane.vue', () => ({ default: { template: '<div data-testid="editor" />' } }))
vi.mock('@/components/ExplorerPane.vue', () => ({ default: { template: '<div class="explorer-panel" />' } }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => state }))
const state = reactive({
  cliTerminalSessions: [] as never[], openWorkspacePaths: ['D:/Current'], recentProjects: [], activeCliSessionId: '', activeCliSelectionRevision: 0,
  activeCliTerminalSession: null, activeTab: null, settings: { explorerVisible: true, conversationSidebarVisible: true, activePreviewMode: 'code', panelLayout: { previewWidth: 520, explorerWidth: 180 } },
  setPanelLayoutSize: vi.fn((key: 'previewWidth' | 'explorerWidth', width: number) => { state.settings.panelLayout[key] = width }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  workspace: { rootPath: 'D:/Current', name: 'Current' }, switchWorkspace: mocks.switch, resumeNativeCliConversation: mocks.resume,
  sendTerminalConversationMessage: mocks.send, showErrorMessage: vi.fn(),
  setActiveTerminalSession: mocks.active, invalidateTerminalSelection: vi.fn(), setNewConversationDialogOpen: vi.fn(), openProject: vi.fn(), setCliViewMode: vi.fn(),
})
const record = (id: string, providerKind = 'codex'): CliNativeConversationSummary => ({
  id, providerKind, nativeSessionId: id, title: id, summary: '', cwd: 'D:/Other', createdAt: '', updatedAt: '2026-10-30T08:00:00Z', messageCount: 2, sourcePath: id, resumeSupported: providerKind !== 'dsh',
})
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  state.activeCliSessionId = ''
  state.activeCliSelectionRevision = 0
  state.workspace.rootPath = 'D:/Current'
  state.settings.panelLayout = { previewWidth: 520, explorerWidth: 180 }
  mocks.list.mockResolvedValue([record('Codex history'), record('DSH history', 'dsh')])
  mocks.switch.mockResolvedValue(true)
  mocks.resume.mockResolvedValue({ id: 'resumed' })
  mocks.send.mockResolvedValue(true)
  mocks.ready.mockResolvedValue(true)
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(ChatWorkspace)
  app.mount(host)
  await vi.waitFor(() => expect(host.querySelectorAll('.chat-history-row')).toHaveLength(2))
})
afterEach(() => { app.unmount(); host.remove() })

function pointer(target: EventTarget, type: string, values: Record<string, number> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...values })
  Object.defineProperty(event, 'pointerId', { value: values.pointerId ?? 7 })
  target.dispatchEvent(event)
}

it('resizes all chat boundaries from their rendered widths and stops on blur or pointer cancellation', async () => {
  window.dispatchEvent(new Event('superhigh:chat-preview'))
  await nextTick()
  const bounds = (selector: string, width: number) => {
    const element = host.querySelector<HTMLElement>(selector)!
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
    return element
  }
  const root = bounds('.chat-workspace', 2000)
  bounds('.chat-history-sidebar', 258)
  bounds('.chat-workspace-preview', 700)
  bounds('.explorer-panel', 180)
  const separators = host.querySelectorAll('[role="separator"]')
  expect(separators).toHaveLength(3)
  pointer(separators[0], 'pointerdown', { clientX: 258 })
  pointer(window, 'pointermove', { clientX: 310, pointerId: 8 })
  expect(root.style.getPropertyValue('--chat-history-width')).toBe('258px')
  pointer(window, 'pointermove', { clientX: 310 })
  await nextTick()
  expect(root.style.getPropertyValue('--chat-history-width')).toBe('310px')
  window.dispatchEvent(new Event('blur'))
  pointer(window, 'pointermove', { clientX: 350 })
  await nextTick()
  expect(root.style.getPropertyValue('--chat-history-width')).toBe('310px')
  pointer(separators[1], 'pointerdown', { clientX: 1300 })
  pointer(window, 'pointermove', { clientX: 1250 })
  expect(state.settings.panelLayout.previewWidth).toBe(750)
  pointer(window, 'pointerup')
  pointer(separators[2], 'pointerdown', { clientX: 1820 })
  pointer(window, 'pointermove', { clientX: 1780 })
  expect(state.settings.panelLayout.explorerWidth).toBe(220)
  pointer(window, 'pointercancel')
  pointer(window, 'pointermove', { clientX: 1600 })
  expect(state.settings.panelLayout.explorerWidth).toBe(220)
  expect(state.saveSettings).toHaveBeenCalledTimes(2)
  expect(document.documentElement.classList.contains('is-resizing-panels')).toBe(false)
})

async function draftMessage(text = '继续分析') {
  const input = host.querySelector('textarea')!
  input.value = text
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

it('keeps the selected history and draft during passive restoration of a live session', async () => {
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage('别跳走')
  state.activeCliSessionId = 'restored-in-background'
  await nextTick()
  expect(host.querySelector('[data-testid="history-view"]')?.textContent).toContain('Codex history')
  expect(host.querySelector('textarea')?.value).toBe('别跳走')
})

it('restores a history draft after leaving and remounting chat mode', async () => {
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage('模式往返保留')
  app.unmount()
  app = createApp(ChatWorkspace)
  app.mount(host)
  await vi.waitFor(() => expect(host.querySelectorAll('.chat-history-row')).toHaveLength(2))
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  expect(host.querySelector('textarea')?.value).toBe('模式往返保留')
})

it('reads and drafts without launching a CLI, then resumes and sends only on message submission', async () => {
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  expect(host.querySelector('[data-testid="history-view"]')?.textContent).toContain('Codex history')
  expect(mocks.switch).not.toHaveBeenCalled()
  expect(mocks.resume).not.toHaveBeenCalled()
  await draftMessage()
  expect(mocks.switch).not.toHaveBeenCalled()
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(host.querySelector('.chat-resume-button')).toBeNull()
  host.querySelector<HTMLButtonElement>('[data-testid="send-history"]')!.click()
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ id: 'Codex history' })))
  expect(mocks.switch).toHaveBeenCalledWith('D:/Other', { preserveProjectSurface: true })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.send).toHaveBeenCalledWith('resumed', '继续分析')
  expect(host.querySelector('[data-testid="history-view"]')).toBeNull()
})

it('does not resume a stale row if another history is selected while switching workspace', async () => {
  let finish!: (value: boolean) => void
  mocks.switch.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage()
  host.querySelector<HTMLButtonElement>('[data-testid="send-history"]')!.click()
  await nextTick()
  host.querySelectorAll<HTMLButtonElement>('.chat-history-row')[1].click()
  await nextTick()
  finish(true)
  await vi.waitFor(() => expect(host.querySelector('[data-testid="history-view"]')?.textContent).toContain('DSH history'))
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(host.querySelector('.chat-resume-button')).toBeNull()
})

it('preserves the draft across selection changes and a failed send', async () => {
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage('保留这条消息')
  host.querySelectorAll<HTMLButtonElement>('.chat-history-row')[1].click()
  await nextTick()
  expect(host.querySelector('textarea')).toBeNull()
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  expect(host.querySelector('textarea')?.value).toBe('保留这条消息')
  mocks.send.mockResolvedValue(false)
  host.querySelector<HTMLButtonElement>('[data-testid="send-history"]')!.click()
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
  expect(host.querySelector('textarea')?.value).toBe('保留这条消息')
  expect(host.querySelector('[data-testid="history-view"]')).not.toBeNull()
})

it('does not send to a stale selection when resume finishes late', async () => {
  let finish!: (value: { id: string }) => void
  mocks.resume.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage()
  host.querySelector<HTMLButtonElement>('[data-testid="send-history"]')!.click()
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1))
  host.querySelectorAll<HTMLButtonElement>('.chat-history-row')[1].click()
  await nextTick()
  finish({ id: 'resumed' })
  await nextTick()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(host.querySelector('[data-testid="history-view"]')?.textContent).toContain('DSH history')
})

it('keeps native records available across provider and search filters', async () => {
  const select = host.querySelector<HTMLSelectElement>('select')!
  select.value = 'dsh'
  select.dispatchEvent(new Event('change'))
  await nextTick()
  expect(host.querySelectorAll('.chat-history-row')).toHaveLength(1)
  expect(host.querySelector('.chat-history-row')?.textContent).toContain('DSH history')
  select.value = ''
  select.dispatchEvent(new Event('change'))
  const input = host.querySelector<HTMLInputElement>('input')!
  input.value = 'Codex history'
  input.dispatchEvent(new Event('input'))
  await nextTick()
  expect(host.querySelectorAll('.chat-history-row')).toHaveLength(1)
  expect(host.querySelector('.chat-history-row')?.textContent).toContain('Codex history')
})

it('saves pasted images in the history workspace and appends their paths to the draft', async () => {
  mocks.save.mockResolvedValue('D:/Other/.superhigh/image.png')
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage('现有草稿')
  const image = new File(['image'], 'paste.png', { type: 'image/png' })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [image], items: [] } })
  host.querySelector('textarea')!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(host.querySelector('textarea')?.value).toContain('图片路径：D:/Other/.superhigh/image.png'))
  expect(host.querySelector('textarea')?.value).toContain('现有草稿')
  expect(mocks.save).toHaveBeenCalledWith('D:/Other', expect.stringMatching(/^data:image\/png;base64,/), 'paste.png')
  expect(mocks.resume).not.toHaveBeenCalled()
})

it('keeps the history view and draft visible while resume and send are pending', async () => {
  let finish!: (value: { id: string }) => void
  mocks.resume.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage()
  host.querySelector<HTMLButtonElement>('[data-testid="send-history"]')!.click()
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1))
  expect(host.querySelector('[data-testid="history-view"]')).not.toBeNull()
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在连接 CLI，保留当前对话')
  expect(host.querySelector('textarea')?.value).toBe('继续分析')
  finish({ id: 'resumed' })
  await vi.waitFor(() => expect(host.querySelector('[data-testid="history-view"]')).toBeNull())
})

it('resumes the selected history before switching to work mode', async () => {
  let finish!: (value: { id: string } | null) => void
  mocks.resume.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  host.querySelector<HTMLButtonElement>('[title="切换到工作模式"]')!.click()
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1))
  expect(host.querySelector('[data-testid="history-view"]')).not.toBeNull()
  expect(state.setCliViewMode).not.toHaveBeenCalled()
  finish({ id: 'resumed' })
  await vi.waitFor(() => expect(state.setCliViewMode).toHaveBeenCalledWith('work'))
  expect(mocks.send).not.toHaveBeenCalled()
})

it('keeps the history and draft when the resumed CLI is not ready', async () => {
  mocks.ready.mockResolvedValue(false)
  host.querySelector<HTMLButtonElement>('.chat-history-row')!.click()
  await nextTick()
  await draftMessage('等待发送')
  host.querySelector<HTMLButtonElement>('[data-testid="send-history"]')!.click()
  await vi.waitFor(() => expect(state.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('尚未准备好')))
  expect(mocks.send).not.toHaveBeenCalled()
  expect(host.querySelector('textarea')?.value).toBe('等待发送')
})
