import { findYamlKeyValueLine } from './yamlPreview'
import { buildColorCodePreviewRanges } from './colorCodePreview'
import type { DragonCoreFontImage } from '@/types'

export type ItemYamlPreviewSegmentKind =
  | 'indent'
  | 'key'
  | 'separator'
  | 'string'
  | 'number'
  | 'literal'
  | 'value'
  | 'comment'
  | 'listMarker'

export interface ItemYamlPreviewSegment {
  kind: ItemYamlPreviewSegmentKind
  text: string
  color?: string
  fontImage?: DragonCoreFontImage
}

export interface ItemYamlPreviewLine {
  lineNumber: number
  segments: ItemYamlPreviewSegment[]
}

export function buildItemYamlPreviewLines(
  text: string,
  dragonCoreFontImages: DragonCoreFontImage[] = [],
  renderDragonCoreFontImages = false,
): ItemYamlPreviewLine[] {
  const fontImagesByCharacter = renderDragonCoreFontImages
    ? buildDragonCoreFontImageMap(dragonCoreFontImages)
    : new Map<string, DragonCoreFontImage>()
  return text.split(/\r?\n/).map((line, index) => ({
    lineNumber: index + 1,
    segments: applyDragonCoreFontImages(
      colorizeSegments(buildItemYamlPreviewSegments(line)),
      fontImagesByCharacter,
    ),
  }))
}

function buildItemYamlPreviewSegments(line: string): ItemYamlPreviewSegment[] {
  const segments: ItemYamlPreviewSegment[] = []
  const indent = line.match(/^\s*/)?.[0] ?? ''
  if (indent) segments.push({ kind: 'indent', text: indent })

  const body = line.slice(indent.length)
  if (!body) return segments
  if (body.startsWith('#')) {
    segments.push({ kind: 'comment', text: body })
    return segments
  }

  if (body.startsWith('- ')) {
    segments.push({ kind: 'listMarker', text: '- ' })
    const value = body.slice(2)
    if (value) segments.push({ kind: yamlValueKind(value), text: value })
    return segments
  }

  const match = findYamlKeyValueLine(line)
  if (!match) {
    segments.push({ kind: 'value', text: body })
    return segments
  }

  pushRange(segments, line, indent.length, match.keyStartIndex, 'value')
  pushRange(segments, line, match.keyStartIndex, match.keyEndIndex, 'key')
  pushRange(segments, line, match.separatorIndex, match.valueStartIndex, 'separator')
  if (match.valueStartIndex < match.valueEndIndex) {
    const valueText = line.slice(match.valueStartIndex, match.valueEndIndex)
    segments.push({ kind: yamlValueKind(valueText), text: valueText })
  }
  pushRange(segments, line, match.valueEndIndex, line.length, 'comment')
  return segments
}

function pushRange(
  segments: ItemYamlPreviewSegment[],
  line: string,
  start: number,
  end: number,
  kind: ItemYamlPreviewSegmentKind,
) {
  if (end <= start) return
  segments.push({ kind, text: line.slice(start, end) })
}

function yamlValueKind(value: string): ItemYamlPreviewSegmentKind {
  const trimmed = value.trim()
  if (!trimmed) return 'value'
  if (/^#/.test(trimmed)) return 'comment'
  if (/^(['"]).*\1$/.test(trimmed)) return 'string'
  if (/^(true|false|null|~)$/i.test(trimmed)) return 'literal'
  if (/^[-+]?(?:0|[1-9][\d_]*)(?:\.[\d_]+)?(?:e[-+]?\d+)?$/i.test(trimmed)) return 'number'
  return 'value'
}

function colorizeSegments(segments: ItemYamlPreviewSegment[]): ItemYamlPreviewSegment[] {
  return segments.flatMap(colorizeSegment)
}

function colorizeSegment(segment: ItemYamlPreviewSegment): ItemYamlPreviewSegment[] {
  const ranges = buildColorCodePreviewRanges(segment.text).filter((range) => range.lineNumber === 1)
  if (!ranges.length) return [segment]

  const output: ItemYamlPreviewSegment[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(0, Math.min(segment.text.length, range.startColumn - 1))
    const end = Math.max(start, Math.min(segment.text.length, range.endColumn - 1))
    if (start > cursor) {
      output.push({ kind: segment.kind, text: segment.text.slice(cursor, start) })
    }
    if (end > start) {
      output.push({ kind: segment.kind, text: segment.text.slice(start, end), color: range.color })
    }
    cursor = end
  }
  if (cursor < segment.text.length) {
    output.push({ kind: segment.kind, text: segment.text.slice(cursor) })
  }
  return output
}

function buildDragonCoreFontImageMap(images: DragonCoreFontImage[]): Map<string, DragonCoreFontImage> {
  const map = new Map<string, DragonCoreFontImage>()
  for (const image of images) {
    const character = image.character?.trim()
    if (!character || map.has(character)) continue
    map.set(character, image)
  }
  return map
}

function applyDragonCoreFontImages(
  segments: ItemYamlPreviewSegment[],
  imagesByCharacter: Map<string, DragonCoreFontImage>,
): ItemYamlPreviewSegment[] {
  if (!imagesByCharacter.size) return segments
  return segments.flatMap((segment) => replaceDragonCoreFontCharacters(segment, imagesByCharacter))
}

function replaceDragonCoreFontCharacters(
  segment: ItemYamlPreviewSegment,
  imagesByCharacter: Map<string, DragonCoreFontImage>,
): ItemYamlPreviewSegment[] {
  if (!segment.text || segment.kind === 'indent') return [segment]
  const output: ItemYamlPreviewSegment[] = []
  let plainText = ''

  function flushPlainText() {
    if (!plainText) return
    output.push({ ...segment, text: plainText, fontImage: undefined })
    plainText = ''
  }

  const characters = Array.from(segment.text)
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    const nextCharacter = characters[index + 1]
    if (isDragonCoreFontImagePrefix(character) && nextCharacter) {
      const prefixedFontImage = imagesByCharacter.get(nextCharacter)
      if (prefixedFontImage?.color === true) {
        flushPlainText()
        output.push({
          ...segment,
          text: nextCharacter,
          color: undefined,
          fontImage: prefixedFontImage,
        })
        index += 1
        continue
      }
    }

    const fontImage = imagesByCharacter.get(character)
    if (!fontImage || fontImage.color === true) {
      plainText += character
      continue
    }
    flushPlainText()
    output.push({
      ...segment,
      text: character,
      color: undefined,
      fontImage,
    })
  }
  flushPlainText()
  return output.length ? output : [segment]
}

function isDragonCoreFontImagePrefix(character: string): boolean {
  return character === '§' || character === '&'
}
