import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CliCompletionNotice from './CliCompletionNotice.vue'
import type { PlanRequest } from '@/lib/cliCompletion'

const mocks = vi.hoisted(() => ({ get: vi.fn(), reply: vi.fn(), close: vi.fn(), resolve: vi.fn(), folder: vi.fn(), tauri: vi.fn(() => false), emit: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ isTauri: mocks.tauri, backend: {
  getSettings: async () => ({}), resolveTerminalPath: mocks.resolve, openPath: mocks.folder, getCliPlanRequest: mocks.get, replyCliPlan: mocks.reply,
} }))
vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close: mocks.close }) }))
vi.mock('@/lib/theme', () => ({ applyTheme: vi.fn(), registerCustomThemes: vi.fn() }))
vi.mock('@/lib/fontStyles', () => ({ applyFontStyle: vi.fn(), registerCustomFonts: vi.fn(), registerCustomFontStyles: vi.fn() }))

const plan: PlanRequest = { connection: 2, requestId: 'request-9', threadId: 'thread-3', questions: [
  { id: 'loot', header: '战利品', question: '**暂存哪些产出？**', options: [{ label: '物品和 Roll 奖励', description: '推荐' }, { label: '仅物品', description: '' }] },
  { id: 'scope', header: '范围', question: '补充要求？', options: [] },
] }
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
beforeEach(async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
  vi.clearAllMocks()
  mocks.tauri.mockReturnValue(false)
  mocks.get.mockResolvedValue(plan)
  mocks.reply.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(CliCompletionNotice, { title: '对应 Plan', provider: 'codex', workspace: 'D:/demo', conversationId: 'thread-3', task: '', answer: '', sessionId: 'session-4', planRequest: plan })
  app.mount(host)
  await nextTick()
})
afterEach(() => { app.unmount(); host.remove(); vi.useRealTimers() })
it('renders Markdown questions and submits explicit choices and free text to the exact request', async () => {
  await vi.waitFor(() => expect(host.querySelector('fieldset')?.disabled).toBe(false))
  expect(host.querySelector('.markdown-body strong')?.textContent).toBe('暂存哪些产出？')
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
  host.querySelector<HTMLInputElement>('input[type=radio]')!.click()
  const fields = host.querySelectorAll('textarea')
  fields[0].value = '通关再发'
  fields[0].dispatchEvent(new Event('input'))
  fields[1].value = '只启用新地牢'
  fields[1].dispatchEvent(new Event('input'))
  await nextTick()
  host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledWith('session-4', 2, 'request-9', {
    loot: ['物品和 Roll 奖励', '通关再发'], scope: ['只启用新地牢'],
  }))
  expect(mocks.close).toHaveBeenCalledOnce()
})
it('disables expired questions and keeps a failed submission available for review', async () => {
  await vi.waitFor(() => expect(host.querySelector('fieldset')?.disabled).toBe(false))
  mocks.reply.mockRejectedValueOnce(new Error('问题已结束'))
  host.querySelector<HTMLInputElement>('input[type=radio]')!.click()
  const field = host.querySelectorAll('textarea')[1]
  field.value = '备注'
  field.dispatchEvent(new Event('input'))
  await nextTick()
  host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('问题已结束'))
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.get.mockResolvedValue(null)
  await vi.waitFor(() => expect(host.querySelector('fieldset')?.disabled).toBe(true), { timeout: 2000 })
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
})

it('links workspace-prefixed directories and opens their resolved folder from the notice', async () => {
  app.unmount()
  mocks.tauri.mockReturnValue(true)
  mocks.resolve.mockImplementation(async path => ({ path, isFile: false }))
  app = createApp(CliCompletionNotice, { title: 'Files', provider: 'codex', workspace: 'D:/demo', conversationId: 'files', task: '', answer: '`demo/preview/v1/`' })
  app.mount(host)
  await vi.waitFor(() => expect(host.querySelector('.notice-answer a')).not.toBeNull())
  host.querySelector<HTMLAnchorElement>('.notice-answer a')!.click()
  await vi.waitFor(() => expect(mocks.folder).toHaveBeenCalledWith('D:/demo/preview/v1/'))
  expect(mocks.close).toHaveBeenCalledOnce()
})
