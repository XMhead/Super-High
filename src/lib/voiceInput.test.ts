import { createApp, defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceInput } from './voiceInput'

const mocks = vi.hoisted(() => ({
  closeSystemVoiceInput: vi.fn(),
  isTauriValue: true,
  openSystemVoiceInput: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    closeSystemVoiceInput: mocks.closeSystemVoiceInput,
    openSystemVoiceInput: mocks.openSystemVoiceInput,
  },
  isTauri: () => mocks.isTauriValue,
}))

function mountVoiceInput() {
  const mounted: { api?: ReturnType<typeof useVoiceInput> } = {}
  const appendText = vi.fn()
  const focusInput = vi.fn()
  const root = document.createElement('div')
  const app = createApp(defineComponent({
    setup() {
      mounted.api = useVoiceInput({ appendText, focusInput })
      return () => h('div')
    },
  }))

  app.mount(root)
  if (!mounted.api) throw new Error('voice input composable did not mount')

  return {
    api: mounted.api,
    app,
    appendText,
    focusInput,
  }
}

describe('voice input', () => {
  beforeEach(() => {
    mocks.closeSystemVoiceInput.mockReset()
    mocks.openSystemVoiceInput.mockReset()
    mocks.closeSystemVoiceInput.mockResolvedValue(undefined)
    mocks.openSystemVoiceInput.mockResolvedValue(undefined)
    mocks.isTauriValue = true
  })

  it('toggles Windows system voice input on and off in Tauri mode', async () => {
    const { api, app, focusInput } = mountVoiceInput()

    await api.toggleVoiceInput()

    expect(focusInput).toHaveBeenCalledTimes(1)
    expect(mocks.openSystemVoiceInput).toHaveBeenCalledTimes(1)
    expect(api.voiceInputState.value).toBe('listening')

    await api.toggleVoiceInput()

    expect(mocks.closeSystemVoiceInput).toHaveBeenCalledTimes(1)
    expect(api.voiceInputState.value).toBe('idle')

    app.unmount()
  })

  it('closes system voice input when unmounted while listening', async () => {
    const { api, app } = mountVoiceInput()

    await api.toggleVoiceInput()
    app.unmount()

    expect(mocks.closeSystemVoiceInput).toHaveBeenCalledTimes(1)
  })
})
