import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdUiPreviewLayout } from './uiPreviewLayout'

afterEach(() => {
  vi.runAllTimers()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function mount(page = false) {
  vi.useFakeTimers()
  document.body.innerHTML = page
    ? '<div class="shui-scroll has-page"><div class="shui-page"><div class="shui-page-body"><div><button></button></div></div><div class="shui-page-footer">固定底栏</div></div></div>'
    : '<div class="shui-scroll"><div><button></button></div></div>'
  const trigger = document.querySelector('button')!
  const content = trigger.parentElement!
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ height: 1200 } as DOMRect)
  return { trigger, content }
}

describe('IUI preview layout', () => {
  it.each([false, true])('keeps scrollable content tall through image unload and restoration (Page: %s)', async (page) => {
    const { trigger, content } = mount(page)
    content.style.minHeight = '100px'
    const release = holdUiPreviewLayout(trigger)
    expect(content.style.minHeight).toBe('1200px')
    const pending = document.createElement('div')
    pending.className = 'shui-image-pending'
    content.append(pending)
    release()
    vi.advanceTimersByTime(0)
    expect(content.style.minHeight).toBe('1200px')
    const image = document.createElement('img')
    Object.defineProperty(image, 'complete', { value: false, configurable: true })
    pending.replaceWith(image)
    await Promise.resolve()
    expect(content.style.minHeight).toBe('1200px')
    Object.defineProperty(image, 'complete', { value: true })
    image.dispatchEvent(new Event('load'))
    expect(content.style.minHeight).toBe('100px')
    if (page) expect(document.querySelector<HTMLElement>('.shui-page-footer')!.style.minHeight).toBe('')
  })

  it('shares a floor across nested previews and cancels an old release when re-entering', () => {
    const { trigger, content } = mount()
    const outer = holdUiPreviewLayout(trigger)
    const inner = holdUiPreviewLayout(trigger)
    outer()
    outer()
    vi.advanceTimersByTime(0)
    expect(content.style.minHeight).toBe('1200px')
    inner()
    const again = holdUiPreviewLayout(trigger)
    vi.advanceTimersByTime(0)
    expect(content.style.minHeight).toBe('1200px')
    again()
    vi.advanceTimersByTime(0)
    expect(content.style.minHeight).toBe('')
  })

  it('releases the floor even when a resource never finishes', () => {
    const { trigger, content } = mount()
    const release = holdUiPreviewLayout(trigger)
    content.insertAdjacentHTML('beforeend', '<div class="shui-image-pending"></div>')
    release()
    vi.advanceTimersByTime(5000)
    expect(content.style.minHeight).toBe('')
  })
})
