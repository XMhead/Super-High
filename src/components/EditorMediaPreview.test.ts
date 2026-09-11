import { createApp, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import EditorMediaPreview from './EditorMediaPreview.vue'

const mocks = vi.hoisted(() => ({ openFileWithApp: vi.fn(), openPath: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ backend: mocks }))

describe('editor media preview', () => {
  it.each(['mp4', 'mp3'])('offers working alternatives after %s decoding fails', async (extension) => {
    const root = document.createElement('div')
    const path = `D:/Media/原生运镜.${extension}`
    const app = createApp(EditorMediaPreview, { path, source: 'http://asset.localhost/test' })
    app.mount(root)
    const player = root.querySelector(extension === 'mp3' ? 'audio' : 'video')!
    expect(player.getAttribute('preload')).toBe('metadata')
    expect(mocks.openFileWithApp).not.toHaveBeenCalled()
    player.dispatchEvent(new Event('error'))
    await nextTick()
    expect(root.textContent).toContain('此媒体无法在内置播放器播放')
    const buttons = root.querySelectorAll('button')
    buttons[0].click()
    await nextTick()
    expect(mocks.openFileWithApp).toHaveBeenCalledWith(path)
    buttons[1].click()
    await nextTick()
    expect(mocks.openPath).toHaveBeenCalledWith(path)
    app.unmount()
    vi.clearAllMocks()
  })
})
