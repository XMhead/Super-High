export interface ColorCodePreviewRange {
  lineNumber: number
  startColumn: number
  endColumn: number
  color: string
}

const COLOR_TOKEN_PATTERN = /rgba\(\s*[^)]*?\s*\)/gi
const RGBA_PATTERN = /^rgba\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\)$/i

export function buildColorCodePreviewRanges(text: string): ColorCodePreviewRange[] {
  const ranges: ColorCodePreviewRange[] = []
  const lines = text.split(/\r?\n/)

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    let activeColor: string | null = null
    let segmentStart = 0

    COLOR_TOKEN_PATTERN.lastIndex = 0
    for (const match of line.matchAll(COLOR_TOKEN_PATTERN)) {
      const token = match[0]
      const tokenStart = match.index ?? 0
      const tokenEnd = tokenStart + token.length

      const rgbaColor = colorForRgbaToken(token)
      if (!rgbaColor) continue
      if (activeColor && tokenStart > segmentStart) {
        ranges.push(toRange(lineIndex, segmentStart, tokenStart, activeColor))
      }
      ranges.push(toRange(lineIndex, tokenStart, tokenEnd, rgbaColor))
      segmentStart = tokenEnd
    }

    if (activeColor && line.length > segmentStart) {
      ranges.push(toRange(lineIndex, segmentStart, line.length, activeColor))
    }
  }

  return ranges
}

export function colorCodePreviewClassName(color: string): string {
  const normalized = color.trim().toLowerCase()
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(normalized)) {
    return `color-code-preview-${normalized.slice(1)}`
  }
  const safeName = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `color-code-preview-${safeName || 'color'}`
}

export function colorCodePreviewStyleRule(color: string): string {
  return `.monaco-host .monaco-editor .${colorCodePreviewClassName(color)} { color: ${color} !important; }`
}

function toRange(lineIndex: number, startIndex: number, endIndex: number, color: string): ColorCodePreviewRange {
  return {
    lineNumber: lineIndex + 1,
    startColumn: startIndex + 1,
    endColumn: endIndex + 1,
    color,
  }
}

function colorForRgbaToken(token: string): string | null {
  const match = RGBA_PATTERN.exec(token)
  if (!match) return null
  const red = parseColorChannel(match[1])
  const green = parseColorChannel(match[2])
  const blue = parseColorChannel(match[3])
  const alpha = parseAlpha(match[4])
  if (red == null || green == null || blue == null || alpha == null) return null
  return `rgba(${red}, ${green}, ${blue}, ${formatAlpha(alpha)})`
}

function parseColorChannel(value: string): number | null {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 255) return null
  return number
}

function parseAlpha(value: string): number | null {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) return null
  return number
}

function formatAlpha(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}
