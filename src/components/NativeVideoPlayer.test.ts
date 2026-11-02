import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NativeVideoPlayer from './NativeVideoPlayer.vue'

const mocks = vi.hoisted(() => ({ command: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ backend: { nativeVideo: mocks.command } }))

const playing = { position: 1.5, duration: 6.433333, paused: true, ended: false, width: 2560, height: 1440, ready: true, volume: 100 }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await nextTick() }

function mount(embedded = false) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const metadata = vi.fn()
  const app = createApp(NativeVideoPlayer, { path: 'D:/Media/RGB recording.mp4', embedded, onMetadata: metadata })
  app.mount(root)
  return { app, root, metadata }
}

describe('native video lifetime and controls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.command.mockReset().mockImplementation(async (_id, action) => action.type === 'status' ? playing : undefined)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('opens the original path, exposes decoded dimensions and releases the decoder on unmount', async () => {
    const { app, root, metadata } = mount()
    await flush()
    const id = mocks.command.mock.calls[0][0]
    expect(mocks.command).toHaveBeenCalledWith(id, expect.objectContaining({ type: 'open', path: 'D:/Media/RGB recording.mp4' }))
    expect(metadata).toHaveBeenCalledWith(2560, 1440)
    ;(root.querySelector('[aria-label="播放"]') as HTMLButtonElement).click()
    await flush()
    expect(mocks.command).toHaveBeenCalledWith(id, { type: 'pause', paused: false })
    const slider = root.querySelector('[aria-label="播放进度"]') as HTMLInputElement
    slider.value = '4.25'
    slider.dispatchEvent(new Event('change'))
    await flush()
    expect(mocks.command).toHaveBeenCalledWith(id, { type: 'seek', seconds: 4.25 })
    app.unmount()
    await flush()
    const count = mocks.command.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.command).toHaveBeenCalledWith(id, { type: 'close' })
    expect(mocks.command).toHaveBeenCalledTimes(count)
  })

  it('cancels a still-opening session and does not poll or reveal it after unmount', async () => {
    let resolveOpen!: () => void
    mocks.command.mockImplementation((_id, action) => action.type === 'open' ? new Promise<void>(resolve => { resolveOpen = resolve }) : Promise.resolve())
    const { app } = mount()
    await flush()
    app.unmount()
    await flush()
    expect(mocks.command).toHaveBeenCalledWith(expect.any(String), { type: 'close' })
    resolveOpen()
    await flush()
    expect(mocks.command.mock.calls.some(([, action]) => action.type === 'status')).toBe(false)
  })

  it('closes the decoder and presents a playback failure', async () => {
    mocks.command.mockImplementation(async (_id, action) => {
      if (action.type === 'status') throw new Error('decode failed')
    })
    const { app, root } = mount()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('decode failed')
    expect(mocks.command).toHaveBeenCalledWith(expect.any(String), { type: 'close' })
    app.unmount()
  })

  it('hides an embedded native surface under an overlay and restores its resized bounds', async () => {
    const rect = { left: 20, top: 30, right: 660, bottom: 390, width: 640, height: 360, x: 20, y: 30, toJSON() {} }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
    const hit = vi.fn(() => document.querySelector('.native-video-surface'))
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit })
    const { app, root } = mount(true)
    await flush()
    const id = mocks.command.mock.calls[0][0]
    expect(mocks.command).toHaveBeenCalledWith(id, { type: 'bounds', bounds: { x: 20, y: 30, width: 640, height: 360, scale: 1, visible: true } })
    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    hit.mockReturnValue(overlay)
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.command).toHaveBeenLastCalledWith(id, expect.objectContaining({ type: 'bounds', bounds: expect.objectContaining({ visible: false }) }))
    rect.width = 300
    rect.right = 320
    hit.mockReturnValue(root.querySelector('.native-video-surface'))
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.command).toHaveBeenLastCalledWith(id, expect.objectContaining({ type: 'bounds', bounds: expect.objectContaining({ width: 300, visible: true }) }))
    app.unmount()
    delete (document as Partial<Document>).elementFromPoint
  })

  it('limits embedded space shortcuts to the focused player', async () => {
    const { app, root } = mount(true)
    await flush()
    mocks.command.mockClear()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    expect(mocks.command).not.toHaveBeenCalled()
    root.querySelector('.native-video-player')!.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    await flush()
    expect(mocks.command).toHaveBeenCalledWith(expect.any(String), { type: 'pause', paused: false })
    app.unmount()
  })
})
