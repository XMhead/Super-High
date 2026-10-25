import { createApp, h, nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CliChatView from './CliChatView.vue'
import * as markdownRenderer from '@/lib/markdown'
const markdownRender = vi.spyOn(markdownRenderer, 'renderMarkdown')

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), send: vi.fn(), append: vi.fn(), resolve: vi.fn(async (_path: string): Promise<{ path: string; isFile: boolean } | null> => null), openFile: vi.fn(), openFolder: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ isTauri: () => true, backend: { readTerminalChatPage: async (id: string, revision: string | null, limit: number, known: Record<string, string>) => {
  const transcript = await mocks.read(id, limit)
  const turns = transcript?.turns.slice(-limit) ?? []
  const versions = Object.fromEntries(turns.map((turn: { id: string }) => [turn.id, JSON.stringify(turn)]))
  const current = JSON.stringify({ ...transcript, turns })
  return { revision: current, hasMore: (transcript?.turns.length ?? 0) > limit, versions, order: turns.map((turn: { id: string }) => turn.id),
    transcript: revision === current ? null : { ...transcript, turns: turns.filter((turn: { id: string }) => known[turn.id] !== versions[turn.id]) } }
}, resolveTerminalPath: mocks.resolve, openUrl: vi.fn() } }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => ({
  get settingsOpen() { return visibility.settingsOpen },
  writeTerminalInput: mocks.write, sendTerminalConversationMessage: mocks.send,
  appendTerminalConversationMessage: mocks.append, openTerminalFileLink: mocks.openFile, openPath: mocks.openFolder, showErrorMessage: mocks.error,
}) }))

const visibility = reactive({ settingsOpen: false })
const session = { id: 's1', providerKind: 'codex', cwd: 'D:/demo', title: 'Codex' }
let app: ReturnType<typeof createApp>
let host: HTMLDivElement
let screen: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  visibility.settingsOpen = false
  screen = []
  mocks.read.mockResolvedValue({ model: 'gpt-6.1-sol high', turns: [{
    id: 't1', prompt: 'say hi', startedAt: 0, completedAt: 72_000, durationMs: 72_000, interrupted: false, answer: '**hi**',
    steps: [{ kind: 'tool', title: '运行命令', detail: 'ls' }],
  }] })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(CliChatView, { session, screenRevision: 0, screenLines: () => screen.map(text => ({ text, highlighted: false })) })
  app.mount(host)
})
afterEach(() => { app.unmount(); host.remove(); vi.useRealTimers() })

function remountWithClock() {
  app.unmount()
  vi.useFakeTimers()
  app = createApp(CliChatView, { session, screenRevision: 0, screenLines: () => screen.map(text => ({ text, highlighted: false })) })
  app.mount(host)
}

async function typeAndSend(text: string) {
  const input = host.querySelector('textarea')!
  input.value = text
  input.dispatchEvent(new Event('input'))
  await nextTick()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
  await vi.advanceTimersByTimeAsync(0)
}

it('shows child work in its originating turn and updates output without sending input', async () => {
  const child = {
    id: 'child', parentId: 'root', parentTurnId: 't1', name: 'inspect', role: 'explorer', model: 'gpt-6.1-sol',
    task: '检查源码', status: 'running', startedAt: Date.now(), completedAt: null, answer: '', error: '', historyError: '',
    steps: [{ id: 'cmd', kind: 'tool', title: '运行命令', detail: 'Get-Date', output: 'first output', status: 'running' }],
  }
  const original = await mocks.read()
  mocks.read.mockResolvedValue({ ...original, agents: [child] })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  const button = host.querySelector<HTMLButtonElement>('.chat-agent-toggle')!
  expect(button.closest('.cli-chat-turn')).not.toBeNull()
  expect(button.textContent).toContain('工作中')
  button.click()
  await nextTick()
  expect(host.querySelector('.chat-agent-task')?.textContent).toBe('检查源码')
  expect(host.querySelector('.chat-agent-output pre')?.textContent).toBe('first output')
  mocks.read.mockResolvedValue({ ...original, agents: [{ ...child, status: 'completed', completedAt: Date.now(), steps: [{ ...child.steps[0], output: 'complete output', status: 'completed' }] }] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.querySelector('.chat-agent-toggle')?.textContent).toContain('已完成')
  expect(host.querySelector('.chat-agent-output pre')?.textContent).toBe('complete output')
  expect(mocks.write).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('preserves the draft and reports a rejected PTY write without pending work', async () => {
  remountWithClock()
  mocks.write.mockRejectedValueOnce(new Error('PTY closed'))
  await typeAndSend('hello')
  expect(host.querySelector('textarea')!.value).toBe('hello')
  expect(host.querySelector('[role=alert]')?.textContent).toContain('PTY closed')
  expect(mocks.send).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('等待 CLI 接收消息')
})

it('expires an unacknowledged message and restores it without resending', async () => {
  remountWithClock()
  mocks.read.mockResolvedValue(null)
  mocks.send.mockResolvedValue(true)
  await typeAndSend('hello')
  expect(host.textContent).toContain('等待 CLI 接收消息')
  await vi.advanceTimersByTimeAsync(16000)
  expect(host.querySelector('[role=alert]')?.textContent).toContain('未能确认 CLI 已接收消息')
  expect(host.querySelector('textarea')!.value).toBe('hello')
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(host.textContent).not.toContain('等待 CLI 接收消息')
})

it('settles an incomplete log only after repeated idle CLI observations', async () => {
  screen = ['❯ ']
  mocks.read.mockResolvedValue({ model: '', turns: [{ id: 'failed', prompt: 'hello', startedAt: Date.now(), completedAt: null, answer: '', steps: [] }] })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(0)
  expect(host.textContent).toContain('等待 CLI 响应')
  expect(host.textContent).not.toContain('正在思考')
  await vi.advanceTimersByTimeAsync(3000)
  expect(host.textContent).not.toContain('等待 CLI 响应')
  expect(host.querySelector('button[title="中断（Esc）"]')).toBeNull()
})

it('does not end a long task while the real CLI remains busy', async () => {
  screen = ['❯ ', 'esc to interrupt']
  mocks.read.mockResolvedValue({ model: '', turns: [{ id: 'busy', prompt: 'hello', startedAt: Date.now(), completedAt: null, answer: '', steps: [{ kind: 'think', title: '思考', detail: 'working' }] }] })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(20000)
  expect(host.textContent).toContain('正在思考')
  expect(host.querySelector('button[title="中断（Esc）"]')).not.toBeNull()
})

it('serializes rapid slash edits before command submission without a trailing clear', async () => {
  remountWithClock()
  const input = host.querySelector('textarea')!
  for (const text of ['/', '/mo', '/model']) {
    input.value = text
    input.dispatchEvent(new Event('input'))
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
  await vi.advanceTimersByTimeAsync(250)
  const writes = mocks.write.mock.calls.map(call => call[0])
  expect(writes.at(-2)).toBe('\u001b[F\u0015/model')
  expect(writes.at(-1)).toBe('\r')
  expect(mocks.send).not.toHaveBeenCalled()
})

it('renders tool calls as thinking and the final answer with its duration', async () => {
  await vi.waitFor(() => expect(host.querySelector('.cli-chat-answer-body strong')?.textContent).toBe('hi'))
  expect(host.querySelector('.cli-chat-thinking-toggle')?.textContent).toContain('已处理 1m 12s · 调用 1 次工具')
  expect(host.querySelector('.cli-chat-answer-meta')?.textContent).toContain('工作了 1m 12s')
  expect(host.querySelector('.cli-chat-model')?.textContent).toContain('gpt-6.1-sol high')
})

it('mirrors a slash draft into the real CLI and clears it when leaving slash mode', async () => {
  const input = host.querySelector('textarea')!
  input.value = '/mo'
  input.dispatchEvent(new Event('input'))
  await nextTick()
  expect(mocks.write).toHaveBeenLastCalledWith('\u001b[F\u0015/mo', 's1')
  input.value = 'hello'
  input.dispatchEvent(new Event('input'))
  await nextTick()
  expect(mocks.write).toHaveBeenLastCalledWith('\u001b[F\u0015', 's1')
})

it('renders a styled local model response and updates the model button without an assistant record', async () => {
  app.unmount()
  mocks.read.mockResolvedValue({ model: '', turns: [{ id: 'model', prompt: '/model', startedAt: 0, completedAt: 1, durationMs: 1, steps: [], answer: 'Set model to \u001b[1mClaude Haiku 5.5\u001b[22m and saved as your default for new sessions\u001b[2m\nANTHROPIC_MODEL is set to Claude Opus 5.5[1M]\u001b[22m' }] })
  app = createApp(CliChatView, { session, screenRevision: 0, screenLines: () => [] })
  app.mount(host)
  await vi.waitFor(() => expect(host.querySelector('.cli-chat-model')?.textContent).toContain('Claude Haiku 5.5'))
  expect(host.querySelector('.cli-chat-answer-body')?.textContent).toContain('ANTHROPIC_MODEL is set to Claude Opus 5.5[1M]')
  expect(host.querySelector('.cli-chat-answer-body')?.textContent).not.toMatch(/\u001b|\[22m/)
})

it('forwards Enter to a live model menu without sending a chat message', async () => {
  screen = ['❯ 1. Default  Use the default model', '  2. Custom  Custom model', 'Enter to select · Esc to cancel']
  app.unmount()
  app = createApp(CliChatView, { session, screenRevision: 1, screenLines: () => screen.map(text => ({ text, highlighted: false })) })
  app.mount(host)
  const input = host.querySelector('textarea')!
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
  await nextTick()
  expect(mocks.write).toHaveBeenCalledWith('\r', 's1')
  expect(mocks.send).not.toHaveBeenCalled()
})

it('reveals the real terminal for native panels that have no numbered options', async () => {
  app.unmount()
  const nativeInteraction = vi.fn()
  app = createApp(CliChatView, {
    session, screenRevision: 1,
    screenLines: () => ['Settings  Status  Config', 'Esc to cancel'].map(text => ({ text, highlighted: false })),
    onNativeInteraction: nativeInteraction,
  })
  app.mount(host)
  await nextTick()
  expect(nativeInteraction).toHaveBeenLastCalledWith(true)
  expect(mocks.send).not.toHaveBeenCalled()
})

it('anchors slash completion at the bottom even in a new empty conversation', async () => {
  app.unmount()
  mocks.read.mockResolvedValue({ model: '', turns: [] })
  app = createApp(CliChatView, { session, screenRevision: 0, screenLines: () => [] })
  app.mount(host)
  await nextTick()
  // The empty layout waits for the first log read, so a loading session never flashes the welcome page.
  expect(host.querySelector('.cli-chat--empty')).toBeNull()
  await vi.waitFor(() => expect(host.querySelector('.cli-chat--empty')).not.toBeNull())
  const input = host.querySelector('textarea')!
  input.value = '/'
  input.dispatchEvent(new Event('input'))
  await nextTick()
  expect(host.querySelector('.cli-chat--empty')).toBeNull()
})

it('shows the live Codex model before the first conversation turn', async () => {
  app.unmount()
  mocks.read.mockResolvedValue({ model: 'gpt-6.1-sol high', turns: [] })
  app = createApp(CliChatView, { session, screenRevision: 0, screenLines: () => [] })
  app.mount(host)
  await vi.waitFor(() => expect(host.querySelector('.cli-chat-model')?.textContent).toBe('gpt-6.1-sol high'))
  expect(mocks.write).not.toHaveBeenCalled()
})

it('keeps the live model and effort when delayed log records contain older models', async () => {
  app.unmount()
  vi.useFakeTimers()
  screen = ['▝▜██████▀  Claude Opus 5.5[1m] with xhigh effort · API Usage Billing']
  mocks.read.mockResolvedValue({ model: 'claude-haiku-5-5', turns: [{
    id: 'model', prompt: '/model', answer: 'Set model to Claude Haiku 5.5 and saved as your default for new sessions',
    startedAt: 0, completedAt: 1, steps: [],
  }] })
  app = createApp(CliChatView, { session: { ...session, providerKind: 'claude' }, screenRevision: 0, screenLines: () => screen.map(text => ({ text, highlighted: false })) })
  app.mount(host)
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('Claude Opus 5.5[1m] with xhigh effort')
  mocks.read.mockResolvedValue({ model: 'claude-sonnet-5-5', turns: [] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('Claude Opus 5.5[1m] with xhigh effort')
})

it.each(['click', 'keyboard'])('refreshes the effective Default model before logs or the header update using %s', async method => {
  app.unmount()
  vi.useFakeTimers()
  mocks.read.mockResolvedValue({ model: '', turns: [] })
  const revision = ref(0)
  screen = ['Claude Haiku 5.5 · API Usage Billing']
  app = createApp({ setup: () => () => h(CliChatView, {
    session, screenRevision: revision.value, screenLines: () => screen.map(text => ({ text, highlighted: false })),
  }) })
  app.mount(host)
  host.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await vi.advanceTimersByTimeAsync(250)
  screen = ['❯ 1. Default (recommended)  Use the default model (currently Claude Opus 5.5[1m])',
    '  2. Claude Haiku 5.5 ✔  Custom Haiku model', 'Enter to set as default · Esc to cancel']
  revision.value++
  await vi.advanceTimersByTimeAsync(20)
  if (method === 'click') host.querySelector<HTMLButtonElement>('.cli-chat-option')!.click()
  else host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('Claude Opus 5.5[1m]')
  // The menu closes before Claude repaints its header. That old header is not a new model change.
  screen = ['Claude Haiku 5.5 · API Usage Billing']
  revision.value++
  await vi.advanceTimersByTimeAsync(20)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('Claude Opus 5.5[1m]')
  screen = ['Claude Opus 5.5[1m] with xhigh effort · API Usage Billing']
  revision.value++
  await vi.advanceTimersByTimeAsync(20)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('Claude Opus 5.5[1m] with xhigh effort')
  expect(mocks.send).not.toHaveBeenCalled()
})

it('shows the initial footer model and replaces a local selection with a native model change', async () => {
  app.unmount()
  vi.useFakeTimers()
  mocks.read.mockResolvedValue({ model: '', turns: [] })
  const revision = ref(0)
  screen = ['GPT-6.1-Sol high · D:\\demo · Context 0% used · private']
  app = createApp({ setup: () => () => h(CliChatView, {
    session, screenRevision: revision.value, screenLines: () => screen.map(text => ({ text, highlighted: false })),
  }) })
  app.mount(host)
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6.1-Sol high')
  host.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await vi.advanceTimersByTimeAsync(250)
  screen = ['› 1. GPT-6-Astra (current)  Frontier', '  2. GPT-6.1-Sol  Workhorse', 'Enter to select · Esc to cancel']
  revision.value++
  await nextTick()
  host.querySelector<HTMLButtonElement>('.cli-chat-option')!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6-Astra')
  screen = ['• Model changed to gpt-6.1-sol high', 'GPT-6.1-Sol high · D:\\demo · Context 0% used · private']
  revision.value++
  await vi.advanceTimersByTimeAsync(0)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6.1-Sol high')
})

it('serializes rapid menu keys from the focused model button using each observed selection', async () => {
  app.unmount()
  vi.useFakeTimers()
  const revision = ref(0)
  let selected = 0
  const render = () => {
    screen = ['First', 'Second', 'Third'].map((label, index) => `${index === selected ? '›' : ' '} ${index + 1}. ${label}  Model`)
    screen.push('Enter to select · Esc to cancel')
    revision.value++
  }
  render()
  const writes: { data: string; at: number; selected: number }[] = []
  mocks.write.mockImplementation(async (data: string) => {
    writes.push({ data, at: Date.now(), selected })
    if (data === '\u001b[B') selected++
    if (data === '\u001b[A') selected--
    if (data === '\r') { screen = ['› Ask Codex']; revision.value++ }
    else render()
  })
  app = createApp({ setup: () => () => h(CliChatView, {
    session, screenRevision: revision.value, screenLines: () => screen.map(text => ({ text, highlighted: false })),
  }) })
  app.mount(host)
  const button = host.querySelector<HTMLButtonElement>('.cli-chat-model')!
  button.focus()
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  }
  await vi.advanceTimersByTimeAsync(0)
  expect(writes.map(({ data, selected: index }) => [data, index])).toEqual([
    ['\u001b[B', 0], ['\u001b[B', 1], ['\u001b[A', 2], ['\r', 1],
  ])
  expect(new Set(writes.map(({ at }) => at)).size).toBe(1)
  expect(mocks.send).not.toHaveBeenCalled()
})

it('clicks a distant menu option as soon as each cursor repaint arrives', async () => {
  app.unmount()
  vi.useFakeTimers()
  const revision = ref(0)
  let selected = 0
  const render = () => {
    screen = ['First', 'Second', 'Third'].map((label, index) => `${index === selected ? '›' : ' '} ${index + 1}. ${label}  Model`)
    screen.push('Enter to select · Esc to cancel')
    revision.value++
  }
  render()
  mocks.write.mockImplementation(async (data: string) => {
    if (data === '\u001b[B') { selected++; render() }
    if (data === '\r') { screen = ['› Ask Codex']; revision.value++ }
  })
  app = createApp({ setup: () => () => h(CliChatView, {
    session, screenRevision: revision.value, screenLines: () => screen.map(text => ({ text, highlighted: false })),
  }) })
  app.mount(host)
  host.querySelectorAll<HTMLButtonElement>('.cli-chat-option')[2]!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.write.mock.calls.map(call => call[0])).toEqual(['\u001b[B', '\u001b[B', '\r'])
  expect(document.activeElement).toBe(host.querySelector('textarea'))
})

it('submits a slash command immediately after the CLI acknowledges its draft', async () => {
  app.unmount()
  vi.useFakeTimers()
  const revision = ref(0)
  mocks.write.mockImplementation(async (data: string) => {
    if (data.endsWith('/model')) { screen = ['› /model']; revision.value++ }
  })
  app = createApp({ setup: () => () => h(CliChatView, {
    session, screenRevision: revision.value, screenLines: () => screen.map(text => ({ text, highlighted: false })),
  }) })
  app.mount(host)
  host.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.write.mock.calls.map(call => call[0])).toEqual(['\u001b[F\u0015/model', '\r'])
})

it('stops an in-flight slash command when its session changes', async () => {
  app.unmount()
  vi.useFakeTimers()
  const current = ref(session)
  let written: (() => void) | undefined
  mocks.write.mockImplementationOnce(() => new Promise<void>(resolve => { written = resolve }))
  app = createApp({ setup: () => () => h(CliChatView, {
    session: current.value, screenRevision: 0, screenLines: () => [],
  }) })
  app.mount(host)
  host.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await vi.advanceTimersByTimeAsync(0)
  current.value = { ...session, id: 's2' }
  await nextTick()
  written!()
  await vi.advanceTimersByTimeAsync(500)
  expect(mocks.write.mock.calls).toEqual([['\u001b[F\u0015/model', 's1']])
  expect(mocks.append).not.toHaveBeenCalled()
})

it('does not submit the wrong option when a cursor movement is never confirmed', async () => {
  app.unmount()
  vi.useFakeTimers()
  mocks.write.mockResolvedValue(undefined)
  screen = ['› 1. First  Model', '  2. Second  Model', 'Enter to select · Esc to cancel']
  app = createApp(CliChatView, { session, screenRevision: 0, screenLines: () => screen.map(text => ({ text, highlighted: false })) })
  app.mount(host)
  host.querySelectorAll<HTMLButtonElement>('.cli-chat-option')[1]!.click()
  await vi.advanceTimersByTimeAsync(1200)
  expect(mocks.write.mock.calls.map(call => call[0])).toEqual(['\u001b[B'])
  expect(host.querySelector('[role=alert]')?.textContent).toBe('CLI 选项尚未更新，请重试。')
})

it.each(['click', 'keyboard'])('keeps the model name through both Codex picker pages using %s', async method => {
  app.unmount()
  vi.useFakeTimers()
  mocks.read.mockResolvedValue({ model: '', turns: [] })
  const revision = ref(0)
  app = createApp({ setup: () => () => h(CliChatView, {
    session, screenRevision: revision.value, screenLines: () => screen.map(text => ({ text, highlighted: false })),
  }) })
  app.mount(host)
  await vi.advanceTimersByTimeAsync(0)
  host.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await vi.advanceTimersByTimeAsync(6000)
  screen = ['› 1. GPT-6.1-Sol (current)  Workhorse', '  2. GPT-6-Astra  Frontier', 'Enter to select · Esc to cancel']
  revision.value++
  await nextTick()
  expect(host.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('选择模型')
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6.1-Sol')
  const choose = async () => {
    if (method === 'click') host.querySelector<HTMLButtonElement>('.cli-chat-option')!.click()
    else host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    await vi.advanceTimersByTimeAsync(100)
  }
  await choose()
  screen = []
  revision.value++
  await nextTick()
  await vi.advanceTimersByTimeAsync(100)
  screen = ['› 1. Medium (default)  Balanced', '  2. High  More reasoning', 'Enter to select · Esc to cancel']
  revision.value++
  await nextTick()
  await choose()
  screen = ['› Ask Codex to do anything']
  revision.value++
  await nextTick()
  await vi.advanceTimersByTimeAsync(1200)
  expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6.1-Sol medium')
  expect(mocks.send).not.toHaveBeenCalled()
  if (method === 'click') {
    host.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
    await vi.advanceTimersByTimeAsync(250)
    screen = ['  1. Medium (current)  Balanced', '› 2. More reasoning…  Max and Ultra', 'Enter to select · Esc to cancel']
    revision.value++
    await nextTick()
    host.querySelectorAll<HTMLButtonElement>('.cli-chat-option')[1]!.click()
    await vi.advanceTimersByTimeAsync(100)
    expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6.1-Sol medium')
    screen = ['  1. Max  More reasoning', '› 2. Ultra  Most reasoning', 'Enter to select · Esc to cancel']
    revision.value++
    await nextTick()
    host.querySelectorAll<HTMLButtonElement>('.cli-chat-option')[1]!.click()
    await vi.advanceTimersByTimeAsync(100)
    expect(host.querySelector('.cli-chat-model')?.textContent).toBe('GPT-6.1-Sol ultra')
  }
})


it('keeps 240 answers cached across clock ticks and only renders a changed answer', async () => {
  const turns = Array.from({ length: 240 }, (_, index) => ({ id: `long-${index}`, prompt: `prompt ${index}`, answer: `**answer ${index}**`,
    startedAt: index, completedAt: index + 1, durationMs: 1, interrupted: false, steps: [] }))
  mocks.read.mockResolvedValue({ model: 'model', turns })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  expect(host.querySelectorAll('.cli-chat-answer')).toHaveLength(40)
  for (let index = 0; index < 5; index++) {
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '加载更早记录')!.click()
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(host.querySelectorAll('.cli-chat-answer')).toHaveLength(240)
  const rendered = markdownRender.mock.calls.length
  await vi.advanceTimersByTimeAsync(3000)
  expect(markdownRender.mock.calls.length).toBe(rendered)
  expect(mocks.read.mock.calls.at(-1)?.[1]).toBe(40)
  mocks.read.mockResolvedValue({ model: 'model', turns: turns.map((turn, index) => index === 239 ? { ...turn, answer: 'updated answer' } : turn) })
  await vi.advanceTimersByTimeAsync(1000)
  expect(markdownRender.mock.calls.length).toBe(rendered + 1)
  expect(host.querySelectorAll('.cli-chat-answer-body')[239].textContent).toContain('updated answer')
})

it('preserves the visible scroll anchor when prepending an older page', async () => {
  const turns = Array.from({ length: 90 }, (_, index) => ({ id: `anchor-${index}`, prompt: `prompt ${index}`, answer: 'answer',
    startedAt: index, completedAt: index + 1, durationMs: 1, interrupted: false, steps: [] }))
  mocks.read.mockResolvedValue({ model: 'model', turns })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  const scroller = host.querySelector<HTMLElement>('.cli-chat-scroll')!
  Object.defineProperty(scroller, 'scrollHeight', { get: () => host.querySelectorAll('.cli-chat-turn').length * 100 })
  scroller.scrollTop = 20
  scroller.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(1)
  expect(host.querySelectorAll('.cli-chat-answer')).toHaveLength(80)
  expect(scroller.scrollTop).toBe(4020)
})


it('discards a late history page after switching sessions and polls the new session', async () => {
  app.unmount()
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  mocks.read.mockImplementation((id: string) => id === 's1' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ model: 'new model', turns: [] }))
  const current = ref(session)
  app = createApp({ setup: () => () => h(CliChatView, { session: current.value, screenRevision: 0, screenLines: () => [] }) })
  app.mount(host)
  current.value = { ...session, id: 's2' }
  await vi.advanceTimersByTimeAsync(1)
  finish({ model: 'old model', turns: [{ id: 'old', prompt: 'old prompt', answer: 'old answer', steps: [], completedAt: 1 }] })
  await vi.advanceTimersByTimeAsync(1)
  expect(host.textContent).not.toContain('old answer')
  expect(host.querySelector('.cli-chat-model')?.textContent ?? host.textContent).not.toContain('old model')
  expect(mocks.read).toHaveBeenCalledWith('s2', 40)
})


it('pauses hidden settings polling and the UI clock, then refreshes immediately', async () => {
  mocks.read.mockResolvedValue({ model: 'model', turns: [{ id: 'active', prompt: 'work', answer: 'in progress',
    startedAt: Date.now() - 1000, completedAt: null, steps: [], durationMs: null, interrupted: false }] })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  visibility.settingsOpen = true
  await nextTick()
  const reads = mocks.read.mock.calls.length
  const label = host.querySelector('.cli-chat-thinking-toggle')!.textContent
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.read.mock.calls.length).toBe(reads)
  expect(host.querySelector('.cli-chat-thinking-toggle')!.textContent).toBe(label)
  visibility.settingsOpen = false
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.read.mock.calls.length).toBe(reads + 1)
  expect(host.querySelector('.cli-chat-thinking-toggle')!.textContent).not.toBe(label)
})

it('pauses an intersecting-hidden panel and document, restoring only when both are visible', async () => {
  let notify!: (entries: unknown[]) => void
  let observed!: Element
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: unknown[]) => void) { notify = callback }
    observe(element: Element) { observed = element }
    disconnect() {}
  })
  try {
    remountWithClock()
    await vi.advanceTimersByTimeAsync(1)
    notify([{ target: observed, isIntersecting: false }])
    await nextTick()
    const reads = mocks.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.read.mock.calls.length).toBe(reads)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    notify([{ target: observed, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.read.mock.calls.length).toBe(reads)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.read.mock.calls.length).toBe(reads + 1)
  } finally {
    delete (document as unknown as Record<string, unknown>).hidden
    vi.unstubAllGlobals()
  }
})

it('continues hidden pending-send confirmation and stops after the confirmation timeout', async () => {
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  await typeAndSend('pending message')
  visibility.settingsOpen = true
  await nextTick()
  const reads = mocks.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.read.mock.calls.length).toBeGreaterThan(reads)
  await vi.advanceTimersByTimeAsync(15000)
  expect(host.textContent).toContain('未能确认 CLI 已接收消息')
  const stopped = mocks.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.read.mock.calls.length).toBe(stopped)
})


it('keeps a loaded history page when an older hot poll resolves afterward', async () => {
  const transcript = { model: 'model', turns: Array.from({ length: 90 }, (_, index) => ({ id: `race-${index}`, prompt: `prompt ${index}`, answer: 'answer',
    startedAt: index, completedAt: index + 1, durationMs: 1, interrupted: false, steps: [] })) }
  mocks.read.mockResolvedValue(transcript)
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  let finish!: (value: unknown) => void
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(1000)
  Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '加载更早记录')!.click()
  await vi.advanceTimersByTimeAsync(1)
  expect(host.querySelectorAll('.cli-chat-answer')).toHaveLength(80)
  finish({ ...transcript, turns: [] })
  await vi.advanceTimersByTimeAsync(1)
  expect(host.querySelectorAll('.cli-chat-answer')).toHaveLength(80)
})

it('opens resolved bare workspace directories and inline images from chat', async () => {
  mocks.resolve.mockImplementation(async (path: string) => ({ path, isFile: path.endsWith('.png') }))
  mocks.read.mockResolvedValue({ turns: [{ id: 'paths', prompt: 'files', answer: '目录：demo/preview/v1/，图片 `demo/preview/v1/image.png`', steps: [], startedAt: 0, completedAt: 1 }] })
  remountWithClock()
  await vi.advanceTimersByTimeAsync(1)
  await nextTick()
  await vi.waitFor(() => expect(host.querySelectorAll('.cli-chat-answer-body a')).toHaveLength(2))
  const links = host.querySelectorAll<HTMLAnchorElement>('.cli-chat-answer-body a')
  links[0]!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.openFolder).toHaveBeenCalledWith('D:/demo/preview/v1/')
  links[1]!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.openFile).toHaveBeenCalledWith('D:/demo/preview/v1/image.png', undefined)
})
