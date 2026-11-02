import { OPS } from 'pdfjs-dist'

type Matrix = [number, number, number, number, number, number]
export interface PdfImageRegion { x: number; y: number; width: number; height: number; pixelWidth: number; pixelHeight: number }

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
}

// Bounds are expressed in the scale-1 viewport, including the page's rotation.
export function pdfImageRegions(
  operations: { fnArray: number[]; argsArray: any[][] },
  viewport: { transform: number[]; width: number; height: number },
  imageSize: (id: string) => { width: number; height: number } | undefined,
): PdfImageRegion[] {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  const regions: PdfImageRegion[] = []
  function add(transform: Matrix, size?: { width: number; height: number }) {
    const m = multiply(viewport.transform as Matrix, transform)
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]]
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]]
    const x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys))
    const width = Math.min(viewport.width, Math.max(...xs)) - x
    const height = Math.min(viewport.height, Math.max(...ys)) - y
    if (width > 4 && height > 4) regions.push({ x, y, width, height, pixelWidth: size?.width ?? 0, pixelHeight: size?.height ?? 0 })
  }
  for (let i = 0; i < operations.fnArray.length; i++) {
    const op = operations.fnArray[i], args = operations.argsArray[i]
    // beginGroup.matrix transforms its clipping bounds only: PDF.js draws the
    // group content using the pre-group transform (CanvasGraphics.beginGroup).
    if (op === OPS.save || op === OPS.beginGroup) stack.push([...matrix])
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd || op === OPS.endGroup) matrix = stack.pop() ?? matrix
    else if (op === OPS.transform) matrix = multiply(matrix, args as Matrix)
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push([...matrix])
      if (args[0]) matrix = multiply(matrix, args[0])
    } else if (op === OPS.paintImageXObject) add(matrix, imageSize(args[0]))
    else if (op === OPS.paintInlineImageXObject) add(matrix, args[0])
    else if (op === OPS.paintImageXObjectRepeat) {
      const [id, scaleX, scaleY, positions] = args
      for (let j = 0; j < positions.length; j += 2) add(multiply(matrix, [scaleX, 0, 0, scaleY, positions[j], positions[j + 1]]), imageSize(id))
    } else if (op === OPS.paintInlineImageXObjectGroup) {
      for (const entry of args[1]) add(multiply(matrix, entry.transform), { width: entry.w, height: entry.h })
    }
  }
  // Smaller pictures stay clickable when a scanned background covers the page.
  return regions.sort((a, b) => b.width * b.height - a.width * a.height)
}

export function boundedPdfScale(width: number, height: number, requested: number, maxPixels = 64_000_000) {
  return Math.min(requested, 16384 / width, 16384 / height, Math.sqrt(maxPixels / (width * height)))
}
