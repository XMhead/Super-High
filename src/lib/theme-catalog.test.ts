import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THEME_ID,
  THEMES,
  buildTerminalTheme,
  buildSurfaceVars,
  getTheme,
  getThemeIds,
  registerCustomThemes,
  themeToCssVariables,
  toMonacoThemeDefinition,
} from './theme'

describe('theme catalog', () => {
  it('includes the retained built-in theme ids', () => {
    expect(Object.keys(THEMES)).toEqual(expect.arrayContaining([
      'dark',
      'light',
      'solarized-dark',
      'monokai',
      'tokyo-night',
      'catppuccin',
      'ayu-light',
      'solarized-light',
      'gruvbox',
    ]))
  })

  it('falls back to the default theme for unknown ids', () => {
    expect(getTheme('missing-theme').id).toBe(DEFAULT_THEME_ID)
  })

  it('builds terminal colors from the selected theme', () => {
    const theme = buildTerminalTheme('tokyo-night')

    expect(theme.background).toBe('#1A1B26')
    expect(theme.foreground).toBe('#A9B1D6')
    expect(theme.brightWhite).toBe('#ACB0D0')
  })

  it('creates a light monaco base for light themes', () => {
    const monacoTheme = toMonacoThemeDefinition('light')

    expect(monacoTheme.base).toBe('vs')
    expect(monacoTheme.colors['editor.background']).toBe('#FFFFFF')
  })

  it('uses the theme green accent for Monaco comments', () => {
    const monacoTheme = toMonacoThemeDefinition('dark')
    const commentRule = monacoTheme.rules.find((rule) => rule.token === 'comment')

    expect(commentRule?.foreground).toBe('3FB950')
  })

  it('styles YAML like classic light editors: navy keys, green comments, body-colored strings', () => {
    const darkTheme = toMonacoThemeDefinition('dark')
    const lightTheme = toMonacoThemeDefinition('light')

    expect(darkTheme.rules.find((r) => r.token === 'type.yaml')?.foreground).toBe('58A6FF')
    expect(darkTheme.rules.find((r) => r.token === 'comment.yaml')?.foreground).toBe('3FB950')
    expect(darkTheme.rules.find((r) => r.token === 'string.yaml')?.foreground).toBe('E6EDF3')

    expect(lightTheme.rules.find((r) => r.token === 'type.yaml')?.foreground).toBe('003366')
    expect(lightTheme.rules.find((r) => r.token === 'comment.yaml')?.foreground).toBe('1A7F37')
    expect(lightTheme.rules.find((r) => r.token === 'string.yaml')?.foreground).toBe('1F2328')
  })

  it('keeps Monaco invalid tokens from painting a bright error background', () => {
    const monacoTheme = toMonacoThemeDefinition('dark')
    const invalidRule = monacoTheme.rules.find((rule) => rule.token === 'invalid')
    const invalidStringRule = monacoTheme.rules.find((rule) => rule.token === 'string.invalid')

    expect(invalidRule?.background).toBe('0D1117')
    expect(invalidStringRule?.background).toBe('0D1117')
    expect(monacoTheme.colors['editorError.background']).toBe('#00000000')
    expect(monacoTheme.colors['editorBracketMatch.background']).toBe('#00000000')
    expect(monacoTheme.colors['editorOverviewRuler.errorForeground']).toBe('#00000000')
    expect(monacoTheme.colors['editorOverviewRuler.warningForeground']).toBe('#00000000')
    expect(monacoTheme.colors['editorBracketPairGuide.activeBackground1']).toBe('#484f58c7')
    // Monaco parses theme colors only as hex; invalid strings fall back to pure red.
    expect(monacoTheme.colors['editor.lineHighlightBackground']).toBe('#30363d4d')
  })

  it('uses non-danger colors for code preview selection and scrollbars', () => {
    for (const themeId of Object.keys(THEMES)) {
      const monacoTheme = toMonacoThemeDefinition(themeId)
      const dangerColor = THEMES[themeId].colors.accent.red.toLowerCase()
      const dangerRgb = hexToRgb(THEMES[themeId].colors.accent.red)
      const dangerRgbaPrefix = `rgba(${dangerRgb.join(', ')}`
      const previewChromeColors = [
        monacoTheme.colors['editor.selectionBackground'],
        monacoTheme.colors['editor.inactiveSelectionBackground'],
        monacoTheme.colors['selection.background'],
        monacoTheme.colors['scrollbarSlider.background'],
        monacoTheme.colors['scrollbarSlider.hoverBackground'],
        monacoTheme.colors['scrollbarSlider.activeBackground'],
      ]

      for (const color of previewChromeColors) {
        expect(color.toLowerCase()).not.toBe(dangerColor)
        expect(color).not.toContain(dangerRgbaPrefix)
      }
    }
  })

  it('derives overlay variables from the active theme instead of fixed dark rgba values', () => {
    const surfaceVars = buildSurfaceVars('light')

    expect(surfaceVars['--surface-app-backdrop']).not.toContain('13, 17, 23')
    expect(surfaceVars['--surface-shadow-rgb']).toBe('31 35 40')
  })

  it('accepts a user theme without changing source-defined themes', () => {
    const source = getTheme('glass-tokyo')
    const custom = registerCustomThemes([{ ...source, id: 'my-terminal-glass', name: '我的终端玻璃' }])

    expect(custom).toHaveLength(1)
    expect(getThemeIds()).toContain('my-terminal-glass')
    expect(getTheme('my-terminal-glass').name).toBe('我的终端玻璃')
    expect(buildSurfaceVars('my-terminal-glass')['--surface-panel']).toContain('rgba(')

    registerCustomThemes([])
  })

  it('applies glass opacity to the CSS background layers', () => {
    const vars = themeToCssVariables(getTheme('glass-tokyo'))

    expect(vars['--color-bg-primary']).toContain('rgba(')
    expect(vars['--color-bg-secondary']).toContain('rgba(')
  })

  it('keeps Glass editor and terminal canvases transparent', () => {
    const monacoTheme = toMonacoThemeDefinition('glass-tokyo')
    const terminalTheme = buildTerminalTheme('glass-tokyo')

    expect(monacoTheme.colors['editor.background']).toBe('#00000000')
    expect(monacoTheme.colors['editorGutter.background']).toBe('#00000000')
    expect(terminalTheme.background).toBe('#00000000')
  })
})

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
