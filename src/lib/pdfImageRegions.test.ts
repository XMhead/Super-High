import { describe, expect, it, vi } from 'vitest'
// Geometry does not require a worker or Canvas implementation in jsdom.
vi.mock('pdfjs-dist', () => ({ OPS: {
  save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  beginGroup: 76, endGroup: 77, paintImageXObject: 85, paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
} }))
import { OPS } from 'pdfjs-dist'
import { boundedPdfScale, pdfImageRegions } from './pdfImageRegions'

describe('PDF image viewing', () => {
  const viewport = { transform: [1, 0, 0, -1, 0, 800], width: 600, height: 800 }
  it('maps nested image transforms into screen coordinates and restores the parent state', () => {
    const regions = pdfImageRegions({
      fnArray: [OPS.save, OPS.transform, OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.restore, OPS.transform, OPS.paintInlineImageXObject],
      argsArray: [[], [2, 0, 0, 2, 10, 20], [[1, 0, 0, 1, 5, 10], null], [100, 0, 0, 50, 0, 0], ['picture'], [], [], [20, 0, 0, 30, 300, 100], [{ width: 200, height: 300 }]],
    }, viewport, () => ({ width: 1200, height: 600 }))
    expect(regions).toEqual([
      { x: 20, y: 660, width: 200, height: 100, pixelWidth: 1200, pixelHeight: 600 },
      { x: 300, y: 670, width: 20, height: 30, pixelWidth: 200, pixelHeight: 300 },
    ])
  })
  it('handles rotated pages, repeated images, and image groups', () => {
    const regions = pdfImageRegions({
      fnArray: [OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup],
      argsArray: [['image', 100, 40, [10, 20, 120, 30]], [{}, [{ transform: [40, 0, 0, 20, 300, 200], x: 0, y: 0, w: 400, h: 200 }]]],
    }, { transform: [0, 1, 1, 0, 0, 0], width: 800, height: 600 }, () => ({ width: 1000, height: 400 }))
    expect(regions.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 20, y: 10, width: 40, height: 100 },
      { x: 30, y: 120, width: 40, height: 100 },
      { x: 200, y: 300, width: 20, height: 40 },
    ])
  })
  it('clips off-page image bounds while ignoring images outside the page', () => {
    const regions = pdfImageRegions({ fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.transform, OPS.paintImageXObject],
      argsArray: [[], [100, 0, 0, 100, -50, -50], ['partial'], [], [100, 0, 0, 100, -200, 0], ['outside']] }, viewport, () => undefined)
    expect(regions).toEqual([{ x: 0, y: 750, width: 50, height: 50, pixelWidth: 0, pixelHeight: 0 }])
  })
  it('keeps normal high-DPI rendering sharp and bounds oversized canvases', () => {
    expect(boundedPdfScale(612, 792, 4 * 2)).toBe(8)
    const scale = boundedPdfScale(20_000, 10_000, 8)
    expect(20_000 * scale).toBeLessThanOrEqual(16384)
    expect(20_000 * 10_000 * scale ** 2).toBeLessThanOrEqual(64_000_001)
  })
})
