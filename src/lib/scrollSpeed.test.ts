import { afterEach, describe, expect, it } from 'vitest'
import { installNativeScrollSpeed, normalizeScrollSpeed } from './scrollSpeed'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren() })

function scroller(parent: HTMLElement = document.body) {
  const element = document.createElement('div')
  element.style.overflowX = 'auto'
  element.style.overflowY = 'auto'
  element.style.lineHeight = '20px'
  Object.defineProperties(element, {
    scrollHeight: { value: 1000 }, clientHeight: { value: 200 },
    scrollWidth: { value: 1000 }, clientWidth: { value: 200 },
  })
  parent.append(element)
  return element
}
function wheel(element: HTMLElement, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ...options })
  element.dispatchEvent(event)
  return event
}

describe('scroll speed', () => {
  it('uses only supported steps and defaults old or invalid settings to 100%', () => {
    for (const value of [undefined, null, '250', 0, 110, 275, NaN]) expect(normalizeScrollSpeed(value)).toBe(100)
    for (const value of [100, 125, 150, 175, 200, 225, 250]) expect(normalizeScrollSpeed(value)).toBe(value)
  })

  it('keeps native behavior at 100% and applies live multipliers to nested scrolling', () => {
    let percent = 100
    disposers.push(installNativeScrollSpeed(() => percent))
    const outer = scroller()
    const inner = scroller(outer)
    expect(wheel(inner).defaultPrevented).toBe(false)
    percent = 250
    expect(wheel(inner).defaultPrevented).toBe(true)
    expect(inner.scrollTop).toBe(250)
    expect(outer.scrollTop).toBe(0)
    inner.scrollTop = 800
    wheel(inner, { deltaY: 40 })
    expect(outer.scrollTop).toBe(100)
    percent = 125
    wheel(inner, { deltaY: -40 })
    expect(inner.scrollTop).toBe(750)
  })

  it('handles line, page and Shift scrolling without changing zoom or editor consumers', () => {
    disposers.push(installNativeScrollSpeed(() => 150))
    const element = scroller()
    wheel(element, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(element.scrollTop).toBe(60)
    wheel(element, { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE })
    expect(element.scrollTop).toBe(360)
    wheel(element, { shiftKey: true, deltaY: 40 })
    expect(element.scrollLeft).toBe(60)
    expect(wheel(element, { ctrlKey: true }).defaultPrevented).toBe(false)
    for (const className of ['xterm', 'monaco-editor', 'image-preview-stage']) {
      element.className = className
      expect(wheel(element).defaultPrevented).toBe(false)
    }
  })
})
