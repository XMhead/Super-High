import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OfficePreview from './OfficePreview.vue'

vi.mock('@/lib/tauri', () => ({ backend: { openUrl: vi.fn() } }))
vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_bytes, body: HTMLElement) => {
    const image = document.createElement('img')
    image.src = 'data:image/png;base64,aGVsbG8='
    body.appendChild(image)
  }),
}))
const dispose: (() => void)[] = []
afterEach(() => { dispose.splice(0).forEach((fn) => fn()); vi.unstubAllGlobals() })

describe('Word preview', () => {
  it.each(['doc', 'docx'])('renders %s and opens its original embedded image with zoom controls', async (extension) => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    HTMLDialogElement.prototype.close = function () { this.open = false }
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp(OfficePreview, { path: `E:/example.${extension}`, content: 'UEs=' })
    app.mount(root)
    dispose.push(() => { app.unmount(); root.remove() })
    await vi.waitFor(() => expect(root.querySelector('.office-word')?.shadowRoot?.querySelector('img')).toBeTruthy())
    const image = root.querySelector('.office-word')!.shadowRoot!.querySelector('img')!
    image.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    await nextTick()
    await nextTick()
    const viewer = document.querySelector<HTMLDialogElement>('.document-image-dialog')!
    expect(viewer.open).toBe(true)
    expect(viewer.querySelector('img')?.getAttribute('src')).toBe(image.src)
    expect(viewer.textContent).toContain('原始大小')
    const close = Array.from(viewer.querySelectorAll('button')).find((button) => button.textContent === '关闭')!
    close.click()
    await nextTick()
    expect(document.querySelector('.document-image-dialog')).toBeNull()
    image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(document.querySelector('.document-image-dialog')).not.toBeNull()
  })
})
