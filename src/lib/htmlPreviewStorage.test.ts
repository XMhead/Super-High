import { describe, expect, it } from 'vitest'
import { buildHtmlPreviewStorageBridge, HTML_PREVIEW_STORAGE_MESSAGE, persistHtmlPreviewStorage } from './htmlPreviewStorage'

describe('sandbox preview storage', () => {
  it('persists review state per HTML file without sharing another page storage', () => {
    const entries = { review: '{"labels":{"I01":"pass"}}' }
    expect(persistHtmlPreviewStorage('D:/Project/review.html', { type: HTML_PREVIEW_STORAGE_MESSAGE, entries })).toBe(true)
    expect(buildHtmlPreviewStorageBridge('D:/Project/review.html')).toContain('I01')
    expect(buildHtmlPreviewStorageBridge('D:/Project/other.html')).not.toContain('I01')
    expect(persistHtmlPreviewStorage('D:/Project/review.html', { type: HTML_PREVIEW_STORAGE_MESSAGE, entries: { invalid: 123 } })).toBe(true)
    expect(buildHtmlPreviewStorageBridge('D:/Project/review.html')).toContain('I01')
  })
})
