import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import MobileSessions from './MobileSessions.vue'

const output = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), input: (_input: string) => {}, focus: vi.fn(), line: '' }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 60
  rows = 20
  loadAddon() {}
  open() {}
  onData(callback: (input: string) => void) { output.input = callback }
  focus() { output.focus() }
  hasSelection() { return false }
  buffer = { active: { viewportY: 0, getLine: () => ({ translateToString: () => output.line }) } }
  dispose() {}
  reset() { output.reset() }
  write(text: string, done: () => void) { output.write(text); done() }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const session = { id: 'terminal-1', title: 'Codex', cwd: 'C:/work', providerKind: 'codex' }
let dispose: (() => void) | undefined
let root: HTMLDivElement
const flush = async () => { for (let i = 0; i < 12; i++) await nextTick() }

function mount(api: object, connected = true) {
  root = document.createElement('div')
  document.body.append(root)
  const app = createApp(MobileSessions, { api: api as MobileHostApi, root: 'C:/work', mode: 'ai', connected })
  app.mount(root)
  dispose = () => { app.unmount(); root.remove() }
}

function mockApi() {
  return {
    listTerminals: vi.fn().mockResolvedValue([session]),
    listProviders: vi.fn().mockResolvedValue([{ providerKind: 'codex', name: 'Codex', available: true }]),
    terminalBuffer: vi.fn().mockResolvedValue({ buffer: 'ready', startByte: 0, endByte: 5, running: true, reset: false }),
    writeTerminal: vi.fn().mockResolvedValue({ ok: true }),
    resizeTerminal: vi.fn().mockResolvedValue({ ok: true }),
    closeTerminal: vi.fn().mockResolvedValue({ ok: true }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { dispose?.(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('mobile CLI sessions', () => {
  it('discards queued keystrokes after the view is disposed', async () => {
    const api = mockApi()
    let finish!: () => void
    api.writeTerminal.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }) }))
    mount(api); await flush()
    output.input('a'); output.input('b'); await flush()
    dispose?.(); dispose = undefined
    finish(); await flush()
    expect(api.writeTerminal.mock.calls.map(call => call[1])).toEqual(['a'])
  })
  it('forwards typed input and deletion in order while an earlier write is pending', async () => {
    const api = mockApi()
    let finish!: () => void
    api.writeTerminal.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }) }))
    mount(api); await flush()
    output.input('/model'); output.input('\u007f'); output.input('\u001b[3~')
    await flush()
    expect(api.writeTerminal).toHaveBeenCalledTimes(1)
    finish(); await flush()
    expect(api.writeTerminal.mock.calls.map(call => call[1])).toEqual(['/model', '\u007f', '\u001b[3~'])
  })

  it('completes a tapped terminal command and focuses its editor without executing it', async () => {
    const api = mockApi()
    mount(api); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="唤起指令"]')!.click(); await flush()
    const host = root.querySelector<HTMLElement>('.mobile-terminal')!
    const screen = document.createElement('div'); screen.className = 'xterm-screen'; host.append(screen)
    screen.getBoundingClientRect = () => ({ top: 0, height: 400 }) as DOMRect
    output.line = '  /model   choose a model'
    host.dispatchEvent(new MouseEvent('click', { clientY: 30, bubbles: true })); await flush()
    expect(api.writeTerminal).toHaveBeenLastCalledWith('terminal-1', '\u001b[F\u0015/model ')
    expect(output.focus).toHaveBeenCalled()
    expect(api.writeTerminal).not.toHaveBeenCalledWith('terminal-1', '\r')
  })
  it('shows one session identifier and opens and navigates CLI commands without submitting a message', async () => {
    const api = mockApi()
    mount(api); await flush()
    const tab = root.querySelector('[role="tab"]')!
    expect(tab.textContent?.trim()).toBe('terminal')
    expect(tab.querySelector('small')).toBeNull()
    expect(tab.querySelector('button')).toBeNull()
    root.querySelector<HTMLButtonElement>('[aria-label="唤起指令"]')!.click(); await flush()
    expect(api.writeTerminal).toHaveBeenLastCalledWith('terminal-1', '/')
    expect(root.querySelector('.mobile-command-controls')).not.toBeNull()
    root.querySelector<HTMLButtonElement>('[aria-label="下一条指令"]')!.click(); await flush()
    expect(api.writeTerminal).toHaveBeenLastCalledWith('terminal-1', '\u001b[B')
    const exit = [...root.querySelectorAll<HTMLButtonElement>('.mobile-command-controls button')].find(button => button.textContent === '退出指令')!
    exit.click(); await flush()
    expect(api.writeTerminal).toHaveBeenLastCalledWith('terminal-1', '\u001b')
    expect(root.querySelector('.mobile-command-controls')).toBeNull()
    expect(api.writeTerminal).not.toHaveBeenCalledWith('terminal-1', '\r')
  })
  it('polls incrementally and stops on a removed session without erasing output', async () => {
    const api = mockApi()
    api.terminalBuffer.mockResolvedValueOnce({ buffer: 'ready', startByte: 0, endByte: 5, running: true, reset: false })
      .mockRejectedValueOnce(new MobileHostError('gone', 404))
    mount(api)
    await flush()
    expect(output.write).toHaveBeenCalledWith('ready')
    await vi.advanceTimersByTimeAsync(350)
    expect(api.terminalBuffer).toHaveBeenLastCalledWith('terminal-1', 5)
    expect(root.textContent).toContain('会话已结束')
    const count = api.terminalBuffer.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.terminalBuffer).toHaveBeenCalledTimes(count)
    expect(output.write).toHaveBeenCalledTimes(1)
  })

  it('keeps unsent text on failure and sends multiline AI text as one pasted message', async () => {
    const api = mockApi()
    api.writeTerminal.mockRejectedValueOnce(new Error('offline'))
    mount(api)
    await flush()
    const input = root.querySelector('textarea')!
    input.value = '第一行\n第二行'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(api.writeTerminal).toHaveBeenCalledWith('terminal-1', '\u001b[200~第一行\n第二行\u001b[201~')
    expect(input.value).toBe('第一行\n第二行')
    expect(root.textContent).toContain('发送失败')
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(api.writeTerminal).not.toHaveBeenCalledWith('terminal-1', '\r')
    await vi.advanceTimersByTimeAsync(250)
    expect(api.writeTerminal).toHaveBeenLastCalledWith('terminal-1', '\r')
    expect(input.value).toBe('')
  })

  it('disconnects the view without closing the computer session', async () => {
    const api = mockApi()
    mount(api)
    await flush()
    dispose?.()
    dispose = undefined
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.closeTerminal).not.toHaveBeenCalled()
    expect(api.terminalBuffer).toHaveBeenCalledTimes(1)
  })
  it('shows the available CLI launchers without connecting', async () => {
    const api = mockApi()
    mount(api, false)
    await flush()
    const launchers = [...root.querySelectorAll<HTMLButtonElement>('.mobile-cli-launchers button')]
    expect(launchers.map(button => button.textContent?.trim())).toEqual(['Claude', 'Codex', 'Kimi', 'Grok', 'Gemini', 'OpenCode'])
    expect(api.listTerminals).not.toHaveBeenCalled()
    expect(root.querySelector('textarea')).not.toBeNull()
  })

  it('opens camera, album and file choices without writing to the CLI', async () => {
    const api = mockApi()
    mount(api)
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click()
    await flush()
    expect(root.querySelector('.mobile-attachment-actions')?.textContent).toContain('拍照')
    expect(root.querySelector('input[capture="environment"]')?.getAttribute('accept')).toBe('image/*')
    expect(api.writeTerminal).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click()
    await flush()
    expect(root.querySelector('.mobile-attachment-actions')).toBeNull()
  })

  it('waits for uploads, retries failures, and keeps attachment-only drafts after send failure', async () => {
    const api = { ...mockApi(), uploadAttachment: vi.fn().mockRejectedValueOnce(new Error('上传断开')).mockResolvedValue({ path: 'C:/work/.superhigh/pasted-images/photo.png' }) }
    mount(api)
    await flush()
    const picker = root.querySelector<HTMLInputElement>('[aria-label="选择相册照片"]')!
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['image'], 'photo.png', { type: 'image/png' })] })
    picker.dispatchEvent(new Event('change'))
    await flush()
    expect(root.textContent).toContain('上传断开')
    expect(root.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.disabled).toBe(true)
    expect(api.writeTerminal).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[aria-label="重试上传"]')!.click()
    await flush()
    expect(root.textContent).toContain('已上传')
    expect(root.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.disabled).toBe(false)
    api.writeTerminal.mockRejectedValueOnce(new Error('offline'))
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(root.textContent).toContain('photo.png')
    expect(api.writeTerminal).toHaveBeenCalledWith('terminal-1', '附件：C:/work/.superhigh/pasted-images/photo.png')
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    await vi.advanceTimersByTimeAsync(250)
    expect(root.querySelector('.mobile-attachment-list')).toBeNull()
  })

  it('ignores uploads removed from the draft and uploads selections sequentially', async () => {
    let finish!: (value: { path: string }) => void
    const api = { ...mockApi(), uploadAttachment: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ path: 'C:/second.txt' }) }
    mount(api); await flush()
    const picker = root.querySelector<HTMLInputElement>('[aria-label="选择文件"]')!
    Object.defineProperty(picker, 'files', { value: [new File(['1'], 'first.txt'), new File(['2'], 'second.txt')] })
    picker.dispatchEvent(new Event('change')); await flush()
    expect(api.uploadAttachment).toHaveBeenCalledTimes(1)
    root.querySelector<HTMLButtonElement>('[aria-label="移除附件"]')!.click(); await flush()
    finish({ path: 'C:/first.txt' }); await flush()
    expect(api.uploadAttachment).toHaveBeenCalledTimes(2)
    expect(root.textContent).not.toContain('first.txt')
    expect(root.textContent).toContain('second.txt')
    expect(api.writeTerminal).not.toHaveBeenCalled()
  })
})
