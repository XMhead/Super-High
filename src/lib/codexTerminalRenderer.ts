import { Terminal } from '@xterm/xterm'

const synchronizedUpdateStart = '\x1b[?2026h'
const synchronizedUpdateEnd = '\x1b[?2026l'

type ScreenSnapshot = {
  bufferType: 'normal' | 'alternate'
  lines: string[]
}

type TerminalWithSynchronousCore = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
  }
}

function writeSynchronously(terminal: Terminal, data: string) {
  const writeSync = (terminal as TerminalWithSynchronousCore)._core?.writeSync
  if (!writeSync) throw new Error('xterm 5.5 synchronous parser is unavailable')
  writeSync.call((terminal as TerminalWithSynchronousCore)._core, data)
}

function trailingMarkerPrefix(value: string): number {
  const maxLength = Math.min(value.length, synchronizedUpdateStart.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(synchronizedUpdateStart.slice(0, length))) return length
  }
  return 0
}

function shiftedLineCount(previous: ScreenSnapshot | null, next: ScreenSnapshot): number {
  if (!previous || previous.bufferType !== 'normal' || next.bufferType !== 'normal') return 0
  if (previous.lines.length !== next.lines.length) return 0

  const rowCount = next.lines.length
  let fixedSuffixRows = 0
  while (
    fixedSuffixRows < rowCount
    && previous.lines[rowCount - fixedSuffixRows - 1] === next.lines[rowCount - fixedSuffixRows - 1]
  ) {
    fixedSuffixRows += 1
  }
  if (fixedSuffixRows < 2) return 0

  const contentRows = rowCount - fixedSuffixRows
  let bestShift = 0
  let bestMatches = 0
  let bestRatio = 0
  for (let shift = 1; shift <= Math.min(24, contentRows - 1); shift += 1) {
    let candidates = 0
    let matches = 0
    for (let row = 0; row < contentRows - shift; row += 1) {
      const previousLine = previous.lines[row + shift].trim()
      const nextLine = next.lines[row].trim()
      if (previousLine || nextLine) candidates += 1
      if (previousLine && previousLine === nextLine) matches += 1
    }
    const ratio = candidates ? matches / candidates : 0
    if (
      matches >= 4
      && ratio >= 0.75
      && (matches > bestMatches || (matches === bestMatches && ratio > bestRatio))
    ) {
      bestShift = shift
      bestMatches = matches
      bestRatio = ratio
    }
  }
  return bestShift
}

export class CodexTerminalRenderer {
  private readonly shadow: Terminal
  private pending = ''
  private previousSnapshot: ScreenSnapshot | null = null

  constructor(cols: number, rows: number, private readonly synthesizeScrollback = true) {
    this.shadow = new Terminal({
      cols,
      rows,
      convertEol: true,
      logLevel: 'off',
      scrollback: 0,
    })
    writeSynchronously(this.shadow, '')
  }

  resize(cols: number, rows: number) {
    if (this.shadow.cols === cols && this.shadow.rows === rows) return
    this.shadow.resize(cols, rows)
    this.previousSnapshot = null
  }

  reset() {
    this.pending = ''
    this.previousSnapshot = null
    this.shadow.reset()
  }

  dispose() {
    this.shadow.dispose()
  }

  get pendingOutputLength(): number {
    return this.pending.length
  }

  flushPending(): string {
    const pending = this.pending
    this.pending = ''
    this.previousSnapshot = null
    return this.processRaw(pending)
  }

  render(data: string): string {
    this.pending += data
    let output = ''

    while (this.pending) {
      const frameStart = this.pending.indexOf(synchronizedUpdateStart)
      if (frameStart === -1) {
        const carryLength = trailingMarkerPrefix(this.pending)
        const readyLength = this.pending.length - carryLength
        output += this.processRaw(this.pending.slice(0, readyLength))
        this.pending = this.pending.slice(readyLength)
        break
      }

      if (frameStart > 0) {
        output += this.processRaw(this.pending.slice(0, frameStart))
        this.pending = this.pending.slice(frameStart)
      }

      const frameEnd = this.pending.indexOf(synchronizedUpdateEnd, synchronizedUpdateStart.length)
      if (frameEnd === -1) break
      const end = frameEnd + synchronizedUpdateEnd.length
      output += this.processFrame(this.pending.slice(0, end))
      this.pending = this.pending.slice(end)
    }

    return output
  }

  private processRaw(data: string): string {
    if (!data) return ''
    writeSynchronously(this.shadow, data)
    return data
  }

  private processFrame(frame: string): string {
    writeSynchronously(this.shadow, frame)
    const nextSnapshot = this.snapshot()
    const shift = this.synthesizeScrollback ? shiftedLineCount(this.previousSnapshot, nextSnapshot) : 0
    this.previousSnapshot = nextSnapshot
    if (!shift) return frame

    const scroll = `\x1b[r\x1b[${this.shadow.rows};1H${'\r\n'.repeat(shift)}\x1b[H`
    return `${scroll}${frame}`
  }

  private snapshot(): ScreenSnapshot {
    const buffer = this.shadow.buffer.active
    return {
      bufferType: buffer.type,
      lines: Array.from({ length: this.shadow.rows }, (_, row) => (
        buffer.getLine(row)?.translateToString(true).trimEnd() ?? ''
      )),
    }
  }
}
