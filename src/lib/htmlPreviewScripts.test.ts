import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { prepareHtmlPreviewScripts } from './htmlPreviewScripts'

describe('HTML preview under release CSP', () => {
  it('defers executable scripts in order and retains data and attributes', () => {
    const result = prepareHtmlPreviewScripts('<html><head><script id="bridge">window.bridge={}</script></head><body><script type="application/json">{"key":1}</script><script src="external.js"></script><script type="module">window.bridge.ready=true</script></body></html>')
    const doc = new DOMParser().parseFromString(result, 'text/html')
    const scripts = [...doc.querySelectorAll('script[data-superhigh-script-type]')]
    expect(scripts.map(s => s.getAttribute('data-superhigh-script-type'))).toEqual(['', '', 'module'])
    expect(scripts.every(s => s.getAttribute('type') === 'application/x-superhigh-script')).toBe(true)
    expect(scripts[1].getAttribute('src')).toBe('external.js')
    expect(doc.querySelector('script[type="application/json"]')?.textContent).toBe('{"key":1}')
    expect(doc.querySelector('#bridge')?.textContent).toBe('window.bridge={}')
    const loader = doc.body.lastElementChild
    expect(loader?.id).toBe('superhigh-html-preview-bootstrap')
    expect(loader?.hasAttribute('src')).toBe(false)
    const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
    const hash = createHash('sha256').update(loader?.textContent ?? '').digest('base64')
    expect(csp.split(';').find((rule: string) => rule.trim().startsWith('script-src '))).toContain("'sha256-" + hash + "'")
  })
})
