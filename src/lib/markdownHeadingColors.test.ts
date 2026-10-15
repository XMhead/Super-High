import { describe, expect, it } from 'vitest'
import { DEFAULT_MARKDOWN_HEADING_COLORS, joinHeadingColor, normalizeHeadingColor, normalizeMarkdownHeadingColors, splitHeadingColor } from './markdownHeadingColors'

describe('markdown heading colors', () => {
  it('normalizes hex and rgba input to #RRGGBBAA', () => {
    expect(normalizeHeadingColor('#abc')).toBe('#AABBCCFF')
    expect(normalizeHeadingColor('rgba(229, 83, 75, 0.5)')).toBe('#E5534B80')
    expect(normalizeHeadingColor('rgb(0 0 0 / 50%)')).toBe('#00000080')
    for (const bad of ['red', '#12345', 'rgba(256,0,0,1)', 'rgba(0,0,0,2)', 7]) expect(normalizeHeadingColor(bad)).toBeNull()
  })

  it('fills missing or invalid levels with defaults', () => {
    const colors = normalizeMarkdownHeadingColors({ h2: '#00000080', h3: 'bad' })
    expect(colors.h2).toBe('#00000080')
    expect(colors.h3).toBe(DEFAULT_MARKDOWN_HEADING_COLORS.h3)
    expect(normalizeMarkdownHeadingColors(undefined)).toEqual(DEFAULT_MARKDOWN_HEADING_COLORS)
  })

  it('round-trips the picker color and alpha percentage', () => {
    expect(splitHeadingColor('#E5534B80')).toEqual({ rgb: '#E5534B', alphaPercent: 50 })
    expect(joinHeadingColor('#e5534b', 50)).toBe('#E5534B80')
    expect(joinHeadingColor('#e5534b', 150)).toBe('#E5534BFF')
  })
})
