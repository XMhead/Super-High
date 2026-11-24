import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PresentationPreview from './PresentationPreview.vue'

const state = vi.hoisted(() => ({ instances: [] as any[], pending: null as Promise<void> | null, bytes: null as Uint8Array | null }))
vi.mock('@/lib/tauri', () => ({ backend: { openUrl: vi.fn() } }))
vi.mock('@aiden0z/pptx-renderer', () => ({
  RECOMMENDED_ZIP_LIMITS: { maxEntries: 4000 },
  parseZipLazyMedia: vi.fn(async bytes => { state.bytes = new Uint8Array(bytes); await state.pending; return { slides: new Map() } }),
  buildPresentation: () => ({ slides: Array.from({ length: 3 }, (_, index) => ({ slidePath: `slide${index}`, nodes: [] })) }),
  PptxViewer: class {
    slideCount = 3
    currentSlideIndex = 0
    slideWidth = 960
    slideHeight = 540
    presentationData: any = null
    container: HTMLElement
    options: any
    destroyed = false
    load = vi.fn(model => { this.presentationData = model })
    renderSlide = vi.fn(async () => {
      this.options.onSlideChange(0)
      this.container.textContent = '第一页中文内容'
      this.options.onSlideRendered?.(0, this.container)
    })
    goToSlide = vi.fn(async (index: number) => {
      this.currentSlideIndex = index
      this.options.onSlideChange(index)
      this.container.textContent = `第 ${index + 1} 页`
    })
    setFitMode = vi.fn(async () => {})
    setZoom = vi.fn(async () => {})
    destroy() { this.destroyed = true }
    constructor(container: HTMLElement, options: any) {
      this.container = container
      this.options = options
      state.instances.push(this)
    }
  },
}))

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  state.instances = []
  state.pending = null
})

function mount(content = 'UEs=') {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(PresentationPreview, { path: 'D:/example.pptx', content })
  app.mount(root)
  let mounted = true
  function unmount() { if (mounted) { app.unmount(); mounted = false } }
  disposers.push(() => { unmount(); root.remove() })
  return { root, unmount }
}

function button(root: HTMLElement, label: string) {
  return Array.from(root.querySelectorAll('button')).find(item => item.textContent === label)!
}

describe('built-in PowerPoint preview', () => {
  it('navigates, clamps page input, zooms and expands without an external application', async () => {
    const { root } = mount()
    await vi.waitFor(() => expect(root.querySelector('section')?.getAttribute('aria-busy')).toBe('false'))
    const instance = state.instances[0]
    expect(instance.options.externalMedia).toBe('block')
    expect(state.bytes).toEqual(new Uint8Array([0x50, 0x4b]))
    expect(button(root, '上一页').disabled).toBe(true)
    button(root, '下一页').click()
    await vi.waitFor(() => expect(root.querySelector('input')?.value).toBe('2'))
    const input = root.querySelector('input')!
    input.value = '99'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(input.value).toBe('3'))
    expect(button(root, '下一页').disabled).toBe(true)
    const select = root.querySelector('select')!
    select.value = '150'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(instance.setZoom).toHaveBeenCalledWith(150))
    expect(instance.setFitMode).toHaveBeenCalledWith('none')
    button(root, '展开阅读').click()
    await nextTick()
    expect(root.querySelector('.presentation-expanded')).toBeTruthy()
    const stage = root.querySelector('.presentation-stage')!
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await vi.waitFor(() => expect(input.value).toBe('2'))
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(root.querySelector('.presentation-expanded')).toBeNull()
  })

  it('explains the legacy binary format without launching a converter', async () => {
    const { root } = mount('0M8R4A==')
    await vi.waitFor(() => expect(root.querySelector('[role=alert]')?.textContent).toContain('旧版二进制 PPT'))
    expect(state.instances).toHaveLength(0)
    expect(root.textContent).toContain('另存为 .pptx')
  })

  it('aborts pending parsing and destroys the renderer when its tab closes', async () => {
    let finish!: () => void
    state.pending = new Promise(resolve => { finish = resolve })
    const { unmount } = mount()
    await vi.waitFor(() => expect(state.instances).toHaveLength(1))
    const instance = state.instances[0]
    unmount()
    expect(instance.destroyed).toBe(true)
    finish()
    await nextTick()
    expect(instance.renderSlide).not.toHaveBeenCalled()
  })
})
