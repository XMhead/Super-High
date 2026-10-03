import { describe, expect, it } from 'vitest'
import { defaultTheme, themeToCssVariables } from './theme'

describe('themeToCssVariables', () => {
  it('maps shared tokens into css variable names used by the app shell', () => {
    const vars = themeToCssVariables(defaultTheme)

    expect(vars['--color-bg-primary']).toBe('#0D1117')
    expect(vars['--color-bg-secondary']).toBe('#161B22')
    expect(vars['--color-bg-hover']).toBe('#30363D')
    expect(vars['--color-accent-blue']).toBe('#58A6FF')
    expect(vars['--color-input-bg']).toBe('#161B22')
  })
})
