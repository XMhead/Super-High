import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import MobileSessions from './MobileSessions.vue'

const output = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn() }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 60
  rows = 20
  loadAddon() {}
  open() {}
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
  it('shows all CLI launchers without connecting and disables dsh-tui', async () => {
    const api = mockApi()
    mount(api, false)
    await flush()
    const launchers = [...root.querySelectorAll<HTMLButtonElement>('.mobile-cli-launchers button')]
    expect(launchers.map(button => button.textContent?.trim())).toEqual(['Claude', 'Codex', 'Kimi', 'Grok', 'Gemini', 'OpenCode', 'dsh-tui'])
    expect(launchers[6].disabled).toBe(true)
    expect(api.listTerminals).not.toHaveBeenCalled()
    expect(root.querySelector('textarea')).not.toBeNull()
  })

  it('sends the plus slash trigger to the current CLI without submitting', async () => {
    const api = mockApi()
    mount(api)
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="唤起斜杠命令"]')!.click()
    await flush()
    expect(api.writeTerminal).toHaveBeenCalledWith('terminal-1', '/')
    await vi.advanceTimersByTimeAsync(300)
    expect(api.writeTerminal).toHaveBeenCalledTimes(1)
  })

})

