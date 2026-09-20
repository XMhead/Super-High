import { describe, expect, it } from 'vitest'

import { buildColorCodePreviewRanges, colorCodePreviewClassName } from './colorCodePreview'

describe('buildColorCodePreviewRanges', () => {
  it('colors legacy ampersand and section-sign tokens', () => {
    expect(buildColorCodePreviewRanges('&7 gray §c red')).toEqual([
      { lineNumber: 1, startColumn: 1, endColumn: 9, color: '#AAAAAA' },
      { lineNumber: 1, startColumn: 9, endColumn: 15, color: '#FF5555' },
    ])
  })

  it('colors section-sign hex tokens like 颜色.txt', () => {
    expect(buildColorCodePreviewRanges('&7 §#d3d3d3  §7')).toEqual([
      { lineNumber: 1, startColumn: 1, endColumn: 4, color: '#AAAAAA' },
      { lineNumber: 1, startColumn: 4, endColumn: 14, color: '#D3D3D3' },
      { lineNumber: 1, startColumn: 14, endColumn: 16, color: '#AAAAAA' },
    ])
  })

  it('supports Minecraft split hex codes and reset codes', () => {
    expect(buildColorCodePreviewRanges('§x§d§3§d§3§d§3hex §rnormal')).toEqual([
      { lineNumber: 1, startColumn: 1, endColumn: 19, color: '#D3D3D3' },
    ])
  })

  it('colors rgba literals without changing the active Minecraft color', () => {
    expect(buildColorCodePreviewRanges('&a前景 rgba(255, 0, 128, 0.5) 后续')).toEqual([
      { lineNumber: 1, startColumn: 1, endColumn: 6, color: '#55FF55' },
      { lineNumber: 1, startColumn: 6, endColumn: 28, color: 'rgba(255, 0, 128, 0.5)' },
      { lineNumber: 1, startColumn: 28, endColumn: 31, color: '#55FF55' },
    ])
  })
})

describe('colorCodePreviewClassName', () => {
  it('uses a stable class name for Monaco decorations', () => {
    expect(colorCodePreviewClassName('#D3D3D3')).toBe('color-code-preview-d3d3d3')
  })

  it('uses a stable class name for rgba decorations', () => {
    expect(colorCodePreviewClassName('rgba(255, 0, 128, 0.5)')).toBe('color-code-preview-rgba-255-0-128-0-5')
  })
})
