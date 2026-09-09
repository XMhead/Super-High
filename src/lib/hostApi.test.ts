import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileHostApi, MobileHostError } from './hostApi'

afterEach(() => vi.unstubAllGlobals())

describe('MobileHostApi', () => {
  it('sends terminal input in an authenticated JSON body', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetcher)
    const api = new MobileHostApi({ baseUrl: 'http://localhost:10320/', token: ' test-token ' })
    await api.writeTerminal('session-1', '你好\r')
    expect(fetcher).toHaveBeenCalledWith('http://localhost:10320/api/mobile/terminals/input', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', input: '你好\r' }),
    }))
  })

  it('preserves the HTTP status so an ended session can stop polling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"会话已结束"}', { status: 404 })))
    const api = new MobileHostApi({ baseUrl: 'http://localhost:10320', token: 'test-token' })
    const result = api.terminalBuffer('session-1', 12)
    await expect(result).rejects.toBeInstanceOf(MobileHostError)
    await expect(result).rejects.toMatchObject({ status: 404, message: '会话已结束' })
  })
})
