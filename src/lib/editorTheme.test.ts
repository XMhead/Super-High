import { expect, it, vi } from 'vitest'
import { applyEditorTheme } from './editorTheme'
import type { Monaco } from './monaco'
import { getTheme, getThemeIds, registerCustomThemes } from './theme'

it('applies the global theme once across panes and updates it when the setting changes', () => {
  const defineTheme = vi.fn()
  const setTheme = vi.fn()
  const monaco = { editor: { defineTheme, setTheme } } as unknown as Monaco
  const [first, second] = getThemeIds()
  applyEditorTheme(monaco, first)
  applyEditorTheme(monaco, first)
  expect(defineTheme).toHaveBeenCalledOnce()
  expect(setTheme).toHaveBeenCalledOnce()
  applyEditorTheme(monaco, second)
  expect(defineTheme).toHaveBeenCalledTimes(2)
  applyEditorTheme(monaco, first)
  expect(defineTheme).toHaveBeenCalledTimes(3)
})


it('refreshes a custom theme when the registry replaces its tokens under the same id', () => {
  const defineTheme = vi.fn()
  const monaco = { editor: { defineTheme, setTheme: vi.fn() } } as unknown as Monaco
  const custom = { ...getTheme('dark'), id: 'custom-editor-test', name: 'Custom' }
  try {
    registerCustomThemes([custom])
    applyEditorTheme(monaco, custom.id)
    registerCustomThemes([{ ...custom, colors: { ...custom.colors, text: { ...custom.colors.text, primary: '#123456' } } }])
    applyEditorTheme(monaco, custom.id)
    expect(defineTheme).toHaveBeenCalledTimes(2)
    expect(defineTheme.mock.calls[1][1]).not.toEqual(defineTheme.mock.calls[0][1])
  } finally { registerCustomThemes([]) }
})
