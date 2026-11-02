import { describe, expect, it } from 'vitest'
import { prepareHtmlPreviewScripts } from './htmlPreviewScripts'

describe('HTML preview under release CSP', () => {
  it('defers executable scripts in order and retains data and attributes', () => {
    const result = prepareHtmlPreviewScripts('<html><head><script id="bridge">window.bridge={}</script></head><body><script type="application/json">{"key":1}</script><script src="external.js"></script><script type="module">window.bridge.ready=true</script></body></html>', 'http://tauri.localhost/html-preview-bootstrap.js')
    const doc = new DOMParser().parseFromString(result, 'text/html')
    const scripts = [...doc.querySelectorAll('script[data-superhigh-script-type]')]
    expect(scripts.map(s => s.getAttribute('data-superhigh-script-type'))).toEqual(['', '', 'module'])
    expect(scripts.every(s => s.getAttribute('type') === 'application/x-superhigh-script')).toBe(true)
    expect(scripts[1].getAttribute('src')).toBe('external.js')
    expect(doc.querySelector('script[type="application/json"]')?.textContent).toBe('{"key":1}')
    expect(doc.querySelector('#bridge')?.textContent).toBe('window.bridge={}')
    expect(doc.body.lastElementChild?.getAttribute('src')).toBe('http://tauri.localhost/html-preview-bootstrap.js')
  })
})
