import { createApp, defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MediaViewer from './MediaViewer.vue'
import type { DirectoryListing } from '@/types'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listDirectory: vi.fn(),
  readMediaAsDataUrl: vi.fn(),
  copyFilesToClipboard: vi.fn(),
  saveImageDataUrl: vi.fn(),
  pickPngExportPath: vi.fn(),
  openPath: vi.fn(),
  clipboardWrite: vi.fn(),
  clipboardWriteText: vi.fn(),
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  getImageData: vi.fn(),
  putImageData: vi.fn(),
  strokeRect: vi.fn(),
  toDataURL: vi.fn(),
  currentWindow: {
    setMinSize: vi.fn(),
    setSize: vi.fn(),
    center: vi.fn(),
    startDragging: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    isFullscreen: vi.fn(),
    setFullscreen: vi.fn(),
    setTitle: vi.fn(),
  },
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
    readMediaAsDataUrl: mocks.readMediaAsDataUrl,
    copyFilesToClipboard: mocks.copyFilesToClipboard,
    saveImageDataUrl: mocks.saveImageDataUrl,
    pickPngExportPath: mocks.pickPngExportPath,
    openPath: mocks.openPath,
  },
  isTauri: mocks.isTauri,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mocks.currentWindow,
  LogicalSize: class LogicalSize {
    constructor(public readonly width: number, public readonly height: number) {}
  },
}))

class MockClipboardItem {
  constructor(public readonly data: Record<string, Blob>) {}
}

function listing(): DirectoryListing {
  return {
    path: 'D:/Media',
    entries: [
      { name: 'b.png', path: 'D:/Media/b.png', type: 'file', extension: '.png' },
      { name: 'clip.mp4', path: 'D:/Media/clip.mp4', type: 'file', extension: '.mp4' },
      { name: 'a.png', path: 'D:/Media/a.png', type: 'file', extension: '.png' },
      { name: 'notes.txt', path: 'D:/Media/notes.txt', type: 'file', extension: '.txt' },
    ],
  }
}

function mountViewer(initialPath = 'D:/Media/a.png', onCloseApproved?: () => void) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({
    render: () => h(MediaViewer, { initialPath, onCloseApproved }),
  }))
  app.mount(root)
  return { app, root }
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function loadImage(root: HTMLElement, width = 32, height = 16) {
  await flushPromises()
  const image = root.querySelector('.media-viewer-image') as HTMLImageElement
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height })
  image.dispatchEvent(new Event('load'))
  await nextTick()
  return image
}

async function enterEditMode(root: HTMLElement, width = 32, height = 16) {
  await loadImage(root, width, height)
  ;(root.querySelector('[title="编辑模式"]') as HTMLButtonElement).click()
  await flushPromises()
  return root.querySelector('.media-viewer-canvas') as HTMLCanvasElement
}

function canvasBounds(canvas: HTMLCanvasElement, width: number, height: number) {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect)
}

function stageSize(stage: HTMLElement, width: number, height: number) {
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: height })
}

function buttonWithText(root: HTMLElement, text: string) {
  return Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === text) as HTMLButtonElement
}

function pointerEvent(type: string, values: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const pointerValues = {
    offsetX: values.clientX ?? 0,
    offsetY: values.clientY ?? 0,
    ...values,
  }
  for (const [key, value] of Object.entries(pointerValues)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

describe('MediaViewer', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    mocks.isTauri.mockReset()
    mocks.isTauri.mockReturnValue(false)
    mocks.listDirectory.mockReset()
    mocks.readMediaAsDataUrl.mockReset()
    mocks.copyFilesToClipboard.mockReset()
    mocks.saveImageDataUrl.mockReset()
    mocks.pickPngExportPath.mockReset()
    mocks.openPath.mockReset()
    mocks.clipboardWrite.mockReset()
    mocks.clipboardWriteText.mockReset()
    mocks.drawImage.mockReset()
    mocks.fillRect.mockReset()
    mocks.clearRect.mockReset()
    mocks.getImageData.mockReset()
    mocks.putImageData.mockReset()
    mocks.strokeRect.mockReset()
    mocks.toDataURL.mockReset()
    for (const method of Object.values(mocks.currentWindow)) method.mockReset()
    for (const method of Object.values(mocks.currentWindow)) method.mockResolvedValue(undefined)
    mocks.currentWindow.isFullscreen.mockResolvedValue(false)
    mocks.listDirectory.mockResolvedValue(listing())
    mocks.readMediaAsDataUrl.mockImplementation(async (path: string) => (
      path.toLowerCase().endsWith('.mp4')
        ? 'data:video/mp4;base64,AA=='
        : 'data:image/png;base64,AA=='
    ))
    mocks.copyFilesToClipboard.mockResolvedValue(undefined)
    mocks.saveImageDataUrl.mockResolvedValue('D:/Media/a.png')
    mocks.pickPngExportPath.mockResolvedValue('D:/Media/a-edited.png')
    mocks.openPath.mockResolvedValue(undefined)
    mocks.clipboardWrite.mockResolvedValue(undefined)
    mocks.clipboardWriteText.mockResolvedValue(undefined)
    mocks.getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 255]) })
    mocks.toDataURL.mockReturnValue('data:image/png;base64,AA==')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: mocks.clipboardWrite,
        writeText: mocks.clipboardWriteText,
      },
    })
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: MockClipboardItem,
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: mocks.drawImage,
      fillRect: mocks.fillRect,
      clearRect: mocks.clearRect,
      getImageData: mocks.getImageData,
      putImageData: mocks.putImageData,
      strokeRect: mocks.strokeRect,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['png'], { type: 'image/png' }))
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(mocks.toDataURL)
  })

  it('loads the initial image with pixel rendering and no redundant footer', async () => {
    const { app, root } = mountViewer()
    const image = await loadImage(root)

    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/Media')
    expect(mocks.readMediaAsDataUrl).toHaveBeenCalledWith('D:/Media/a.png')
    expect(image.classList.contains('raster')).toBe(true)
    expect(root.querySelector('.media-viewer-statusbar')).toBeNull()
    expect(root.textContent).not.toContain('D:/Media/a.png')
    expect(root.textContent).not.toContain('32 × 16')

    app.unmount()
  })

  it('keeps a newly selected image hidden until its fit zoom is ready', async () => {
    const { app, root } = mountViewer()
    const initialImage = await loadImage(root)
    const stage = root.querySelector('.media-viewer-stage') as HTMLElement
    stageSize(stage, 1000, 700)

    ;(root.querySelector('[aria-label="下一个媒体"]') as HTMLButtonElement).click()
    await flushPromises()

    const nextImage = root.querySelector('.media-viewer-image') as HTMLImageElement
    expect(nextImage).not.toBe(initialImage)
    expect(nextImage.style.display).toBe('none')

    Object.defineProperty(nextImage, 'naturalWidth', { configurable: true, value: 2000 })
    Object.defineProperty(nextImage, 'naturalHeight', { configurable: true, value: 1000 })
    nextImage.dispatchEvent(new Event('load'))
    await nextTick()

    expect(nextImage.style.display).not.toBe('none')
    expect(nextImage.style.transform).toContain('scale(0.452)')

    app.unmount()
  })

  it('zooms from presets and the wheel, then pans by dragging', async () => {
    const { app, root } = mountViewer()
    const image = await loadImage(root)
    const stage = root.querySelector('.media-viewer-stage') as HTMLElement

    ;(root.querySelector('[aria-label="200%"]') as HTMLButtonElement).click()
    await nextTick()
    expect(image.style.transform).toContain('scale(2)')

    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }))
    await nextTick()
    expect(image.style.transform).toContain('scale(2.2)')

    stage.dispatchEvent(pointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 20 }))
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 30, clientY: 50 }))
    await nextTick()
    expect(image.style.transform).toContain('translate(-50%, -50%) translate(20px, 30px)')

    app.unmount()
  })

  it('centers ultra-wide and ultra-tall images in the real stage instead of sizing the stage to the image', async () => {
    const wide = mountViewer()
    await flushPromises()
    const wideStage = wide.root.querySelector('.media-viewer-stage') as HTMLElement
    stageSize(wideStage, 1200, 800)
    const wideImage = wide.root.querySelector('.media-viewer-image') as HTMLImageElement
    Object.defineProperty(wideImage, 'naturalWidth', { configurable: true, value: 4000 })
    Object.defineProperty(wideImage, 'naturalHeight', { configurable: true, value: 32 })
    wideImage.dispatchEvent(new Event('load'))
    await nextTick()

    expect((wide.root.querySelector('.media-viewer') as HTMLElement).classList.contains('has-color-panel')).toBe(false)
    expect(wideImage.style.transform).toBe('translate(-50%, -50%) translate(0px, 0px) scale(0.276)')
    wide.app.unmount()

    const tall = mountViewer()
    await flushPromises()
    const tallStage = tall.root.querySelector('.media-viewer-stage') as HTMLElement
    stageSize(tallStage, 1200, 800)
    const tallImage = tall.root.querySelector('.media-viewer-image') as HTMLImageElement
    Object.defineProperty(tallImage, 'naturalWidth', { configurable: true, value: 32 })
    Object.defineProperty(tallImage, 'naturalHeight', { configurable: true, value: 4000 })
    tallImage.dispatchEvent(new Event('load'))
    await nextTick()

    expect(tallImage.style.transform).toBe('translate(-50%, -50%) translate(0px, 0px) scale(0.176)')
    tall.app.unmount()
  })

  it('switches with arrow keys and loops at directory boundaries', async () => {
    const { app, root } = mountViewer()
    await loadImage(root)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await flushPromises()
    expect(root.textContent).toContain('b.png')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await flushPromises()
    expect(root.textContent).toContain('a.png')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await flushPromises()
    expect(root.textContent).toContain('clip.mp4')
    expect(root.querySelector('video')).not.toBeNull()

    app.unmount()
  })

  it('copies image PNG data, the original file, and the full path', async () => {
    const { app, root } = mountViewer()
    await loadImage(root)

    ;(root.querySelector('[title^="复制图片为 PNG"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.drawImage).toHaveBeenCalled()
    expect(mocks.clipboardWrite).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('已复制图片为 PNG')

    ;(root.querySelector('[title="复制原文件到 Windows 剪贴板"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.copyFilesToClipboard).toHaveBeenCalledWith(['D:/Media/a.png'])

    ;(root.querySelector('[title="复制完整路径"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('D:/Media/a.png')

    app.unmount()
  })

  it('uses Ctrl+C for PNG copy and shows clipboard failures clearly', async () => {
    const { app, root } = mountViewer()
    await loadImage(root)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }))
    await flushPromises()
    expect(mocks.clipboardWrite).toHaveBeenCalledOnce()

    mocks.clipboardWrite.mockRejectedValueOnce(new Error('clipboard denied'))
    ;(root.querySelector('[title^="复制图片为 PNG"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(root.textContent).toContain('复制图片失败：clipboard denied')

    app.unmount()
  })

  it('switches editable raster images to a 1px canvas brush and fills continuous strokes', async () => {
    const { app, root } = mountViewer()
    const canvas = await enterEditMode(root)
    canvasBounds(canvas, 32, 16)

    canvas.dispatchEvent(pointerEvent('pointerdown', { button: 0, pointerId: 4, clientX: 1, clientY: 2 }))
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 4, clientX: 5, clientY: 2 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 4, clientX: 5, clientY: 2 }))
    await nextTick()

    expect(mocks.fillRect).toHaveBeenCalledWith(1, 2, 1, 1)
    expect(mocks.fillRect).toHaveBeenCalledWith(5, 2, 1, 1)
    expect((root.querySelector('[aria-label="画笔像素"]') as HTMLInputElement).value).toBe('1')
    expect(root.textContent).toContain('未保存')

    ;(root.querySelector('[title="查看模式"]') as HTMLButtonElement).click()
    await nextTick()
    expect(root.querySelector('.media-viewer-canvas')).not.toBeNull()
    ;(root.querySelector('[title="编辑模式"]') as HTMLButtonElement).click()
    await nextTick()
    expect(root.querySelector('.media-viewer-stage')?.classList.contains('editing')).toBe(true)

    app.unmount()
  })

  it('keeps the brush target color when left-clicking an RGBA replacement source and crops without scaling', async () => {
    mocks.getImageData.mockImplementation((_x: number, _y: number, width: number, height: number) => ({
      data: width === 1 && height === 1
        ? new Uint8ClampedArray([17, 34, 51, 68])
        : new Uint8ClampedArray([17, 34, 51, 68]),
    }))
    const { app, root } = mountViewer()
    const canvas = await enterEditMode(root)
    canvasBounds(canvas, 32, 16)

    ;(root.querySelector('[aria-label="从图片取色"]') as HTMLButtonElement).click()
    canvas.dispatchEvent(pointerEvent('pointerdown', { button: 0, pointerId: 7, clientX: 2, clientY: 3 }))
    await nextTick()
    expect((root.querySelector('[aria-label="被替换颜色"]') as HTMLInputElement).value).toBe('#112233')
    expect((root.querySelector('[aria-label="替换为颜色"]') as HTMLInputElement).value).toBe('#000000')

    const width = root.querySelector('[aria-label="裁剪宽度"]') as HTMLInputElement
    width.value = '10'
    width.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect((root.querySelector('[aria-label="裁剪高度"]') as HTMLInputElement).value).toBe('16')
    ;(root.querySelector('[title="裁剪为选定尺寸"]') as HTMLButtonElement).click()
    await nextTick()

    expect(canvas.width).toBe(10)
    expect(canvas.height).toBe(16)
    expect(mocks.drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement), 0, 0, 10, 16, 0, 0, 10, 16,
    )

    app.unmount()
  })

  it('uses image-local coordinates for precise eyedropper sampling on a transformed canvas', async () => {
    const { app, root } = mountViewer()
    const canvas = await enterEditMode(root, 2048, 2048)
    canvasBounds(canvas, 16384, 16384)
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 2048 })
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 2048 })

    ;(root.querySelector('[aria-label="从图片取色"]') as HTMLButtonElement).click()
    canvas.dispatchEvent(pointerEvent('pointerdown', {
      button: 0,
      pointerId: 17,
      clientX: 16380,
      clientY: 16380,
      offsetX: 317.875,
      offsetY: 911.125,
    }))
    await nextTick()

    expect(mocks.getImageData).toHaveBeenLastCalledWith(317, 911, 1, 1)

    app.unmount()
  })

  it('draws the Aseprite checkerboard in source pixels and shows the current brush preview', async () => {
    const { app, root } = mountViewer()
    const canvas = await enterEditMode(root)
    canvasBounds(canvas, 32, 16)

    canvas.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 4, clientY: 5 }))
    await nextTick()

    expect(root.querySelector('.media-viewer-pixel-grid')).toBeNull()
    expect(root.querySelector('.media-viewer-canvas-wrap')?.classList.contains('editing')).toBe(true)
    const checkerboard = root.querySelector('.media-viewer-checkerboard') as HTMLCanvasElement
    expect(checkerboard.width).toBe(32)
    expect(checkerboard.height).toBe(16)
    expect(mocks.fillRect).toHaveBeenCalledWith(0, 0, 16, 16)
    expect(mocks.fillRect).toHaveBeenCalledWith(16, 0, 16, 16)
    const preview = root.querySelector('.media-viewer-brush-preview') as HTMLElement
    expect(preview).not.toBeNull()
    expect(preview.style.left).toBe('4px')
    expect(preview.style.top).toBe('5px')
    expect(preview.style.width).toBe('1px')
    expect(preview.style.height).toBe('1px')

    app.unmount()
  })

  it('uses the eyedropper right click for the replacement target and brush color', async () => {
    mocks.getImageData.mockImplementation((_x: number, _y: number, width: number, height: number) => ({
      data: width === 1 && height === 1
        ? new Uint8ClampedArray([68, 85, 102, 255])
        : new Uint8ClampedArray([0, 0, 0, 255]),
    }))
    const { app, root } = mountViewer()
    const canvas = await enterEditMode(root)
    canvasBounds(canvas, 32, 16)

    ;(root.querySelector('[aria-label="从图片取色"]') as HTMLButtonElement).click()
    canvas.dispatchEvent(pointerEvent('pointerdown', { button: 2, pointerId: 6, clientX: 3, clientY: 2 }))
    await nextTick()

    expect((root.querySelector('[aria-label="替换为颜色"]') as HTMLInputElement).value).toBe('#445566')
    canvas.dispatchEvent(pointerEvent('pointermove', { pointerId: 6, clientX: 3, clientY: 2 }))
    await nextTick()
    expect((root.querySelector('.media-viewer-brush-preview') as HTMLElement).style.background).toContain('68')

    app.unmount()
  })

  it('loads palette RGBA values and replaces matching pixels immediately', async () => {
    const imageData = { data: new Uint8ClampedArray([
      17, 34, 51, 255,
      18, 34, 51, 255,
      80, 90, 100, 120,
    ]) }
    mocks.getImageData.mockReturnValue(imageData)
    const { app, root } = mountViewer()
    await enterEditMode(root)

    expect(root.querySelectorAll('.media-viewer-palette-swatch')).toHaveLength(3)
    const source = root.querySelector('[aria-label="被替换颜色"]') as HTMLInputElement
    const target = root.querySelector('[aria-label="替换为颜色"]') as HTMLInputElement
    source.value = '#112233'
    source.dispatchEvent(new Event('input', { bubbles: true }))
    target.value = '#aabbcc'
    target.dispatchEvent(new Event('input', { bubbles: true }))
    ;(root.querySelector('[title="替换颜色"]') as HTMLButtonElement).click()
    await nextTick()
    expect(root.querySelector('[aria-label="颜色替换设置"]')).not.toBeNull()
    ;(Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === '应用替换') as HTMLButtonElement).click()
    await nextTick()

    expect(mocks.putImageData).toHaveBeenCalledWith(imageData, 0, 0)
    expect([...imageData.data]).toEqual([
      170, 187, 204, 255,
      170, 187, 204, 255,
      80, 90, 100, 120,
    ])
    expect(root.textContent).toContain('已替换 2 个像素')

    app.unmount()
  })

  it('shows full RGBA palette entries, copies them, and outlines selected color locations', async () => {
    const imageData = { data: new Uint8ClampedArray([
      17, 34, 51, 255,
      80, 90, 100, 120,
    ]) }
    mocks.getImageData.mockReturnValue(imageData)
    const { app, root } = mountViewer()
    await enterEditMode(root)

    expect(root.textContent).toContain('rgba(17, 34, 51, 255)')
    expect(root.textContent).toContain('rgba(80, 90, 100, 120)')
    ;(root.querySelector('[aria-label="复制 rgba(17, 34, 51, 255)"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('rgba(17, 34, 51, 255)')

    const source = root.querySelector('[aria-label="被替换颜色"]') as HTMLInputElement
    source.value = '#112233'
    source.dispatchEvent(new Event('input', { bubbles: true }))
    ;(root.querySelector('[aria-label="显示选中颜色出现的位置"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(root.querySelector('.media-viewer-selection-overlay')).not.toBeNull()
    expect(mocks.strokeRect).toHaveBeenCalledWith(0.05, 0.05, 0.9, 0.9)

    app.unmount()
  })

  it('saves PNG and JPEG edits with their required output formats', async () => {
    const png = mountViewer()
    await enterEditMode(png.root)
    ;(png.root.querySelector('[title="保存并覆盖原图片"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.toDataURL).toHaveBeenLastCalledWith('image/png')
    expect(mocks.saveImageDataUrl).toHaveBeenLastCalledWith('D:/Media/a.png', 'data:image/png;base64,AA==')
    png.app.unmount()

    mocks.saveImageDataUrl.mockClear()
    mocks.toDataURL.mockClear()
    const jpeg = mountViewer('D:/Media/photo.jpeg')
    await enterEditMode(jpeg.root)
    ;(jpeg.root.querySelector('[title="保存并覆盖原图片"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.toDataURL).toHaveBeenLastCalledWith('image/jpeg', 0.92)
    expect(mocks.saveImageDataUrl).toHaveBeenLastCalledWith('D:/Media/photo.jpeg', 'data:image/png;base64,AA==')
    jpeg.app.unmount()
  })

  it('exports unsupported raster formats as PNG and offers its Explorer location', async () => {
    mocks.pickPngExportPath.mockResolvedValueOnce('D:/Media/texture-edited.png')
    mocks.saveImageDataUrl.mockResolvedValueOnce('D:/Media/texture-edited.png')
    const { app, root } = mountViewer('D:/Media/texture.webp')
    await enterEditMode(root)

    expect(root.querySelector('[title="保存并覆盖原图片"]')).toBeNull()
    ;(root.querySelector('[title="导出 PNG"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.saveImageDataUrl).toHaveBeenCalledWith('D:/Media/texture-edited.png', 'data:image/png;base64,AA==')
    expect(root.textContent).toContain('已导出，立即打开所在位置？')
    ;(root.querySelector('[title="打开位置"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.openPath).toHaveBeenCalledWith('D:/Media/texture-edited.png')

    app.unmount()
  })

  it('leaves the image dirty when PNG export is cancelled', async () => {
    mocks.pickPngExportPath.mockResolvedValueOnce(null)
    const { app, root } = mountViewer('D:/Media/texture.webp')
    const canvas = await enterEditMode(root)
    canvasBounds(canvas, 32, 16)
    canvas.dispatchEvent(pointerEvent('pointerdown', { button: 0, pointerId: 8, clientX: 1, clientY: 1 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 8, clientX: 1, clientY: 1 }))
    await nextTick()

    ;(root.querySelector('[title="导出 PNG"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.saveImageDataUrl).not.toHaveBeenCalled()
    expect(root.textContent).toContain('未保存')
    expect(root.textContent).not.toContain('已导出，立即打开所在位置？')

    app.unmount()
  })

  it('keeps dirty images in place until navigation or close is confirmed', async () => {
    const closeApproved = vi.fn()
    const { app, root } = mountViewer('D:/Media/a.png', closeApproved)
    const canvas = await enterEditMode(root)
    canvasBounds(canvas, 32, 16)
    canvas.dispatchEvent(pointerEvent('pointerdown', { button: 0, pointerId: 9, clientX: 1, clientY: 1 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, clientX: 1, clientY: 1 }))
    await nextTick()

    ;(root.querySelector('[aria-label="下一个媒体"]') as HTMLButtonElement).click()
    await nextTick()
    expect(root.textContent).toContain('图片有未保存修改。继续前是否保存？')
    buttonWithText(root, '取消').click()
    await nextTick()
    expect(root.textContent).toContain('a.png')

    ;(root.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click()
    await nextTick()
    expect(closeApproved).not.toHaveBeenCalled()
    buttonWithText(root, '不保存').click()
    await flushPromises()
    expect(closeApproved).toHaveBeenCalledOnce()

    app.unmount()
  })

  it('reports video metadata and copies the current video frame', async () => {
    const { app, root } = mountViewer('D:/Media/clip.mp4')
    await flushPromises()
    const video = root.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 })
    video.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()

    ;(root.querySelector('[title^="复制当前视频画面"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(mocks.drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080)
    expect(mocks.clipboardWrite).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('已复制当前画面为 PNG')

    app.unmount()
  })

  it('configures and controls the current native viewer window', async () => {
    mocks.isTauri.mockReturnValue(true)
    const closeApproved = vi.fn()
    const { app, root } = mountViewer('D:/Media/a.png', closeApproved)
    await loadImage(root)

    expect(mocks.currentWindow.setMinSize).toHaveBeenCalledWith(expect.objectContaining({ width: 760, height: 520 }))
    expect(mocks.currentWindow.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 1100, height: 760 }))
    expect(mocks.currentWindow.center).toHaveBeenCalledOnce()

    root.querySelector('.media-viewer-titlebar')?.dispatchEvent(pointerEvent('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 12,
      clientY: 12,
    }))
    expect(mocks.currentWindow.startDragging).toHaveBeenCalledOnce()

    ;(root.querySelector('[aria-label="关闭"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(closeApproved).toHaveBeenCalledOnce()
    expect(mocks.currentWindow.close).not.toHaveBeenCalled()

    app.unmount()
  })

  it('makes the native window fullscreen while keeping the viewer controls', async () => {
    mocks.isTauri.mockReturnValue(true)
    const { app, root } = mountViewer('D:/Media/clip.mp4')
    await flushPromises()

    ;(root.querySelector('[aria-label="全屏"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.currentWindow.setFullscreen).toHaveBeenCalledWith(true)
    expect(root.querySelector('.media-viewer')?.classList.contains('is-window-fullscreen')).toBe(true)
    expect(root.querySelector('.media-viewer-titlebar')).not.toBeNull()
    expect(root.querySelector('.media-viewer-toolbar')).not.toBeNull()
    expect(root.querySelectorAll('.media-viewer-side-control')).toHaveLength(2)

    app.unmount()
  })
})
