import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE,
  HTML_PREVIEW_LONG_PRESS_MS,
  buildHtmlPreviewLongPressScript,
  isHtmlPreviewLongPressMessage,
  sendHtmlPreviewPathToChat,
} from './htmlPreviewLongPress'

function pointer(type: string, x = 0, y = 0) {
  return Object.assign(new Event(type, { bubbles: true }), { button: 0, isPrimary: true, clientX: x, clientY: y })
}

describe('HTML preview long press', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('posts once after holding still and swallows the following click', () => {
    vi.useFakeTimers()
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    new Function(buildHtmlPreviewLongPressScript())()

    document.body.dispatchEvent(pointer('pointerdown'))
    document.body.dispatchEvent(pointer('pointermove', 3, 2))
    vi.advanceTimersByTime(HTML_PREVIEW_LONG_PRESS_MS)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith({ type: HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE }, '*')

    const onClick = vi.fn()
    document.body.addEventListener('click', onClick)
    document.body.dispatchEvent(pointer('pointerup'))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onClick).not.toHaveBeenCalled()

    // 移动超出容差或提前松开都不触发
    document.body.dispatchEvent(pointer('pointerdown'))
    document.body.dispatchEvent(pointer('pointermove', 20, 0))
    vi.advanceTimersByTime(HTML_PREVIEW_LONG_PRESS_MS)
    document.body.dispatchEvent(pointer('pointerdown'))
    document.body.dispatchEvent(pointer('pointerup'))
    vi.advanceTimersByTime(HTML_PREVIEW_LONG_PRESS_MS)
    expect(post).toHaveBeenCalledTimes(1)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('inserts only the forward-slash absolute path as plain text', () => {
    const listener = vi.fn()
    window.addEventListener('superhigh:add-selection-to-chat', listener)
    sendHtmlPreviewPathToChat('D:\\我的世界\\记录的地平线服务端\\plugins\\.superhigh\\editor\\player-actions.html')
    window.removeEventListener('superhigh:add-selection-to-chat', listener)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      text: 'D:/我的世界/记录的地平线服务端/plugins/.superhigh/editor/player-actions.html',
      insertMode: 'plain',
    })
    expect(isHtmlPreviewLongPressMessage({ type: HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE })).toBe(true)
    expect(isHtmlPreviewLongPressMessage({ type: 'other' })).toBe(false)
  })
})
