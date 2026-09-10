export interface DragonRgba {
  r: number
  g: number
  b: number
  a: number
}

export interface DragonPixel {
  x: number
  y: number
  colorIndex: number
  color: DragonRgba
  lineNumber: number
}

export interface DragonImageDocument {
  width: number
  height: number
  colors: Record<number, DragonRgba>
  pixels: DragonPixel[]
}

export interface DragonImageIssue {
  lineNumber: number
  message: string
}

export class DragonImageParseError extends Error {
  issues: DragonImageIssue[]

  constructor(issues: DragonImageIssue[]) {
    super(issues[0]?.message ?? 'Dragon image config parse failed')
    this.name = 'DragonImageParseError'
    this.issues = issues
  }
}

type RawPixel = {
  x: number
  y: number
  colorIndex: number
  lineNumber: number
}

type CoordinateSpan = {
  start: number
  end: number
}

const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_777_216

const AMPERSAND_COLORS: Record<string, DragonRgba> = {
  '0': { r: 0, g: 0, b: 0, a: 255 },
  '1': { r: 0, g: 0, b: 170, a: 255 },
  '2': { r: 0, g: 170, b: 0, a: 255 },
  '3': { r: 0, g: 170, b: 170, a: 255 },
  '4': { r: 170, g: 0, b: 0, a: 255 },
  '5': { r: 170, g: 0, b: 170, a: 255 },
  '6': { r: 255, g: 170, b: 0, a: 255 },
  '7': { r: 170, g: 170, b: 170, a: 255 },
  '8': { r: 85, g: 85, b: 85, a: 255 },
  '9': { r: 85, g: 85, b: 255, a: 255 },
  a: { r: 85, g: 255, b: 85, a: 255 },
  b: { r: 85, g: 255, b: 255, a: 255 },
  c: { r: 255, g: 85, b: 85, a: 255 },
  d: { r: 255, g: 85, b: 255, a: 255 },
  e: { r: 255, g: 255, b: 85, a: 255 },
  f: { r: 255, g: 255, b: 255, a: 255 },
}

export function parseDragonImageConfig(source: string): DragonImageDocument {
  const configSource = extractDragonPixelSource(source)
  const issues: DragonImageIssue[] = []
  const colors: Record<number, DragonRgba> = {}
  const rawPixels: RawPixel[] = []
  let width: number | null = null
  let height: number | null = null

  const lines = configSource.split(/\r?\n/)
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = (lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine).trim()
    if (!line || line.startsWith('//') || line.startsWith(';')) return
    if (/^(colors|pixels)\s*:$/i.test(line)) return

    const widthMatch = line.match(/^width\s*[:=]\s*(\d+)\s*$/i)
    if (widthMatch) {
      width = parseDimension(widthMatch[1], 'width', lineNumber, issues)
      return
    }

    const heightMatch = line.match(/^height\s*[:=]\s*(\d+)\s*$/i)
    if (heightMatch) {
      height = parseDimension(heightMatch[1], 'height', lineNumber, issues)
      return
    }

    const colorMatch = line.match(/^\[(\d+)]\s*[:=]\s*(.+)$/)
    if (colorMatch) {
      const colorIndex = Number(colorMatch[1])
      const colorValue = parseColorValue(colorMatch[2].trim(), lineNumber, issues)
      if (colorValue) colors[colorIndex] = colorValue
      return
    }

    const pixelMatch = line.match(/^x\s*:\s*(\d+(?:\s*~\s*\d+)?)\s*,\s*y\s*:\s*(\d+(?:\s*~\s*\d+)?)\s*\[(\d+)]\s*$/i)
    if (pixelMatch) {
      const xSpan = parseCoordinateSpan(pixelMatch[1], 'x', lineNumber, issues)
      const ySpan = parseCoordinateSpan(pixelMatch[2], 'y', lineNumber, issues)
      if (!xSpan || !ySpan) return

      const pixelCount = spanLength(xSpan) * spanLength(ySpan)
      if (rawPixels.length + pixelCount > MAX_PIXELS) {
        issues.push({
          lineNumber,
          message: `第 ${lineNumber} 行像素范围太大：最多 ${MAX_PIXELS} 个像素`,
        })
        return
      }

      const colorIndex = Number(pixelMatch[3])
      forEachCoordinateInSpan(ySpan, (y) => {
        forEachCoordinateInSpan(xSpan, (x) => {
          rawPixels.push({ x, y, colorIndex, lineNumber })
        })
      })
      return
    }

    issues.push({ lineNumber, message: `第 ${lineNumber} 行无法识别：${line}` })
  })

  if (width == null) issues.push({ lineNumber: 1, message: '缺少 width' })
  if (height == null) issues.push({ lineNumber: 1, message: '缺少 height' })

  if (width != null && height != null && width * height > MAX_PIXELS) {
    issues.push({
      lineNumber: 1,
      message: `图片太大：最多 ${MAX_PIXELS} 个像素`,
    })
  }

  const validWidth = width ?? 0
  const validHeight = height ?? 0
  const pixels: DragonPixel[] = []
  const reportedOutOfRangeLines = new Set<number>()
  const reportedMissingColors = new Set<string>()

  if (validWidth > 0 && validHeight > 0) {
    for (const pixel of rawPixels) {
      if (pixel.x < 1 || pixel.x > validWidth || pixel.y < 1 || pixel.y > validHeight) {
        if (!reportedOutOfRangeLines.has(pixel.lineNumber)) {
          reportedOutOfRangeLines.add(pixel.lineNumber)
          issues.push({
            lineNumber: pixel.lineNumber,
            message: `第 ${pixel.lineNumber} 行像素坐标超出 ${validWidth} x ${validHeight}`,
          })
        }
        continue
      }
      const color = colors[pixel.colorIndex]
      if (!color) {
        const key = `${pixel.lineNumber}:${pixel.colorIndex}`
        if (!reportedMissingColors.has(key)) {
          reportedMissingColors.add(key)
          issues.push({
            lineNumber: pixel.lineNumber,
            message: `第 ${pixel.lineNumber} 行引用了未定义颜色 [${pixel.colorIndex}]`,
          })
        }
        continue
      }
      pixels.push({ ...pixel, color })
    }
  }

  if (issues.length) throw new DragonImageParseError(issues)

  return {
    width: validWidth,
    height: validHeight,
    colors,
    pixels,
  }
}

export function extractDragonPixelSource(source: string): string {
  const lines = String(source).split(/\r?\n/)
  const blocks: string[] = []
  let inBlock = false
  let blockLines: string[] = []
  let sawFence = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!inBlock && /^```[ \t]*dragon-pixel[ \t]*$/i.test(line)) {
      sawFence = true
      inBlock = true
      blockLines = []
      continue
    }

    if (inBlock && /^```[ \t]*$/.test(line)) {
      blocks.push(blockLines.join('\n'))
      inBlock = false
      blockLines = []
      continue
    }

    if (inBlock) blockLines.push(rawLine)
  }

  if (inBlock) {
    throw new DragonImageParseError([{ lineNumber: lines.length, message: 'dragon-pixel 代码块没有结束标记' }])
  }
  if (!sawFence) return source
  if (blocks.length === 0) {
    throw new DragonImageParseError([{ lineNumber: 1, message: '缺少 dragon-pixel 代码块' }])
  }
  if (blocks.length > 1) {
    throw new DragonImageParseError([{ lineNumber: 1, message: '只能包含一个 dragon-pixel 代码块' }])
  }
  return blocks[0]
}

export function buildDragonPixelBuffer(document: DragonImageDocument): Uint8ClampedArray<ArrayBuffer> {
  const buffer = new Uint8ClampedArray(new ArrayBuffer(document.width * document.height * 4))
  for (const pixel of document.pixels) {
    const index = ((pixel.y - 1) * document.width + (pixel.x - 1)) * 4
    buffer[index] = pixel.color.r
    buffer[index + 1] = pixel.color.g
    buffer[index + 2] = pixel.color.b
    buffer[index + 3] = pixel.color.a
  }
  return buffer
}

function parseDimension(
  raw: string,
  label: 'width' | 'height',
  lineNumber: number,
  issues: DragonImageIssue[],
): number | null {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    issues.push({
      lineNumber,
      message: `第 ${lineNumber} 行 ${label} 必须是 1 到 ${MAX_DIMENSION} 的整数`,
    })
    return null
  }
  return value
}

function parseCoordinateSpan(
  raw: string,
  axis: 'x' | 'y',
  lineNumber: number,
  issues: DragonImageIssue[],
): CoordinateSpan | null {
  const parts = raw.split('~').map((part) => part.trim())
  const start = parseCoordinate(parts[0], axis, lineNumber, issues)
  const end = parseCoordinate(parts[1] ?? parts[0], axis, lineNumber, issues)
  if (start == null || end == null) return null
  return { start, end }
}

function parseCoordinate(
  raw: string,
  axis: 'x' | 'y',
  lineNumber: number,
  issues: DragonImageIssue[],
): number | null {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    issues.push({
      lineNumber,
      message: `第 ${lineNumber} 行 ${axis} 坐标必须是 1 到 ${MAX_DIMENSION} 的整数`,
    })
    return null
  }
  return value
}

function spanLength(span: CoordinateSpan): number {
  return Math.abs(span.end - span.start) + 1
}

function forEachCoordinateInSpan(span: CoordinateSpan, visit: (value: number) => void) {
  const step = span.start <= span.end ? 1 : -1
  for (let value = span.start; ; value += step) {
    visit(value)
    if (value === span.end) break
  }
}

function parseColorValue(
  raw: string,
  lineNumber: number,
  issues: DragonImageIssue[],
): DragonRgba | null {
  const ampersand = raw.match(/^&([0-9a-f])$/i)
  if (ampersand) return { ...AMPERSAND_COLORS[ampersand[1].toLowerCase()] }

  const hex = raw.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hex) {
    const value = hex[1]
    return {
      r: Number.parseInt(value.slice(0, 2), 16),
      g: Number.parseInt(value.slice(2, 4), 16),
      b: Number.parseInt(value.slice(4, 6), 16),
      a: value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) : 255,
    }
  }

  const rgba = raw.match(/^rgba?\(([^)]+)\)$/i)
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => part.trim())
    if (parts.length === 3 || parts.length === 4) {
      const channels = parts.slice(0, 3).map(Number)
      const alpha = parts[3] == null ? 255 : parseAlpha(parts[3])
      if (channels.every(isByte) && isByte(alpha)) {
        return {
          r: channels[0],
          g: channels[1],
          b: channels[2],
          a: alpha,
        }
      }
    }
  }

  issues.push({ lineNumber, message: `第 ${lineNumber} 行颜色格式无效：${raw}` })
  return null
}

function parseAlpha(raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return Number.NaN
  if (value >= 0 && value <= 1) return Math.round(value * 255)
  return Math.round(value)
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255
}
