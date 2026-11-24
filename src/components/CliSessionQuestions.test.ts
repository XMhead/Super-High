import { createApp, h, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CliSessionQuestions from './CliSessionQuestions.vue'
import { sessionQuestions } from '@/lib/cliQuestions'
import type { PlanRequest } from '@/lib/cliCompletion'

const mocks = vi.hoisted(() => ({ list: vi.fn(), reply: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ backend: { listCliPlanRequests: mocks.list, replyCliPlan: mocks.reply } }))
const request = (id = 'ask', asyncQuestion = false): PlanRequest => ({ connection: 4, requestId: id, threadId: 'native-1', asyncQuestion,
  questions: [{ id: 'color', header: '颜色', question: '**选颜色？**', options: [{ label: '红', description: '暖色' }, { label: '蓝', description: '冷色' }] }] })
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
let props: { sessionId: string; visible: boolean }
beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  for (const id of ['questions-a', 'questions-b']) Object.assign(sessionQuestions(id), { requests: [], drafts: {}, submitting: '', error: '', pollError: '', confirmed: false })
  mocks.list.mockResolvedValue([request()])
  mocks.reply.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  props = reactive({ sessionId: 'questions-a', visible: true })
  mount()
  await vi.advanceTimersByTimeAsync(0)
})
function mount() { app = createApp({ render: () => h(CliSessionQuestions, props) }); app.mount(host) }
async function note(text: string) {
  const input = host.querySelector('textarea')!
  input.value = text
  input.dispatchEvent(new Event('input'))
  await nextTick()
}
async function submit() { host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await vi.advanceTimersByTimeAsync(0) }
afterEach(() => { app.unmount(); host.remove(); vi.useRealTimers() })

it('restores unfinished choices across modes and submits only to the original native request', async () => {
  expect(host.querySelector('strong')?.textContent).toBe('选颜色？')
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
  host.querySelector<HTMLInputElement>('input[type=radio]')!.click()
  await note('补充')
  app.unmount(); mount()
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('补充')
  expect(host.querySelector<HTMLInputElement>('input[type=radio]')!.checked).toBe(true)
  mocks.list.mockResolvedValue([])
  await submit()
  expect(mocks.reply).toHaveBeenCalledWith('questions-a', 4, 'ask', { color: ['红', '补充'] })
  expect(host.querySelector('form')).toBeNull()
  expect(Object.keys(sessionQuestions('questions-a').drafts)).toHaveLength(0)
})

it('preserves draft and disables submission during status failures, then removes terminal-answered questions', async () => {
  await note('自由回答')
  mocks.list.mockRejectedValueOnce(new Error('host unavailable'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.querySelector('[role=alert]')?.textContent).toContain('host unavailable')
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('自由回答')
  mocks.list.mockResolvedValue([])
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.querySelector('form')).toBeNull()
  expect(mocks.reply).not.toHaveBeenCalled()
})

it('supports multiple async requests, multi-select and secret free text without sending a normal chat message', async () => {
  const multi = request('multi', true)
  multi.questions[0]!.multiSelect = true
  multi.questions.push({ id: 'secret', header: '', question: '密钥', options: [], isSecret: true })
  mocks.list.mockResolvedValue([multi, request('other', true)])
  await vi.advanceTimersByTimeAsync(1000)
  for (const input of host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) input.click()
  const secret = host.querySelector<HTMLInputElement>('input[type=password]')!
  secret.value = 'test-only'; secret.dispatchEvent(new Event('input'))
  await nextTick()
  mocks.list.mockResolvedValue([request('other', true)])
  await submit()
  expect(mocks.reply).toHaveBeenCalledWith('questions-a', 4, 'multi', { color: ['红', '蓝'], secret: ['test-only'] })
  expect(host.querySelectorAll('form')).toHaveLength(1)
  expect(host.textContent).toContain('发送回答')
})

it('ignores a late snapshot after switching sessions and retains a failed answer for retry', async () => {
  let finish!: (requests: PlanRequest[]) => void
  mocks.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(1000)
  props.sessionId = 'questions-b'
  mocks.list.mockResolvedValue([request('new')])
  await vi.advanceTimersByTimeAsync(0)
  finish([request('old')])
  await vi.advanceTimersByTimeAsync(0)
  await note('只给 B')
  mocks.reply.mockRejectedValueOnce(new Error('not accepted'))
  await submit()
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.reply).toHaveBeenCalledWith('questions-b', 4, 'new', { color: ['只给 B'] })
  expect(host.querySelector('[role=alert]')?.textContent).toContain('not accepted')
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('只给 B')
})

it('does not resurrect an answered card when a snapshot arrives after a mode switch during submission', async () => {
  let finishList!: (requests: PlanRequest[]) => void
  let finishReply!: () => void
  await note('回答')
  mocks.list.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve }))
  await vi.advanceTimersByTimeAsync(1000)
  mocks.reply.mockImplementationOnce(() => new Promise<void>(resolve => { finishReply = resolve }))
  await submit()
  app.unmount(); mount()
  await vi.advanceTimersByTimeAsync(0)
  mocks.list.mockResolvedValue([])
  finishReply()
  await vi.advanceTimersByTimeAsync(0)
  finishList([request()])
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector('form')).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.querySelector('form')).toBeNull()
  expect(mocks.reply).toHaveBeenCalledOnce()
})
