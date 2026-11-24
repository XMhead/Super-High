import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BUILTIN_FONT_ASSETS,
  BUILTIN_FONT_STYLES,
  fontStyleCssVariables,
  getFontStyle,
  embeddedFontFaceCss,
  inferFontRole,
  registerCustomFontStyles,
  registerCustomFonts,
} from './fontStyles'

describe('font styles', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('embeds selected font files for opaque iframe origins and reuses loaded resources', async () => {
    const fetchFont = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['font'], { type: 'font/woff2' }) }))
    vi.stubGlobal('fetch', fetchFont)
    const css = await embeddedFontFaceCss('anthropic')
    expect(fetchFont).toHaveBeenCalledTimes(9)
    expect(css.match(/@font-face/g)).toHaveLength(10)
    expect(css.match(/data:font\/woff2;base64,/g)).toHaveLength(10)
    expect(css).toContain("font-family:'Anthropic Mono'")
    expect(css).toContain("font-family:'Latin Modern Math'")
    expect(css).toMatch(/font-family:'Anthropic Serif'[^}]+format\('truetype'\);font-style:italic;font-weight:300 800/)
    expect(css).toMatch(/font-family:'Anthropic Chat Sans'[^}]+font-style:normal/)
    expect(css).toMatch(/font-family:'Anthropic Serif Android'[^}]+font-style:normal/)
    expect(css).toMatch(/font-family:'JetBrains Mono'[^}]+font-weight:100 800/)
    expect(await embeddedFontFaceCss('anthropic')).toBe(css)
    expect(fetchFont).toHaveBeenCalledTimes(9)
  })

  it('keeps imported data fonts without fetching unrelated built-in faces', async () => {
    const fetchFont = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['font'], { type: 'font/otf' }) }))
    vi.stubGlobal('fetch', fetchFont)
    const css = await embeddedFontFaceCss('imported', [
      { id: 'font-custom', name: 'Imported', family: 'Imported', format: 'woff2', source: 'data:font/woff2;base64,AQ==' },
    ], [{ id: 'imported', name: 'Imported', roles: { ui: 'font-custom', content: 'font-custom', mono: 'font-custom' } }])
    expect(css.match(/@font-face/g)).toHaveLength(2)
    expect(css).toContain('data:font/woff2;base64,AQ==')
    expect(css).toContain("font-family:'Latin Modern Math'")
    expect(css).not.toContain('Anthropic')
  })

  it('ships the Anthropic style with role-specific assets', () => {
    const style = getFontStyle('anthropic')
    expect(style).toEqual(BUILTIN_FONT_STYLES[0])
    expect(Object.values(style.roles)).toEqual(['anthropic-sans', 'anthropic-serif', 'anthropic-mono'])
    expect(BUILTIN_FONT_ASSETS).toHaveLength(3)
    const variables = fontStyleCssVariables('anthropic')
    expect(variables['--font-ui']).toMatch(/^'Anthropic Sans', 'Anthropic Chat Sans', /)
    expect(variables['--font-chat-user']).toContain("'Anthropic Chat Sans'")
    expect(variables['--font-content']).toMatch(/^'Anthropic Serif', 'Anthropic Serif Android', "Songti SC"/)
    expect(variables['--font-mono']).toMatch(/^'Anthropic Mono', 'JetBrains Mono', /)
    expect(variables['--font-math']).toContain("'Latin Modern Math'")
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
