import { findYamlKeyValueLine } from './yamlPreview'
import { buildColorCodePreviewRanges } from './colorCodePreview'

export type YamlColorPreviewSegmentKind =
  | 'indent'
  | 'key'
  | 'separator'
  | 'string'
  | 'number'
  | 'literal'
  | 'value'
  | 'comment'
  | 'listMarker'

export interface YamlColorPreviewSegment {
  kind: YamlColorPreviewSegmentKind
  text: string
  color?: string
}

export interface YamlColorPreviewLine {
  lineNumber: number
  segments: YamlColorPreviewSegment[]
}

export function buildYamlColorPreviewLines(text: string): YamlColorPreviewLine[] {
  return text.split(/\r?\n/).map((line, index) => ({
    lineNumber: index + 1,
    segments: colorizeSegments(buildYamlColorPreviewSegments(line)),
  }))
}

function buildYamlColorPreviewSegments(line: string): YamlColorPreviewSegment[] {
  const segments: YamlColorPreviewSegment[] = []
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
  segments: YamlColorPreviewSegment[],
  line: string,
  start: number,
  end: number,
  kind: YamlColorPreviewSegmentKind,
) {
  if (end <= start) return
  segments.push({ kind, text: line.slice(start, end) })
}

function yamlValueKind(value: string): YamlColorPreviewSegmentKind {
  const trimmed = value.trim()
  if (!trimmed) return 'value'
  if (/^#/.test(trimmed)) return 'comment'
  if (/^(['"]).*\1$/.test(trimmed)) return 'string'
  if (/^(true|false|null|~)$/i.test(trimmed)) return 'literal'
  if (/^[-+]?(?:0|[1-9][\d_]*)(?:\.[\d_]+)?(?:e[-+]?\d+)?$/i.test(trimmed)) return 'number'
  return 'value'
}

function colorizeSegments(segments: YamlColorPreviewSegment[]): YamlColorPreviewSegment[] {
  return segments.flatMap(colorizeSegment)
}

function colorizeSegment(segment: YamlColorPreviewSegment): YamlColorPreviewSegment[] {
  const ranges = buildColorCodePreviewRanges(segment.text).filter((range) => range.lineNumber === 1)
  if (!ranges.length) return [segment]

  const output: YamlColorPreviewSegment[] = []
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

