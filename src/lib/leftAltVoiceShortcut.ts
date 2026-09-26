export interface LeftAltKeyEvent {
  code: string
  ctrlKey?: boolean
  metaKey?: boolean
  repeat?: boolean
  shiftKey?: boolean
}

export interface LeftAltVoiceShortcutTracker {
  keydown: (event: LeftAltKeyEvent) => void
  keyup: (event: LeftAltKeyEvent) => boolean
  reset: () => void
}

function hasNonAltModifier(event: LeftAltKeyEvent): boolean {
  return !!(event.ctrlKey || event.metaKey || event.shiftKey)
}

export function createLeftAltVoiceShortcutTracker(): LeftAltVoiceShortcutTracker {
  let leftAltDown = false
  let leftAltAlone = false

  return {
    keydown(event) {
      if (event.code === 'AltLeft') {
        if (event.repeat) return
        leftAltDown = true
        leftAltAlone = !hasNonAltModifier(event)
        return
      }

      if (leftAltDown) leftAltAlone = false
    },

    keyup(event) {
      if (event.code !== 'AltLeft') {
        if (leftAltDown) leftAltAlone = false
        return false
      }

      const shouldTrigger = leftAltDown && leftAltAlone && !hasNonAltModifier(event)
      leftAltDown = false
      leftAltAlone = false
      return shouldTrigger
    },

    reset() {
      leftAltDown = false
      leftAltAlone = false
    },
  }
}
