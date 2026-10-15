// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { buildHtmlPreviewResourceBridge } from './htmlPreviewResources'

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
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'superhigh-editor:resource-result', requestId: request.requestId, dataUrl: 'data:image/png;base64,AA==' } }))
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AA==')
    image.setAttribute('src', 'images/光1.png')
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(post.mock.calls.filter(([data]) => data.type === 'superhigh-editor:resource')).toHaveLength(2)
    window.close()
  })
})
