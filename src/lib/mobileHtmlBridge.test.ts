import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerMobileHtmlPreview, replyMobileHtml, requestMobileHtml } from './mobileHtmlBridge'

let stop: (() => void) | undefined
afterEach(() => { stop?.(); vi.useRealTimers() })
describe('mobile uses the current desktop HTML host', () => {
  it('returns the desktop document and makes its bootstrap usable from the phone origin', async () => {
    const bootstrap = new URL('/html-preview-bootstrap.js', window.location.href).href
    stop = registerMobileHtmlPreview(() => 'D:/page.html', () => ({ document: `<script src="${bootstrap}"></script>`, contextMessages: [{ type: 'context' }] }), async () => {})
    expect(await requestMobileHtml({ operation: 'html-document', path: 'd:\\page.html' })).toEqual({ document: '<script src="/mobile/html-preview-bootstrap.js"></script>', contextMessages: [{ type: 'context' }] })
  })
  it('isolates a mobile reply from the desktop iframe and restores its original request ID', async () => {
    const handler = vi.fn(async (data: Record<string, unknown>) => {
      expect(data.requestId).not.toBe('phone-1')
      expect(replyMobileHtml({ type: 'superhigh-editor:fs-result', requestId: data.requestId, result: 'real content' })).toBe(true)
    })
    stop = registerMobileHtmlPreview(() => 'D:/page.html', () => ({ document: '', contextMessages: [] }), handler)
    expect(await requestMobileHtml({ operation: 'html-message', path: 'D:/page.html', data: { type: 'superhigh-editor:fs', requestId: 'phone-1', operation: 'read' } })).toEqual({ type: 'superhigh-editor:fs-result', requestId: 'phone-1', result: 'real content' })
    expect(replyMobileHtml({ requestId: 'phone-1' })).toBe(false)
  })
  it('rejects a request after the desktop has left the requested preview', async () => {
    stop = registerMobileHtmlPreview(() => 'D:/other.html', () => ({ document: '', contextMessages: [] }), async () => {})
    await expect(requestMobileHtml({ operation: 'html-document', path: 'D:/page.html' })).rejects.toThrow('未显示')
  })
})
