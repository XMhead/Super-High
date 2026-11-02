// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { buildHtmlPreviewResourceBridge } from './htmlPreviewResources'
import { buildExternalLinkBridgeScript } from './externalLinks'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
const bootstrap = readFileSync('public/html-preview-bootstrap.js', 'utf8')

describe('release HTML preview events', () => {
  it('keeps global bindings, element scope, this, and return false in event attributes', () => {
    const dom = new JSDOM(`<button value="风" onclick="filter=value;paint();return false">筛选</button><div id="status"></div><script>let filter='全部';function paint(){document.getElementById('status').textContent=filter}</script>`, { runScripts: 'dangerously' })
    const { window } = dom
    window.document.write = () => undefined
    window.eval(bootstrap)
    const button = window.document.querySelector('button')!
    const click = new window.MouseEvent('click', { cancelable: true })
    button.dispatchEvent(click)
    expect(window.document.querySelector('#status')?.textContent).toBe('风')
    expect(click.defaultPrevented).toBe(true)
    expect(button.hasAttribute('onclick')).toBe(false)
    window.close()
  })

  it('binds handlers on dynamically rendered cards and changed event attributes', async () => {
    const dom = new JSDOM('<main id="grid"></main>', { runScripts: 'outside-only' })
    const { window } = dom
    window.document.write = () => undefined
    window.eval(bootstrap)
    window.document.querySelector('#grid')!.innerHTML = `<button onclick="this.textContent='放大'">图片</button>`
    await new Promise(resolve => window.setTimeout(resolve, 0))
    const button = window.document.querySelector('button')!
    button.click()
    expect(button.textContent).toBe('放大')
    button.setAttribute('onclick', "this.textContent='关闭'")
    await new Promise(resolve => window.setTimeout(resolve, 0))
    button.click()
    expect(button.textContent).toBe('关闭')
    window.close()
  })

  it('loads an existing zoom image again when the same relative src is reused', async () => {
    const dom = new JSDOM('<img id="large">', { runScripts: 'outside-only' })
    const { window } = dom
    const post = vi.fn()
    window.postMessage = post
    window.eval(buildHtmlPreviewResourceBridge('D:/Project/gallery.html'))
    const image = window.document.querySelector('img')!
    image.setAttribute('src', 'images/光1.png')
    await new Promise(resolve => window.setTimeout(resolve, 0))
    const request = post.mock.calls.find(([data]) => data.type === 'superhigh-editor:resource')![0]
    window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'superhigh-editor:resource-result', requestId: request.requestId, dataUrl: 'data:image/png;base64,AA==' } }))
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AA==')
    image.setAttribute('src', 'images/光1.png')
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(post.mock.calls.filter(([data]) => data.type === 'superhigh-editor:resource')).toHaveLength(2)
    window.close()
  })

  it('resolves dynamically inserted file URLs and srcset candidates', async () => {
    const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
    const { window } = dom
    const post = vi.fn()
    window.postMessage = post
    window.eval(buildHtmlPreviewResourceBridge('D:/Project/review.html'))
    window.document.querySelector('main')!.innerHTML = '<img src="file:///D:/Other/%E4%B8%AD.png" srcset="../one.png 1x, D:/Other/two.png 2x">'
    await new Promise(resolve => window.setTimeout(resolve, 0))
    const requests = post.mock.calls.map(([data]) => data).filter(data => data.type === 'superhigh-editor:resource')
    expect(requests.map(data => data.path)).toEqual(['file:///D:/Other/%E4%B8%AD.png', '../one.png', 'D:/Other/two.png'])
    for (const [index, request] of requests.entries()) {
      window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'superhigh-editor:resource-result', requestId: request.requestId, dataUrl: `data:image/png;base64,AA${index}` } }))
    }
    await new Promise(resolve => window.setTimeout(resolve, 0))
    const image = window.document.querySelector('img')!
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AA0')
    expect(image.getAttribute('srcset')).toBe('data:image/png;base64,AA1 1x, data:image/png;base64,AA2 2x')
    window.close()
  })

  it('scrolls local fragments without opening the inherited Tauri URL', () => {
    const dom = new JSDOM('<a href="#world"><span>进入未来</span></a><div id="world"></div><a href="https://example.com/">外链</a>', { runScripts: 'outside-only', url: 'http://tauri.localhost/' })
    const { window } = dom
    const post = vi.fn()
    const scroll = vi.fn()
    window.postMessage = post
    window.document.getElementById('world')!.scrollIntoView = scroll
    window.eval(buildExternalLinkBridgeScript())
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    window.document.querySelector('span')!.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(scroll).toHaveBeenCalledOnce()
    expect(post).not.toHaveBeenCalled()
    window.document.querySelectorAll('a')[1]!.click()
    expect(post).toHaveBeenCalledWith({ type: 'superhigh:open-external-url', url: 'https://example.com/' }, '*')
    window.close()
  })

  it('loads local JSON through the host and reports missing resources', async () => {
    const dom = new JSDOM('', { runScripts: 'outside-only', url: 'http://tauri.localhost/' })
    const { window } = dom
    window.Response = Response
    const post = vi.fn()
    window.postMessage = post
    window.eval(buildHtmlPreviewResourceBridge('D:/Project/review.html'))
    const result = window.fetch('./items.json?rev=1')
    const request = post.mock.calls.find(([data]) => data.type === 'superhigh-editor:resource')![0]
    expect(request.path).toBe('./items.json?rev=1')
    expect(request.kind).toBe('text')
    window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'superhigh-editor:resource-result', requestId: request.requestId, text: '[{"name":"中文"}]' } }))
    expect(await (await result).json()).toEqual([{ name: '中文' }])
    const missing = window.fetch('missing.json')
    const last = post.mock.calls.at(-1)![0]
    window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'superhigh-editor:resource-error', requestId: last.requestId, error: 'not found' } }))
    await expect(missing).rejects.toThrow('not found')
    window.close()
  })

  it('lets a sandboxed review page initialize and edit localStorage synchronously', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' })
    const { window } = dom
    const post = vi.fn()
    window.postMessage = post
    window.eval(buildHtmlPreviewResourceBridge('D:/Project/review.html'))
    window.eval(`let state=JSON.parse(localStorage.getItem('review')||'{"labels":{}}'); state.labels.I01='pass'; localStorage.setItem('review',JSON.stringify(state));`)
    expect(JSON.parse(window.localStorage.getItem('review')!)).toEqual({ labels: { I01: 'pass' } })
    expect(post).toHaveBeenCalledWith({ type: 'superhigh-html:storage', entries: { review: '{"labels":{"I01":"pass"}}' } }, '*')
    window.sessionStorage.setItem('temp', '中文')
    expect(window.sessionStorage.getItem('temp')).toBe('中文')
    window.close()
  })
})
