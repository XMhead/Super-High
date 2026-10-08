import { describe, expect, it } from 'vitest'

import {
  BUILTIN_FONT_ASSETS,
  BUILTIN_FONT_STYLES,
  getFontStyle,
  inferFontRole,
  registerCustomFontStyles,
  registerCustomFonts,
} from './fontStyles'

describe('font styles', () => {
  it('ships the Anthropic style with role-specific assets', () => {
    const style = getFontStyle('anthropic')
    expect(style).toEqual(BUILTIN_FONT_STYLES[0])
    expect(Object.values(style.roles)).toEqual(['anthropic-sans', 'anthropic-serif', 'anthropic-mono'])
    expect(BUILTIN_FONT_ASSETS).toHaveLength(3)
  })

  it('infers roles without requiring three files', () => {
    expect(inferFontRole('MyConsole.woff2')).toBe('mono')
    expect(inferFontRole('EditorialSerif.ttf')).toBe('content')
    expect(inferFontRole('Readable.woff2')).toBe('ui')
  })

  it('keeps only valid imported assets and role references', () => {
    const fonts = registerCustomFonts([
      { id: 'font-a', name: 'A', family: 'SuperHigh A', source: 'data:font/woff2;base64,AA==', format: 'woff2' },
      { id: 'font-a', name: 'duplicate', family: 'Duplicate', source: 'data:font/woff2;base64,AA==', format: 'woff2' },
    ])
    const styles = registerCustomFontStyles([
      { id: 'style-a', name: 'A 风格', roles: { ui: 'font-a', mono: 'missing' } },
      { id: 'anthropic', name: '覆盖内置', roles: { ui: 'font-a' } },
    ], fonts)
    expect(fonts).toHaveLength(1)
    expect(styles).toEqual([{ id: 'style-a', name: 'A 风格', roles: { ui: 'font-a' } }])
  })
})
