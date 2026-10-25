import { describe, expect, it, vi } from 'vitest'

import {
  OPEN_EXTERNAL_URL_MESSAGE_TYPE,
  buildExternalLinkBridgeScript,
  openExternalLinkFromClick,
  openExternalUrlMessage,
  urlFromExternalLinkClick,
  urlFromExternalUrlMessage,
} from './externalLinks'

describe('external link handling', () => {
  it('extracts http links from normal anchor clicks', () => {
    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/docs'
    document.body.appendChild(anchor)
    let extracted: string | null = null

    anchor.addEventListener('click', (event) => {
      extracted = urlFromExternalLinkClick(event)
      event.preventDefault()
    })
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    expect(extracted).toBe('https://example.com/docs')
    anchor.remove()
  })

  it('ignores non-web and download links', () => {
    const fileAnchor = document.createElement('a')
    fileAnchor.href = 'file:///C:/temp/index.html'
    const downloadAnchor = document.createElement('a')
    downloadAnchor.href = 'https://example.com/archive.zip'
    downloadAnchor.setAttribute('download', '')

    let fileUrl: string | null = null
    fileAnchor.addEventListener('click', (event) => {
      fileUrl = urlFromExternalLinkClick(event)
      event.preventDefault()
    })
    fileAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    let downloadUrl: string | null = null
    downloadAnchor.addEventListener('click', (event) => {
      downloadUrl = urlFromExternalLinkClick(event)
      event.preventDefault()
    })
    downloadAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    expect(fileUrl).toBeNull()
    expect(downloadUrl).toBeNull()
  })

  it('prevents default and sends web links to the provided opener', () => {
    const anchor = document.createElement('a')
    anchor.href = 'http://127.0.0.1:1420/'
    const openUrl = vi.fn()
    let prevented = false

    anchor.addEventListener('click', (event) => {
      const handled = openExternalLinkFromClick(event, openUrl)
      prevented = event.defaultPrevented
      expect(handled).toBe(true)
    })
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    expect(prevented).toBe(true)
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:1420/')
  })

  it('validates iframe open-url messages', () => {
    expect(urlFromExternalUrlMessage(openExternalUrlMessage('https://example.com'))).toBe('https://example.com')
    expect(urlFromExternalUrlMessage({ type: OPEN_EXTERNAL_URL_MESSAGE_TYPE, url: 'javascript:alert(1)' })).toBeNull()
    expect(urlFromExternalUrlMessage({ type: 'other', url: 'https://example.com' })).toBeNull()
  })

  it('builds the sandbox iframe bridge script', () => {
    const script = buildExternalLinkBridgeScript()

    expect(script).toContain(OPEN_EXTERNAL_URL_MESSAGE_TYPE)
    expect(script).toContain('document.addEventListener')
    expect(script).toContain('window.parent.postMessage')
  })
})
