import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export interface TerminalFileLinkOptions {
  fileExists?: (path: string) => Promise<boolean> | boolean
  resolvePath?: (path: string) => Promise<TerminalPathTarget | null> | TerminalPathTarget | null
  openFile: (path: string) => Promise<void> | void
  openFolder?: (path: string) => Promise<void> | void
  workspaceRoot?: () => string | null
}

export interface TerminalPathTarget {
  path: string
  isFile: boolean
}

export interface TerminalFilePathMatch {
  path: string
  text: string
  start: number
  end: number
}

type LogicalLinePart = {
  bufferLineNumber: number
  line: IBufferLine
  start: number
  text: string
  columnOffset: number
}

type LogicalLine = {
  parts: LogicalLinePart[]
  text: string
}

type SoftPathContinuation = {
  text: string
  columnOffset: number
  hasTuiGutter: boolean
}

const absolutePathStart = /(?:[A-Za-z]:[\\/]|~[\\/])/g
const relativePath = /(?:^|[\s("'`[{=,:“‘（【《，。；：！？、])((?:\.[\\/])?(?:(?:[\p{L}\p{N}\p{M}_@.-]+[\\/])+[\p{L}\p{N}\p{M}_@.-]+|(?:[\p{L}\p{N}\p{M}_@.-]+[\\/])*[\p{L}\p{N}\p{M}_@-]+(?:\.[\p{L}\p{N}\p{M}_-]+)+))(?=$|[\s"'`),\]}>;:!?”’），。；：！？、】》])/gu
const pathTerminator = /["'`<>|\u001b\r\n]/

export function registerTerminalFileLinks(terminal: Terminal, options: TerminalFileLinkOptions) {
  let gesture: { x: number; y: number; activated: boolean } | undefined
  let disposed = false
  const provider = createTerminalFileLinkProvider(terminal, {
    ...options,
    openFile(path) {
      if (gesture) gesture.activated = true
      return options.openFile(path)
    },
    openFolder(path) {
      if (gesture) gesture.activated = true
      return options.openFolder?.(path)
    },
  })
  const registration = terminal.registerLinkProvider(provider)
  const element = terminal.element
  const onMouseDown = (event: MouseEvent) => {
    gesture = event.button === 0 ? { x: event.clientX, y: event.clientY, activated: false } : undefined
  }
  // xterm requires a resolved hover link at mouse-down. A quick first click can
  // precede the filesystem reply; resolve that click too, without opening twice.
  const onClick = (event: MouseEvent) => {
    const click = gesture
    if (!click || click.activated || event.button !== 0 || event.detail > 1 || terminal.hasSelection()
      || Math.hypot(event.clientX - click.x, event.clientY - click.y) > 3) return
    const screen = element?.querySelector('.xterm-screen')
    const rect = screen?.getBoundingClientRect()
    if (!rect?.width || !rect.height) return
    const x = Math.floor((event.clientX - rect.left) * terminal.cols / rect.width) + 1
    const row = Math.floor((event.clientY - rect.top) * terminal.rows / rect.height) + 1
    if (x < 1 || x > terminal.cols || row < 1 || row > terminal.rows) return
    const y = terminal.buffer.active.viewportY + row
    provider.provideLinks(y, (links) => {
      if (disposed || gesture !== click || click.activated) return
      const link = links?.find(({ range }) => y >= range.start.y && y <= range.end.y
        && (y !== range.start.y || x >= range.start.x)
        && (y !== range.end.y || x <= range.end.x))
      link?.activate(event, link.text)
    })
  }
  element?.addEventListener('mousedown', onMouseDown, true)
  element?.addEventListener('click', onClick)
  return {
    dispose() {
      disposed = true
      registration.dispose()
      element?.removeEventListener('mousedown', onMouseDown, true)
      element?.removeEventListener('click', onClick)
    },
  }
}

export function createTerminalFileLinkProvider(terminal: Terminal, options: TerminalFileLinkOptions): ILinkProvider {
  const pathExistence = new Map<string, Promise<TerminalPathTarget | null>>()

  const resolvePath = (path: string) => {
    const key = path.toLowerCase()
    const existing = pathExistence.get(key)
    if (existing) return existing
    const check = options.resolvePath
      ? Promise.resolve(options.resolvePath(path)).catch(() => null)
      : Promise.resolve(options.fileExists?.(path)).then((isFile) => isFile ? { path, isFile: true } : null).catch(() => null)
    pathExistence.set(key, check)
    void check.then((target) => {
      if (!target) pathExistence.delete(key)
    })
    return check
  }

  return {
    provideLinks(bufferLineNumber, callback) {
      const logicalLines = [
        readSoftWrappedPathLine(terminal, bufferLineNumber, options.workspaceRoot?.() ?? ''),
        readLogicalLine(terminal, bufferLineNumber),
      ].filter((line): line is LogicalLine => line !== null)
      if (!logicalLines.length) {
        callback(undefined)
        return
      }

      const matches = logicalLines.flatMap((logicalLine) => (
        findTerminalFilePathMatches(logicalLine.text, options.workspaceRoot?.() ?? '')
          .filter((match) => pathTouchesBufferLine(logicalLine, match, bufferLineNumber))
          .map((match) => ({ logicalLine, match }))
      ))
      if (!matches.length) {
        callback(undefined)
        return
      }

      void Promise.all(matches.map(async ({ logicalLine, match }) => {
        const target = await resolvePath(match.path)
        if (!target) return null
        return createFileLink(terminal, logicalLine, match, target, options)
      })).then((links) => {
        const resolved = [...new Map(
          links
            .filter((link): link is ILink => link !== null)
            .map((link) => [
              `${link.range.start.x}:${link.range.start.y}:${link.range.end.x}:${link.range.end.y}:${link.text.toLowerCase()}`,
              link,
            ]),
        ).values()]
        callback(resolved.length ? resolved : undefined)
      }).catch(() => callback(undefined))
    },
  }
}

export function findTerminalFilePathMatches(text: string, workspaceRoot = ''): TerminalFilePathMatch[] {
  const matches = findAbsoluteFilePathMatches(text)
  const normalizedWorkspaceRoot = normalizeWindowsPath(workspaceRoot.trim()).replace(/\\+$/, '')
  if (!normalizedWorkspaceRoot) return matches

  relativePath.lastIndex = 0
  let relativeMatch: RegExpExecArray | null
  while ((relativeMatch = relativePath.exec(text))) {
    const candidate = relativeMatch[1]
    if (!candidate) continue
    const start = relativeMatch.index + relativeMatch[0].length - candidate.length
    const end = start + candidate.length
    if (matches.some((match) => start < match.end && end > match.start)) continue
    matches.push({
      path: normalizeWindowsPath(`${normalizedWorkspaceRoot}\\${candidate.replace(/^\.[\\/]/, '')}`),
      text: candidate,
      start,
      end,
    })
  }
  relativePath.lastIndex = 0

  return matches.sort((left, right) => left.start - right.start || right.end - left.end)
}

function findAbsoluteFilePathMatches(text: string): TerminalFilePathMatch[] {
  const matches: TerminalFilePathMatch[] = []
  const seen = new Set<string>()
  absolutePathStart.lastIndex = 0

  let startMatch: RegExpExecArray | null
  while ((startMatch = absolutePathStart.exec(text))) {
    const start = startMatch.index
    let rawEnd = start + startMatch[0].length
    while (rawEnd < text.length && !pathTerminator.test(text[rawEnd] ?? '')) rawEnd += 1
    const raw = text.slice(start, rawEnd)

    for (const candidate of pathCandidates(raw)) {
      const path = normalizeWindowsPath(candidate)
      const end = start + candidate.length
      const key = `${start}:${end}:${path.toLowerCase()}`
      if (!path || seen.has(key)) continue
      seen.add(key)
      matches.push({ path, text: candidate, start, end })
    }

    absolutePathStart.lastIndex = Math.max(rawEnd, start + startMatch[0].length)
  }

  return matches
}

function readLogicalLine(terminal: Terminal, bufferLineNumber: number): LogicalLine | null {
  const buffer = terminal.buffer.active
  if (bufferLineNumber < 1 || bufferLineNumber > buffer.length) return null

  let first = bufferLineNumber
  while (first > 1 && buffer.getLine(first - 1)?.isWrapped) first -= 1

  let last = bufferLineNumber
  while (last < buffer.length && buffer.getLine(last)?.isWrapped) last += 1

  const parts: LogicalLinePart[] = []
  let text = ''
  for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
    const line = buffer.getLine(lineNumber - 1)
    if (!line) continue
    const lineText = line.translateToString(true)
    parts.push({
      bufferLineNumber: lineNumber,
      line,
      start: text.length,
      text: lineText,
      columnOffset: 0,
    })
    text += lineText
  }
  return { parts, text }
}

// Full-screen CLIs may reflow a long path into separate rows and can mark
// unrelated visual rows as wrapped while redrawing their TUI.
function readSoftWrappedPathLine(terminal: Terminal, bufferLineNumber: number, workspaceRoot: string): LogicalLine | null {
  const buffer = terminal.buffer.active
  const firstSearchLine = Math.max(1, bufferLineNumber - 7)

  for (let start = bufferLineNumber; start >= firstSearchLine; start -= 1) {
    const startLine = buffer.getLine(start - 1)
    if (!startLine) continue
    const startText = startLine.translateToString(true)
    if (!startText) break
    if (!hasDrivePathStart(startText) && !findTerminalFilePathMatches(startText, workspaceRoot).length) continue

    const parts: LogicalLinePart[] = [{
      bufferLineNumber: start,
      line: startLine,
      start: 0,
      text: startText,
      columnOffset: 0,
    }]
    let text = startText

    for (let lineNumber = start + 1; lineNumber <= Math.min(buffer.length, start + 7); lineNumber += 1) {
      const line = buffer.getLine(lineNumber - 1)
      if (!line) break
      const lineText = line.translateToString(true)
      if (!isSoftPathContinuation(text, parts[parts.length - 1], lineText, terminal.cols, workspaceRoot)) break

      const continuation = continuationFromTerminalRow(lineText)
      if (continuation.hasTuiGutter) {
        text = trimTuiColumnOverflow(text, parts)
      }
      const previousPart = parts[parts.length - 1]
      const trimmedPreviousText = previousPart.text.trimEnd()
      if (trimmedPreviousText.length !== previousPart.text.length) {
        text = text.slice(0, text.length - previousPart.text.length) + trimmedPreviousText
        previousPart.text = trimmedPreviousText
      }
      parts.push({
        bufferLineNumber: lineNumber,
        line,
        start: text.length,
        text: continuation.text,
        columnOffset: continuation.columnOffset,
      })
      text += continuation.text
    }

    if (parts.length > 1 && parts.some((part) => part.bufferLineNumber === bufferLineNumber)) {
      return { parts, text }
    }
  }

  return null
}

function hasDrivePathStart(text: string): boolean {
  absolutePathStart.lastIndex = 0
  const matched = absolutePathStart.test(text)
  absolutePathStart.lastIndex = 0
  return matched
}

function isSoftPathContinuation(
  pathText: string,
  previousPart: LogicalLinePart,
  nextLineText: string,
  cols: number,
  workspaceRoot: string,
): boolean {
  if (!nextLineText.trim()) return false

  const isIndentedContinuation = /^\s+/.test(nextLineText)
  const fillsTerminalRow = bufferColumnForTextOffset(previousPart.line,
    previousPart.columnOffset + previousPart.text.length - 1, cols) >= cols - 1
  if (!isIndentedContinuation && !fillsTerminalRow) return false

  const starts = [...pathText.matchAll(/[A-Za-z]:[\\/]/g)]
  const start = starts.at(-1)?.index ?? findTerminalFilePathMatches(pathText, workspaceRoot).at(-1)?.start
  if (start === undefined) return false

  const trailingPath = pathText.slice(start).trimEnd()
  return !!trailingPath && !/[)\]）】]/.test(trailingPath)
    && ![...trailingPath].some((character) => pathTerminator.test(character))
}

function continuationFromTerminalRow(lineText: string): SoftPathContinuation {
  const withoutIndent = lineText.trimStart()
  const gutter = withoutIndent.match(/^[│┃]\s*/)
  const text = gutter ? withoutIndent.slice(gutter[0].length) : withoutIndent
  return {
    text,
    columnOffset: lineText.length - text.length,
    hasTuiGutter: !!gutter,
  }
}

// OpenCode's full-screen renderer can carry a fragment from an adjacent visual
// column after a path prefix. Its continuation rows are explicitly marked by a gutter.
function trimTuiColumnOverflow(text: string, parts: LogicalLinePart[]): string {
  const starts = [...text.matchAll(/[A-Za-z]:[\\/]/g)]
  const start = starts.at(-1)?.index
  if (start === undefined) return text

  const gap = text.slice(start).match(/\s{2,}/)
  if (!gap || gap.index === undefined) return text

  const cutAt = start + gap.index
  const previousPart = parts[parts.length - 1]
  if (cutAt < previousPart.start) return text
  previousPart.text = previousPart.text.slice(0, cutAt - previousPart.start)
  return text.slice(0, cutAt)
}

function pathTouchesBufferLine(logicalLine: LogicalLine, match: TerminalFilePathMatch, bufferLineNumber: number): boolean {
  const start = positionForOffset(logicalLine, match.start)
  const end = positionForOffset(logicalLine, match.end - 1)
  return !!start && !!end && start.y <= bufferLineNumber && end.y >= bufferLineNumber
}

function createFileLink(
  terminal: Terminal,
  logicalLine: LogicalLine,
  match: TerminalFilePathMatch,
  target: TerminalPathTarget,
  options: TerminalFileLinkOptions,
): ILink | null {
  const start = positionForOffset(logicalLine, match.start, terminal.cols)
  const end = positionForOffset(logicalLine, match.end - 1, terminal.cols)
  if (!start || !end) return null

  return {
    range: { start, end },
    text: match.text,
    decorations: { pointerCursor: true, underline: true },
    activate(event) {
      event.preventDefault()
      if (target.isFile) void options.openFile(target.path)
      else void options.openFolder?.(target.path)
    },
  }
}

function positionForOffset(logicalLine: LogicalLine, offset: number, cols = 1): { x: number; y: number } | null {
  for (const part of logicalLine.parts) {
    const end = part.start + part.text.length
    if (offset < part.start || offset >= end) continue
    return {
      x: bufferColumnForTextOffset(part.line, offset - part.start + part.columnOffset, cols),
      y: part.bufferLineNumber,
    }
  }
  return null
}

function bufferColumnForTextOffset(line: IBufferLine, offset: number, cols: number): number {
  let textOffset = 0
  for (let column = 0; column < cols; column += 1) {
    const cell = line.getCell(column)
    if (!cell) break
    const chars = cell.getChars()
    const length = chars.length || (cell.getWidth() === 1 ? 1 : 0)
    if (textOffset + length > offset) return column + 1
    textOffset += length
  }
  return Math.max(1, offset + 1)
}

function pathCandidates(raw: string): string[] {
  const candidates = new Set<string>()
  const add = (value: string) => {
    const path = trimPathSuffix(value)
    if (path.length > 3) candidates.add(path)
  }

  add(raw)
  add(raw.replace(/:\d+(?::\d+)?(?:[),\]}]*)?$/, ''))
  for (const match of raw.matchAll(/\.[A-Za-z0-9_-]{1,16}(?=$|[\s,;:()[\]{}])/g)) {
    add(raw.slice(0, (match.index ?? 0) + match[0].length))
  }
  return [...candidates].sort((left, right) => right.length - left.length)
}

function trimPathSuffix(value: string): string {
  return value.trim()
    .replace(/[),\]}`>,;!?]+$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/\.+$/, '')
    .trimEnd()
}

function normalizeWindowsPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
}
