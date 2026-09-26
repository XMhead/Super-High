// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { localPreviewRequest } from '../../scripts/mobile-preview-host'

function request(address: string, host: string, origin?: string, site?: string) {
  return { socket: { remoteAddress: address }, headers: { host, origin, 'sec-fetch-site': site } } as IncomingMessage
}

describe('local mobile preview connection', () => {
  it('accepts same-origin loopback preview requests', () => {
    expect(localPreviewRequest(request('127.0.0.1', '127.0.0.1:1421', 'http://127.0.0.1:1421', 'same-origin'))).toBe(true)
    expect(localPreviewRequest(request('::1', 'localhost:1421'))).toBe(true)
  })
  it('does not hand desktop credentials to non-loopback clients or foreign origins', () => {
    expect(localPreviewRequest(request('203.0.113.2', '127.0.0.1:1421'))).toBe(false)
    expect(localPreviewRequest(request('127.0.0.1', 'preview.example:1421'))).toBe(false)
    expect(localPreviewRequest(request('127.0.0.1', 'localhost:1421', 'http://localhost:9999'))).toBe(false)
    expect(localPreviewRequest(request('127.0.0.1', 'localhost:1421', undefined, 'cross-site'))).toBe(false)
  })
})
