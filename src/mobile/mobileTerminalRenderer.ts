import { Terminal, type IBufferCell, type IBufferLine, type IDisposable } from '@xterm/xterm'
import { CodexTerminalRenderer } from '@/lib/codexTerminalRenderer'

export const MOBILE_TERMINAL_FRAME_TIMEOUT_MS = 250
const MAX_PENDING_FRAME_LENGTH = 256 * 1024
const ESC = '\x1b['
// RIS resets xterm's DOM viewport row height to zero. A queued scroll event can
// then divide by zero and leave viewportY=NaN (an entirely blank terminal).
export const MOBILE_TERMINAL_CLEAR = `${ESC}?1049l${ESC}r${ESC}0m${ESC}2J${ESC}3J${ESC}H`

type SourceTerminal = Terminal & {
  _core: {
    writeSync(data: string): void
    _bufferService: {
      buffers: { normal: { lines: { onTrim(callback: (amount: number) => void): IDisposable } } }
    }
  }
}

export type MobileHistoryCorrection = { rowsBeforeScreen: number; text: string }

function cellStyle(cell: IBufferCell): string {
  const codes: number[] = [0]
  if (cell.isBold()) codes.push(1)
  if (cell.isDim()) codes.push(2)
  if (cell.isItalic()) codes.push(3)
  if (cell.isUnderline()) codes.push(4)
  if (cell.isBlink()) codes.push(5)
  if (cell.isInverse()) codes.push(7)
  if (cell.isInvisible()) codes.push(8)
  if (cell.isStrikethrough()) codes.push(9)
  for (const foreground of [true, false]) {
    const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB()
    const palette = foreground ? cell.isFgPalette() : cell.isBgPalette()
    const value = foreground ? cell.getFgColor() : cell.getBgColor()
    const prefix = foreground ? 38 : 48
    if (rgb) codes.push(prefix, 2, (value >> 16) & 255, (value >> 8) & 255, value & 255)
    else if (palette) codes.push(prefix, 5, value)
  }
  return `${ESC}${codes.join(';')}m`
}

function renderLine(line: IBufferLine | undefined, cols: number, width = cols): string[] {
  if (!line) return ['']
  let length = cols
  while (length > 0) {
    const cell = line.getCell(length - 1)
    if (cell && (cell.getChars().trim() || !cell.isBgDefault() || cell.isInverse()
      || cell.isUnderline() || cell.isStrikethrough())) break
    length -= 1
  }
  if (!length) return ['']
  const rows: string[] = []
  let result = ''
  let style = ''
  let used = 0
  // Keep background-colored empty cells and wide-character cell boundaries.
  for (let col = 0; col < length; col += 1) {
    const cell = line.getCell(col)
    if (!cell || cell.getWidth() === 0) continue
    if (used + cell.getWidth() > width) {
      rows.push(result + `${ESC}0m`)
      result = ''; style = ''; used = 0
    }
    const nextStyle = cellStyle(cell)
    if (style !== nextStyle) { result += nextStyle; style = nextStyle }
    result += cell.getChars() || ' '
    used += cell.getWidth()
  }
  rows.push(result + `${ESC}0m`)
  return rows
}

/** Parse at the PTY grid, then wrap and paint into an independent mobile viewport. */
export class MobileTerminalRenderer {
  private readonly source: SourceTerminal
  private readonly frames: CodexTerminalRenderer
  private trimSubscription: IDisposable | undefined
  private trimmedHistory = 0
  private committedHistory = 0
  private painted: string[] = []
  private paintedType: 'normal' | 'alternate' = 'normal'
  private needsRebuild = true
  private pendingSince: number | undefined
  private mutableHistory = new Map<number, string>()
  private historyCache = new Map<number, string[]>()
  private projectedTrimmed = 0
  private viewportCols: number
  private historyCorrections: MobileHistoryCorrection[] = []

  constructor(cols: number, rows: number, private viewportRows: number, viewportCols = cols, private readonly patchHistory = false) {
    this.viewportCols = viewportCols
    this.source = new Terminal({ cols, rows, scrollback: 4000, convertEol: false, logLevel: 'off' }) as SourceTerminal
    this.frames = new CodexTerminalRenderer(cols, rows)
    this.observeHistoryTrimming()
  }

  get hasPendingOutput(): boolean { return this.frames.pendingOutputLength > 0 }

  takeHistoryCorrections(): MobileHistoryCorrection[] {
    const result = this.historyCorrections
    this.historyCorrections = []
    return result
  }

  resizeSource(cols: number, rows: number): void {
    if (this.source.cols === cols && this.source.rows === rows) return
    this.source.resize(cols, rows)
    this.frames.resize(cols, rows)
    this.historyCache.clear()
    this.projectedTrimmed = 0
    this.historyCorrections = []
    this.needsRebuild = true
  }

  resizeViewport(rows: number, cols = this.viewportCols): void {
    const next = Math.max(1, rows)
    const width = Math.max(2, cols)
    if (next === this.viewportRows && width === this.viewportCols) return
    if (width !== this.viewportCols) {
      this.viewportCols = width
      this.historyCache.clear()
      this.projectedTrimmed = 0
    }
    this.viewportRows = next
    this.needsRebuild = true
  }

  reset(): void {
    this.source.reset()
    this.frames.reset()
    this.trimmedHistory = 0
    this.committedHistory = 0
    this.painted = []
    this.paintedType = 'normal'
    this.needsRebuild = true
    this.pendingSince = undefined
    this.mutableHistory.clear()
    this.historyCache.clear()
    this.projectedTrimmed = 0
    this.historyCorrections = []
    this.observeHistoryTrimming()
  }

  dispose(): void {
    this.trimSubscription?.dispose()
    this.frames.dispose()
    this.source.dispose()
  }

  render(data: string, now = Date.now()): string {
    let ready = this.frames.render(data)
    if (this.hasPendingOutput) {
      this.pendingSince ??= now
      if (this.frames.pendingOutputLength >= MAX_PENDING_FRAME_LENGTH
        || now - this.pendingSince >= MOBILE_TERMINAL_FRAME_TIMEOUT_MS) {
        ready += this.frames.flushPending()
        this.pendingSince = undefined
      }
    } else this.pendingSince = undefined
    if (ready) this.source._core.writeSync(ready)
    if (!ready && !this.needsRebuild) return ''
    return this.project()
  }

  flushPending(): string {
    const ready = this.frames.flushPending()
    this.pendingSince = undefined
    if (!ready) return this.needsRebuild ? this.project() : ''
    this.source._core.writeSync(ready)
    return this.project()
  }

  private observeHistoryTrimming(): void {
    this.trimSubscription?.dispose()
    this.trimSubscription = this.source._core._bufferService.buffers.normal.lines.onTrim(amount => {
      this.trimmedHistory += amount
    })
  }

  private project(): string {
    const buffer = this.source.buffer.active
    const alternate = buffer.type === 'alternate'
    const lines: string[] = []
    for (const [index, rows] of this.historyCache) {
      if (index < this.trimmedHistory) {
        this.projectedTrimmed += rows.length
        this.historyCache.delete(index)
      }
    }
    // Cache immutable scrollback; only parse newly committed and live screen
    // cells each frame. Long conversations must not rescan thousands of rows.
    if (!alternate) for (let row = 0; row < buffer.baseY; row += 1) {
      const index = this.trimmedHistory + row
      let cached = this.historyCache.get(index)
      if (!cached) {
        cached = renderLine(buffer.getLine(row), this.source.cols, this.viewportCols)
        this.historyCache.set(index, cached)
      }
      lines.push(...cached)
    }
    const historyEnd = this.projectedTrimmed + lines.length
    let cursorRow = 0
    let cursorCol = buffer.cursorX
    const screen = Array.from({ length: this.source.rows }, (_, row) =>
      renderLine(buffer.getLine(buffer.baseY + row), this.source.cols, this.viewportCols))
    // A desktop taller than its content must not push the phone prompt off the
    // useful edge with dozens of empty rows below it.
    while (screen.length > buffer.cursorY + 1 && screen.at(-1)?.every(line => !line)) screen.pop()
    for (let row = 0; row < screen.length; row += 1) {
      const projected = screen[row]!
      if (row === buffer.cursorY) {
        cursorRow = lines.length + Math.min(projected.length - 1, Math.floor(buffer.cursorX / this.viewportCols))
        cursorCol = buffer.cursorX % this.viewportCols
      }
      lines.push(...projected)
    }
    const commitEnd = alternate ? 0 : this.projectedTrimmed + Math.max(0, lines.length - this.viewportRows)
    if (!alternate) {
      // A short viewport also exposes the clipped current-screen rows through
      // scrollback. Correct changed cells in place when the consumer supports
      // it; never append another copy of the previous prompt/status screen.
      for (const [index, previous] of this.mutableHistory) {
        if (index >= this.projectedTrimmed && index < commitEnd
          && previous !== lines[index - this.projectedTrimmed]) {
          if (this.patchHistory && !this.needsRebuild) {
            this.historyCorrections.push({
              rowsBeforeScreen: this.committedHistory - index,
              text: lines[index - this.projectedTrimmed] ?? '',
            })
          } else {
            this.needsRebuild = true
            break
          }
        }
      }
      this.mutableHistory.clear()
      for (let index = historyEnd; index < commitEnd; index += 1) {
        this.mutableHistory.set(index, lines[index - this.projectedTrimmed] ?? '')
      }
    }
    let output = ''
    if (this.needsRebuild) {
      this.historyCorrections = []
      output = MOBILE_TERMINAL_CLEAR
      this.committedHistory = this.projectedTrimmed
      this.painted = []
      this.paintedType = 'normal'
      this.needsRebuild = false
    }
    if (buffer.type !== this.paintedType) {
      output += `${ESC}?1049${alternate ? 'h' : 'l'}`
      this.painted = []
      this.paintedType = buffer.type
    }

    // Append each source row once. Fixed prompt/status rows are repainted below,
    // never copied into history merely because another frame arrived.
    if (!alternate) {
      if (commitEnd < this.committedHistory) {
        this.historyCorrections = []
        output += MOBILE_TERMINAL_CLEAR
        this.committedHistory = this.projectedTrimmed
        this.painted = []
      }
      for (let index = Math.max(this.committedHistory, this.projectedTrimmed); index < commitEnd; index += 1) {
        const line = lines[index - this.projectedTrimmed] ?? ''
        output += `${ESC}r${ESC}1;1H${ESC}0m${ESC}2K${line}${ESC}${this.viewportRows};1H\r\n`
      }
      if (commitEnd !== this.committedHistory) this.painted = []
      this.committedHistory = commitEnd
    }

    const sourceTop = lines.length - this.viewportRows
    for (let row = 0; row < this.viewportRows; row += 1) {
      const sourceRow = sourceTop + row
      const line = sourceRow < 0 ? '' : lines[sourceRow] ?? ''
      if (this.painted[row] !== line) {
        output += `${ESC}${row + 1};1H${ESC}0m${ESC}2K${line}`
      }
      this.painted[row] = line
    }
    cursorRow -= sourceTop
    output += `${ESC}0m${ESC}?25l`
    if (cursorRow >= 0 && cursorRow < this.viewportRows) output += `${ESC}${cursorRow + 1};${cursorCol + 1}H`
    // Arrow keys, paste framing and focus reports must still match source modes.
    output += `${ESC}?1${this.source.modes.applicationCursorKeysMode ? 'h' : 'l'}`
    output += `${ESC}?2004${this.source.modes.bracketedPasteMode ? 'h' : 'l'}`
    output += `${ESC}?1004${this.source.modes.sendFocusMode ? 'h' : 'l'}`
    return output
  }
}

/** Retain the user's historical viewport across the occasional resize rebuild. */
const projectionWrites = new WeakMap<Terminal, Promise<void>>()

export async function writeMobileTerminalProjection(terminal: Terminal, output: string, corrections: MobileHistoryCorrection[] = []): Promise<void> {
  if (!output && !corrections.length) { await projectionWrites.get(terminal); return }
  const write = async () => {
    const buffer = terminal.buffer.active
    const browsingHistory = buffer.viewportY < buffer.baseY
    const viewportY = buffer.viewportY
    if (corrections.length) patchHistoricalRows(terminal, corrections)
    if (output) await new Promise<void>(resolve => terminal.write(output, resolve))
    if (browsingHistory && output.includes(MOBILE_TERMINAL_CLEAR)) terminal.scrollToLine(viewportY)
  }
  const pending = (projectionWrites.get(terminal) ?? Promise.resolve()).then(write)
  projectionWrites.set(terminal, pending.catch(() => {}))
  await pending
}

function patchHistoricalRows(terminal: Terminal, corrections: MobileHistoryCorrection[]): void {
  // xterm 5.5 exposes read-only scrollback publicly. Copy parsed buffer cells
  // into the few live rows that moved above the screen, instead of replaying
  // thousands of immutable history lines on every TUI status update.
  type MutableLine = { copyFrom(line: MutableLine): void }
  type BufferTerminal = Terminal & {
    _core: { writeSync(data: string): void; _bufferService: { buffer: { lines: { get(index: number): MutableLine | undefined } } } }
  }
  const parser = new Terminal({ cols: terminal.cols, rows: corrections.length, scrollback: 0, logLevel: 'off' }) as BufferTerminal
  try {
    parser._core.writeSync(corrections.map((patch, row) => `${ESC}${row + 1};1H${ESC}0m${patch.text}`).join(''))
    const target = (terminal as BufferTerminal)._core._bufferService.buffer.lines
    for (let row = 0; row < corrections.length; row += 1) {
      const index = terminal.buffer.active.baseY - corrections[row]!.rowsBeforeScreen
      const source = parser._core._bufferService.buffer.lines.get(row)
      if (index >= 0 && source) target.get(index)?.copyFrom(source)
    }
    terminal.refresh(0, terminal.rows - 1)
  } finally { parser.dispose() }
}
