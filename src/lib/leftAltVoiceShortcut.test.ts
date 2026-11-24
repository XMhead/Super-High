import { describe, expect, it } from 'vitest'

import { createLeftAltVoiceShortcutTracker } from './leftAltVoiceShortcut'

describe('left Alt voice shortcut tracker', () => {
  it('triggers when left Alt is pressed and released alone', () => {
    const tracker = createLeftAltVoiceShortcutTracker()

    tracker.keydown({ code: 'AltLeft' })

    expect(tracker.keyup({ code: 'AltLeft' })).toBe(true)
  })

  it('ignores right Alt and repeated left Alt keydown events', () => {
    const tracker = createLeftAltVoiceShortcutTracker()

    tracker.keydown({ code: 'AltRight' })
    expect(tracker.keyup({ code: 'AltRight' })).toBe(false)

    tracker.keydown({ code: 'AltLeft' })
    tracker.keydown({ code: 'AltLeft', repeat: true })
    expect(tracker.keyup({ code: 'AltLeft' })).toBe(true)
  })

  it('does not trigger when left Alt is combined with another key', () => {
    const tracker = createLeftAltVoiceShortcutTracker()

    tracker.keydown({ code: 'AltLeft' })
    tracker.keydown({ code: 'Tab' })

    expect(tracker.keyup({ code: 'AltLeft' })).toBe(false)
  })

  it('does not trigger when left Alt has another modifier', () => {
    const tracker = createLeftAltVoiceShortcutTracker()

    tracker.keydown({ code: 'AltLeft', shiftKey: true })

    expect(tracker.keyup({ code: 'AltLeft', shiftKey: true })).toBe(false)
  })
})
