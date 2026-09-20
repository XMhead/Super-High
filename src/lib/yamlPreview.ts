import { parseDocument } from 'yaml'
import type { YAMLError } from 'yaml'

export interface YamlKeyValueLine {
  keyStartIndex: number
  keyEndIndex: number
  separatorIndex: number
  valueStartIndex: number
  valueEndIndex: number
  valueKind: 'plain' | 'block'
}

export interface YamlKeySpan {
  /** Simple key name (last segment). */
  keyName: string
  /** Full dotted path from root (e.g. "server.host.port"). */
  keyPath: string
  /** 1-based line number. */
  lineNumber: number
  /** 0-based column where this key starts on its line. */
  startColumn: number
  /** 0-based column past the last character of this key. */
  endColumn: number
  /** Indent depth in spaces. */
  indent: number
}

export interface YamlKeyIndex {
  /** keyName → all spans with that name anywhere in the file. */
  byName: Map<string, YamlKeySpan[]>
  /** keyPath → its span (first occurrence wins for duplicate paths). */
  byPath: Map<string, YamlKeySpan>
  /** Root-level mapping keys in file order. */
  topLevel: YamlKeySpan[]
  /** All spans in file order. */
  all: YamlKeySpan[]
}

export interface YamlSyntaxIssue {
  lineNumber: number
  column: number
  endLineNumber: number
  endColumn: number
  message: string
}

export function parseYamlSyntaxIssues(text: string): YamlSyntaxIssue[] {
  const document = parseDocument(text, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    logLevel: 'silent',
  })

  return document.errors.map((error) => yamlErrorToIssue(error, text))
}

function yamlErrorToIssue(error: YAMLError, source: string): YamlSyntaxIssue {
  const start = error.linePos?.[0] ?? offsetToLineColumn(source, error.pos[0])
  const end = error.linePos?.[1] ?? offsetToLineColumn(source, error.pos[1])
  const cleanMessage = error.message.split('\n')[0]?.trim() || 'YAML 语法错误'
  const lineNumber = Math.max(1, start.line)
  const column = Math.max(1, start.col)
  const endLineNumber = Math.max(lineNumber, end.line)
  const endColumn = endLineNumber === lineNumber
    ? Math.max(column + 1, end.col)
    : Math.max(1, end.col)

  return {
    lineNumber,
    column,
    endLineNumber,
    endColumn,
    message: `YAML 第 ${lineNumber} 行：${cleanMessage}`,
  }
}

function offsetToLineColumn(source: string, offset: number): { line: number; col: number } {
  let line = 1
  let column = 1
  const safeOffset = Math.max(0, Math.min(source.length, offset))

  for (let index = 0; index < safeOffset; index += 1) {
    if (source[index] === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }

  return { line, col: column }
}

/**
 * Parse every YAML key in `text` and build a navigation index.
 *
 * Handles nested mappings, sequence entries (`- key: val`), block scalars,
 * quoted keys, and inline comments.  Keys inside flow mappings (`{ ... }`)
 * are intentionally skipped because they don't map cleanly to line-level
 * navigation.
 */
export function buildYamlKeyIndex(text: string): YamlKeyIndex {
  const lines = text.split(/\r?\n/)
  const spans: YamlKeySpan[] = []
  const pathStack: Array<{ name: string; indent: number }> = []

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
      // Empty / comment / doc-marker lines don't move the indent stack but
      // do NOT pop the stack either — only a dedent at a non-empty line pops.
      continue
    }

    const indent = countIndent(line)
    const seqPrefix = detectSequencePrefix(line, indent)

    // Pop stack when indent decreases past a parent.
    while (pathStack.length > 0 && indent <= pathStack[pathStack.length - 1].indent) {
      pathStack.pop()
    }

    const lineWithoutSeq = seqPrefix ? line.slice(seqPrefix.endColumn) : line
    const kv = findYamlKeyValueLine(lineWithoutSeq)

    if (!kv) {
      // Not a key-value line — could be a bare sequence item or plain text.
      continue
    }

    const keyText = lineWithoutSeq.slice(kv.keyStartIndex, kv.keyEndIndex)
    const unquotedKey = unquoteYamlKey(keyText)
    if (!unquotedKey) continue

    const newIndent = indent + (seqPrefix ? seqPrefix.endColumn - indent : 0)
    pathStack.push({ name: unquotedKey, indent: newIndent })
    const keyPath = pathStack.map((s) => s.name).join('.')

    // Calculate absolute column in original line
    const keyOffset = seqPrefix ? seqPrefix.endColumn : 0
    const startColumn = kv.keyStartIndex + keyOffset
    const endColumn = kv.keyEndIndex + keyOffset

    spans.push({
      keyName: unquotedKey,
      keyPath,
      lineNumber: lineNumber + 1,
      startColumn,
      endColumn,
      indent: newIndent,
    })
  }

  const byName = new Map<string, YamlKeySpan[]>()
  const byPath = new Map<string, YamlKeySpan>()

  for (const span of spans) {
    const nameGroup = byName.get(span.keyName) ?? []
    nameGroup.push(span)
    byName.set(span.keyName, nameGroup)

    if (!byPath.has(span.keyPath)) {
      byPath.set(span.keyPath, span)
    }
  }

  return {
    byName,
    byPath,
    topLevel: spans.filter((span) => span.indent === 0 && span.keyPath === span.keyName),
    all: spans,
  }
}

export function scanYamlTopLevelKeys(text: string): YamlKeySpan[] {
  return buildYamlKeyIndex(text).topLevel
}

function countIndent(line: string): number {
  let count = 0
  while (count < line.length && line[count] === ' ') count += 1
  return count
}

interface SeqPrefix {
  endColumn: number
}

function detectSequencePrefix(line: string, indent: number): SeqPrefix | null {
  const afterIndent = line.slice(indent)
  if (afterIndent.startsWith('- ') || afterIndent.startsWith('-\t')) {
    return { endColumn: indent + afterIndent.indexOf('-') + 1 }
  }
  return null
}

function unquoteYamlKey(key: string): string {
  const trimmed = key.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Return the next occurrence span for `keyName` that appears after
 * `currentLine` (wrapping to the start when no later match exists).
 * Returns null when the key only appears once.
 */
export function nextKeyOccurrence(index: YamlKeyIndex, keyName: string, currentLine: number): YamlKeySpan | null {
  const group = index.byName.get(keyName)
  if (!group || group.length < 2) return null

  // Find the first occurrence after currentLine.
  for (const span of group) {
    if (span.lineNumber > currentLine) return span
  }
  // Wrap: return the first occurrence.
  return group[0]
}

export function findYamlKeyValueLine(line: string): YamlKeyValueLine | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') return null

  const keyStartIndex = findKeyStartIndex(line)
  const separatorIndex = findKeyValueSeparator(line, keyStartIndex)
  if (separatorIndex < 0) return null

  const keyEndIndex = trimEndIndex(line, separatorIndex)
  if (keyEndIndex <= keyStartIndex) return null

  const valueStartIndex = trimStartIndex(line, separatorIndex + 1)
  const valueEndIndex = trimEndIndex(line, findInlineCommentStart(line, valueStartIndex))
  const valueText = line.slice(valueStartIndex, valueEndIndex)

  return {
    keyStartIndex,
    keyEndIndex,
    separatorIndex,
    valueStartIndex,
    valueEndIndex: Math.max(valueStartIndex, valueEndIndex),
    valueKind: isYamlBlockScalarMarker(valueText) ? 'block' : 'plain',
  }
}

function findKeyStartIndex(line: string): number {
  let index = trimStartIndex(line, 0)
  if (line[index] !== '-') return index

  const afterDash = index + 1
  if (line[afterDash] !== ' ' && line[afterDash] !== '\t') return index
  return trimStartIndex(line, afterDash)
}

function findKeyValueSeparator(line: string, startIndex: number): number {
  let quote: '"' | "'" | null = null

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (quote === "'") {
      if (char === "'" && next === "'") { index += 1; continue }
      if (char === "'") { quote = null; continue }
      continue
    }

    if (quote === '"') {
      if (char === '\\') { index += 1; continue }
      if (char === '"') { quote = null; continue }
      continue
    }

    if (char === "'" || char === '"') { quote = char; continue }

    if (char === ':' && (!next || next === ' ' || next === '\t')) return index
  }

  return -1
}

function findInlineCommentStart(line: string, startIndex: number): number {
  let quote: '"' | "'" | null = null

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index]
    const previous = line[index - 1]
    const next = line[index + 1]

    if (quote === "'") {
      if (char === "'" && next === "'") { index += 1; continue }
      if (char === "'") { quote = null; continue }
      continue
    }

    if (quote === '"') {
      if (char === '\\') { index += 1; continue }
      if (char === '"') { quote = null; continue }
      continue
    }

    if (char === "'" || char === '"') { quote = char; continue }

    if (char === '#' && (!previous || previous === ' ' || previous === '\t')) return index
  }

  return line.length
}

function trimStartIndex(line: string, startIndex: number): number {
  let index = startIndex
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1
  return index
}

function trimEndIndex(line: string, endIndex: number): number {
  let index = endIndex
  while (index > 0 && (line[index - 1] === ' ' || line[index - 1] === '\t')) index -= 1
  return index
}

function isYamlBlockScalarMarker(value: string): boolean {
  return /^[>|][+-]?(?:[1-9])?[+-]?$/.test(value)
}
