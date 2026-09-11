import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileHostApi, MobileHostError } from './hostApi'

afterEach(() => vi.unstubAllGlobals())

describe('MobileHostApi', () => {
  it('uploads a real file data URL and returns the host attachment path', async () => {
    const attachment = { path: 'D:/project/.superhigh/pasted-images/a.txt', name: 'a.txt', mimeType: 'text/plain', size: 5 }
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(attachment)))
    vi.stubGlobal('fetch', fetcher)
    const api = new MobileHostApi({ baseUrl: 'http://localhost:10320', token: 'test-token' })
    await expect(api.uploadAttachment('D:/project', new File(['hello'], 'a.txt', { type: 'text/plain' }))).resolves.toEqual(attachment)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ root: 'D:/project', name: 'a.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' })
    expect(fetcher.mock.calls[0][0]).toMatch(/\/attachments$/)
  })

  it('rejects upload errors without sending terminal input', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"上传失败"}', { status: 400 }))
    vi.stubGlobal('fetch', fetcher)
    const api = new MobileHostApi({ baseUrl: 'http://localhost:10320', token: 'test-token' })
    await expect(api.uploadAttachment('D:/project', new File(['hello'], 'a.txt'))).rejects.toThrow('上传失败')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toMatch(/\/attachments$/)
  })

  it('patches only explicitly selected preferences', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"themeId":"dark","hiddenCliProviderIds":[]}'))
    vi.stubGlobal('fetch', fetcher)
    const api = new MobileHostApi({ baseUrl: 'http://localhost:10320', token: 'test-token' })
    await api.updatePreferences({ themeId: 'dark' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ themeId: 'dark' })
  })

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
