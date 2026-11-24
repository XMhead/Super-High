import type * as MonacoTypes from 'monaco-editor'

import type { Monaco } from './monaco'

export interface TabCompletionPosition {
  lineNumber: number
  column: number
}

export interface TabCompletionSuggestion {
  insertText: string
}

interface TabCompletionOptions {
  explicit?: boolean
}

interface CompletionCandidate {
  insertText: string
  score: number
}

const MAX_INSERT_LINES = 4
const MAX_INSERT_CHARS = 360
const MAX_SCAN_LINES = 1400
let registered = false

export function registerEditorTabCompletion(monaco: Monaco) {
  if (registered) return
  registered = true

  monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions(model, position, context) {
      const suggestion = buildTabCompletionSuggestion(model.getValue(), position, {
        explicit: context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit,
      })
      if (!suggestion) return { items: [] }

      return {
        items: [{
          insertText: suggestion.insertText,
          filterText: suggestion.insertText,
          range: new monaco.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            model.getLineMaxColumn(position.lineNumber),
          ),
          command: {
            id: 'editor.action.inlineSuggest.trigger',
            title: 'Refresh inline suggestion',
          },
        }],
        enableForwardStability: true,
        suppressSuggestions: true,
      }
    },
    freeInlineCompletions() {},
  } satisfies MonacoTypes.languages.InlineCompletionsProvider)
}

export function buildTabCompletionSuggestion(
  text: string,
  position: TabCompletionPosition,
  options: TabCompletionOptions = {},
): TabCompletionSuggestion | null {
  const lines = splitLines(text)
  if (!lines.length) return null

  const lineIndex = clamp(position.lineNumber - 1, 0, lines.length - 1)
  const line = lines[lineIndex] ?? ''
  const columnIndex = clamp(position.column - 1, 0, line.length)
  const prefix = line.slice(0, columnIndex)
  const suffix = line.slice(columnIndex)
  const typedLength = prefix.trimStart().trim().length
  const candidates: CompletionCandidate[] = []

  if (typedLength >= (options.explicit ? 1 : 2)) {
    candidates.push(...findLinePrefixCandidates(lines, lineIndex, prefix, suffix))
  }

  if (suffix.trim().length === 0 && prefix.trim().length === 0) {
    candidates.push(...findContinuationCandidates(lines, lineIndex, prefix))
  }

  const best = uniqueCandidates(candidates)
    .sort((a, b) => b.score - a.score)
    .find((candidate) => isUsefulInsertText(candidate.insertText, suffix))

  if (!best) return null
  return { insertText: limitInsertText(best.insertText) }
}

function findLinePrefixCandidates(
  lines: string[],
  lineIndex: number,
  prefix: string,
  suffix: string,
): CompletionCandidate[] {
  const candidates: CompletionCandidate[] = []
  const start = Math.max(0, lineIndex - MAX_SCAN_LINES)
  const end = Math.min(lines.length - 1, lineIndex + MAX_SCAN_LINES)
  const targetIndent = leadingWhitespace(prefix)

  for (let index = end; index >= start; index -= 1) {
    if (index === lineIndex) continue

    const sourceLine = lines[index]
    if (!sourceLine.trim()) continue

    const adjustedLine = targetIndent + sourceLine.trimStart()
    if (adjustedLine === prefix || !adjustedLine.startsWith(prefix)) continue

    const insertLines = [adjustedLine.slice(prefix.length)]
    insertLines.push(...collectBlockContinuation(lines, index, targetIndent, lineIndex))
    const insertText = trimInsertLines(insertLines).join('\n')
    if (!isUsefulInsertText(insertText, suffix)) continue

    const distance = Math.abs(index - lineIndex)
    const sameIndentBonus = leadingWhitespace(sourceLine).length === targetIndent.length ? 24 : 0
    candidates.push({
      insertText,
      score: 1200 - distance + prefix.trim().length * 8 + (insertLines.length - 1) * 38 + sameIndentBonus,
    })
  }

  return candidates
}

function collectBlockContinuation(
  lines: string[],
  sourceLineIndex: number,
  targetIndent: string,
  blockedLineIndex: number,
): string[] {
  const sourceLine = lines[sourceLineIndex]
  const sourceIndent = leadingWhitespace(sourceLine)
  const trimmedSource = sourceLine.trimEnd()
  const nextLine = lines[sourceLineIndex + 1]
  if (!nextLine || !shouldCollectFollowingBlock(trimmedSource, sourceIndent, nextLine)) return []

  const continuation: string[] = []
  let collectedIndentedLine = false

  for (let index = sourceLineIndex + 1; index < lines.length && continuation.length < MAX_INSERT_LINES - 1; index += 1) {
    if (index === blockedLineIndex) break
    const line = lines[index]
    if (!line.trim()) break

    const lineIndent = leadingWhitespace(line)
    const trimmedLine = line.trim()
    const isIndented = lineIndent.length > sourceIndent.length
    const isClosingLine = collectedIndentedLine && lineIndent.length === sourceIndent.length && isClosingToken(trimmedLine)
    if (!isIndented && !isClosingLine) break

    continuation.push(reindentLine(line, sourceIndent, targetIndent))
    if (isIndented) collectedIndentedLine = true
    if (isClosingLine) break
  }

  return continuation
}

function shouldCollectFollowingBlock(sourceLine: string, sourceIndent: string, nextLine: string): boolean {
  if (!nextLine.trim()) return false
  const nextIndent = leadingWhitespace(nextLine)
  return /[{[(]\s*$|:\s*$|=>\s*$/.test(sourceLine) || nextIndent.length > sourceIndent.length
}

function findContinuationCandidates(lines: string[], lineIndex: number, prefix: string): CompletionCandidate[] {
  const previousLineIndex = previousNonEmptyLineIndex(lines, lineIndex - 1)
  if (previousLineIndex < 0) return []

  const context = buildPreviousContext(lines, previousLineIndex)
  if (!context.length) return []

  const candidates: CompletionCandidate[] = []
  const targetIndent = leadingWhitespace(prefix)
  const start = Math.max(0, previousLineIndex - MAX_SCAN_LINES)

  for (let index = previousLineIndex - context.length; index >= start; index -= 1) {
    if (!contextMatchesAt(lines, index, context)) continue
    const followStart = index + context.length
    if (followStart >= lines.length || followStart >= lineIndex - 1) continue

    let continuation = collectContinuationFrom(lines, followStart, targetIndent, previousLineIndex)
    continuation = removeTrailingLinesAlreadyPresent(continuation, lines, lineIndex)
    if (!continuation.length) continue

    const firstLine = continuation[0]
    if (!firstLine.startsWith(prefix)) continue

    const insertText = trimInsertLines([
      firstLine.slice(prefix.length),
      ...continuation.slice(1),
    ]).join('\n')
    if (!isUsefulInsertText(insertText, '')) continue

    candidates.push({
      insertText,
      score: 980 - Math.abs(index - lineIndex) + context.length * 80 + continuation.length * 24,
    })
  }

  return candidates
}

function buildPreviousContext(lines: string[], previousLineIndex: number): string[] {
  const context: string[] = []
  let index = previousLineIndex

  while (index >= 0 && context.length < 2) {
    const line = lines[index]
    if (line.trim()) context.unshift(line.trim())
    index -= 1
  }

  return context.filter((line) => line.length >= 3)
}

function contextMatchesAt(lines: string[], startIndex: number, context: string[]): boolean {
  if (startIndex < 0 || startIndex + context.length >= lines.length) return false
  for (let offset = 0; offset < context.length; offset += 1) {
    if (lines[startIndex + offset]?.trim() !== context[offset]) return false
  }
  return true
}

function collectContinuationFrom(lines: string[], startIndex: number, targetIndent: string, stopBeforeIndex: number): string[] {
  const sourceBaseIndent = leadingWhitespace(lines[startIndex] ?? '')
  const continuation: string[] = []

  for (let index = startIndex; index < lines.length && index < stopBeforeIndex && continuation.length < MAX_INSERT_LINES; index += 1) {
    const line = lines[index]
    if (!line.trim()) break
    continuation.push(reindentLine(line, sourceBaseIndent, targetIndent))
  }

  return continuation
}

function removeTrailingLinesAlreadyPresent(candidateLines: string[], lines: string[], lineIndex: number): string[] {
  const result = [...candidateLines]
  let nextIndex = lineIndex + 1
  while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1
  const nextTrimmed = lines[nextIndex]?.trim()

  while (result.length > 1 && nextTrimmed && result[result.length - 1]?.trim() === nextTrimmed) {
    result.pop()
  }

  return result
}

function reindentLine(line: string, sourceBaseIndent: string, targetIndent: string): string {
  if (line.startsWith(sourceBaseIndent)) return targetIndent + line.slice(sourceBaseIndent.length)
  return targetIndent + line.trimStart()
}

function previousNonEmptyLineIndex(lines: string[], fromIndex: number): number {
  for (let index = fromIndex; index >= 0; index -= 1) {
    if (lines[index]?.trim()) return index
  }
  return -1
}

function uniqueCandidates(candidates: CompletionCandidate[]): CompletionCandidate[] {
  const byText = new Map<string, CompletionCandidate>()
  for (const candidate of candidates) {
    const existing = byText.get(candidate.insertText)
    if (!existing || candidate.score > existing.score) byText.set(candidate.insertText, candidate)
  }
  return [...byText.values()]
}

function isUsefulInsertText(insertText: string, suffix: string): boolean {
  if (!insertText || !insertText.trim()) return false
  if (suffix && !insertText.startsWith(suffix)) return false
  return insertText !== suffix
}

function trimInsertLines(lines: string[]): string[] {
  const result = [...lines]
  while (result.length > 1 && !result[result.length - 1]?.trim()) result.pop()
  return result
}

function limitInsertText(insertText: string): string {
  const lines = insertText.split('\n').slice(0, MAX_INSERT_LINES)
  let limited = lines.join('\n')
  if (limited.length > MAX_INSERT_CHARS) limited = limited.slice(0, MAX_INSERT_CHARS)
  return limited
}

function leadingWhitespace(value: string): string {
  const match = value.match(/^[\t ]*/)
  return match?.[0] ?? ''
}

function isClosingToken(value: string): boolean {
  return /^(}|\]|\)|<\/[\w.-]+>)\s*[;,]?$/.test(value)
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
