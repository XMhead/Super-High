import { describe, expect, it } from 'vitest'
import { fittedTerminalFontSize } from './terminalLayout'

describe('mobile terminal width', () => {
  it('fits the actual shared column count rather than assuming 80 columns', () => {
    expect(fittedTerminalFontSize(14, 80, 120)).toBe(9.3)
    expect(fittedTerminalFontSize(14, 80, 160)).toBe(7)
  })
  it('shrinks a narrow terminal toward 80 columns instead of truncating CLI layouts', () => {
    expect(fittedTerminalFontSize(14, 42)).toBe(7.3)
    expect(fittedTerminalFontSize(14, 38)).toBe(6.6)
  })
  it('preserves the preferred size when it fits and bounds tiny viewports', () => {
    expect(fittedTerminalFontSize(12, 100)).toBe(12)
    expect(fittedTerminalFontSize(14, 20)).toBe(6)
  })
})
