import { describe, expect, it } from 'vitest'

import { buildColorCodePreviewRanges, colorCodePreviewClassName } from './colorCodePreview'

describe('buildColorCodePreviewRanges', () => {
  it('colors rgba literals', () => {
    expect(buildColorCodePreviewRanges('前景 rgba(255, 0, 128, 0.5) 后续')).toEqual([
      { lineNumber: 1, startColumn: 4, endColumn: 26, color: 'rgba(255, 0, 128, 0.5)' },
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
