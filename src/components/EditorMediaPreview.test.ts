import { createApp, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EditorMediaPreview from './EditorMediaPreview.vue'

const mocks = vi.hoisted(() => ({ openFileWithApp: vi.fn(), openPath: vi.fn(), nativeVideoSupported: vi.fn(), nativeVideo: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ backend: mocks }))
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); await nextTick() }

describe('editor media preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.nativeVideoSupported.mockReset().mockResolvedValue(false)
    mocks.nativeVideo.mockReset().mockImplementation(async (_id, action) => action.type === 'status'
      ? { position: 0, duration: 7, paused: true, ended: false, width: 2560, height: 1351, ready: true, volume: 100 } : undefined)
  })
  it.each(['mp4', 'mp3'])('offers working alternatives after %s decoding fails', async (extension) => {
    const root = document.createElement('div')
    const path = `D:/Media/原生运镜.${extension}`
    const app = createApp(EditorMediaPreview, { path, source: 'http://asset.localhost/test' })
    app.mount(root)
    await flush()
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

  it('plays the original RGB video with the native engine and closes it when switching to audio', async () => {
    mocks.nativeVideoSupported.mockResolvedValue(true)
    const root = document.createElement('div')
    const app = createApp(EditorMediaPreview, { path: 'D:/Media/RGB.mp4', source: 'http://asset.localhost/test' })
    const component = app.mount(root)
    await flush()
    expect(root.querySelector('video')).toBeNull()
    expect(root.querySelector('.native-video-player.embedded')).not.toBeNull()
    expect(mocks.nativeVideo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'open', path: 'D:/Media/RGB.mp4' }))
    const id = mocks.nativeVideo.mock.calls[0][0]
    component.$.props.path = 'D:/Media/music.mp3'
    await flush()
    expect(root.querySelector('audio')).not.toBeNull()
    expect(mocks.nativeVideo).toHaveBeenCalledWith(id, { type: 'close' })
    app.unmount()
  })

  it('ignores a late capability response after switching away from video', async () => {
    let resolve!: (supported: boolean) => void
    mocks.nativeVideoSupported.mockReturnValue(new Promise<boolean>(done => { resolve = done }))
    const root = document.createElement('div')
    const app = createApp(EditorMediaPreview, { path: 'D:/Media/RGB.mp4', source: 'http://asset.localhost/test' })
    const component = app.mount(root)
    component.$.props.path = 'D:/Media/music.mp3'
    await flush()
    resolve(true)
    await flush()
    expect(root.querySelector('audio')).not.toBeNull()
    expect(mocks.nativeVideo).not.toHaveBeenCalled()
    app.unmount()
  })

  it('offers external opening when the native decoder fails', async () => {
    mocks.nativeVideoSupported.mockResolvedValue(true)
    mocks.nativeVideo.mockRejectedValue(new Error('decode failed'))
    const root = document.createElement('div')
    const app = createApp(EditorMediaPreview, { path: 'D:/Media/RGB.mp4', source: 'http://asset.localhost/test' })
    app.mount(root)
    await flush()
    expect(root.textContent).toContain('此媒体无法在内置播放器播放')
    expect(root.querySelector('.native-video-player')).toBeNull()
    expect(root.querySelector('video')).toBeNull()
    app.unmount()
  })
})
