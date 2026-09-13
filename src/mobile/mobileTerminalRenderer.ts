import { Terminal, type IBufferCell, type IBufferLine, type IDisposable } from '@xterm/xterm'
import { CodexTerminalRenderer } from '@/lib/codexTerminalRenderer'

export const MOBILE_TERMINAL_FRAME_TIMEOUT_MS = 250
const MAX_PENDING_FRAME_LENGTH = 256 * 1024
const ESC = '\x1b['

type SourceTerminal = Terminal & {
  _core: {
    writeSync(data: string): void
    _bufferService: {
      buffers: { normal: { lines: { onTrim(callback: (amount: number) => void): IDisposable } } }
    }
  }
}

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

function renderLine(line: IBufferLine | undefined, cols: number): string {
  if (!line) return ''
  let length = cols
  while (length > 0) {
    const cell = line.getCell(length - 1)
    if (cell && (cell.getChars().trim() || !cell.isBgDefault() || cell.isInverse()
      || cell.isUnderline() || cell.isStrikethrough())) break
    length -= 1
  }
  if (!length) return ''
  let result = ''
  let style = ''
  // Keep background-colored empty cells and wide-character cell boundaries.
  for (let col = 0; col < length; col += 1) {
    const cell = line.getCell(col)
    if (!cell || cell.getWidth() === 0) continue
    const nextStyle = cellStyle(cell)
    if (style !== nextStyle) { result += nextStyle; style = nextStyle }
    result += cell.getChars() || ' '
  }
  return result + `${ESC}0m`
}

/** Parse at the PTY grid, then paint into an independently tall mobile viewport. */
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

  constructor(cols: number, rows: number, private viewportRows: number, isCodex: boolean) {
    this.source = new Terminal({ cols, rows, scrollback: 4000, convertEol: false, logLevel: 'off' }) as SourceTerminal
    this.frames = new CodexTerminalRenderer(cols, rows, isCodex)
    this.observeHistoryTrimming()
  }

  get hasPendingOutput(): boolean { return this.frames.pendingOutputLength > 0 }

  resizeSource(cols: number, rows: number): void {
    if (this.source.cols === cols && this.source.rows === rows) return
    this.source.resize(cols, rows)
    this.frames.resize(cols, rows)
    this.needsRebuild = true
  }

  resizeViewport(rows: number): void {
    const next = Math.max(1, rows)
    if (next === this.viewportRows) return
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
    const historyEnd = this.trimmedHistory + buffer.baseY
    const commitEnd = alternate ? 0 : Math.max(this.trimmedHistory, historyEnd + this.source.rows - this.viewportRows)
    if (!alternate) {
      // A short viewport also exposes the clipped current-screen rows through
      // scrollback. If those mutable rows change, replace the projection once;
      // never append another copy of the previous prompt/status screen.
      for (const [index, previous] of this.mutableHistory) {
        if (index >= this.trimmedHistory && index < commitEnd
          && previous !== renderLine(buffer.getLine(index - this.trimmedHistory), this.source.cols)) {
          this.needsRebuild = true
          break
        }
      }
      this.mutableHistory.clear()
      for (let index = historyEnd; index < commitEnd; index += 1) {
        this.mutableHistory.set(index, renderLine(buffer.getLine(index - this.trimmedHistory), this.source.cols))
      }
    }
    let output = ''
    if (this.needsRebuild) {
      output = '\x1bc'
      this.committedHistory = this.trimmedHistory
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
        output += '\x1bc'
        this.committedHistory = this.trimmedHistory
        this.painted = []
      }
      for (let index = Math.max(this.committedHistory, this.trimmedHistory); index < commitEnd; index += 1) {
        const line = renderLine(buffer.getLine(index - this.trimmedHistory), this.source.cols)
        output += `${ESC}r${ESC}1;1H${ESC}0m${ESC}2K${line}${ESC}${this.viewportRows};1H\r\n`
      }
      if (commitEnd !== this.committedHistory) this.painted = []
      this.committedHistory = commitEnd
    }

    const sourceTop = buffer.baseY + this.source.rows - this.viewportRows
    for (let row = 0; row < this.viewportRows; row += 1) {
      const sourceRow = sourceTop + row
      const line = renderLine(sourceRow < 0 ? undefined : buffer.getLine(sourceRow), this.source.cols)
      if (this.painted[row] !== line) {
        output += `${ESC}${row + 1};1H${ESC}0m${ESC}2K${line}`
      }
      this.painted[row] = line
    }
    const cursorRow = buffer.cursorY + this.viewportRows - this.source.rows
    output += `${ESC}0m${ESC}?25l`
    if (cursorRow >= 0 && cursorRow < this.viewportRows) output += `${ESC}${cursorRow + 1};${buffer.cursorX + 1}H`
    // Arrow keys, paste framing and focus reports must still match source modes.
    output += `${ESC}?1${this.source.modes.applicationCursorKeysMode ? 'h' : 'l'}`
    output += `${ESC}?2004${this.source.modes.bracketedPasteMode ? 'h' : 'l'}`
    output += `${ESC}?1004${this.source.modes.sendFocusMode ? 'h' : 'l'}`
    return output
  }
}

/** Retain the user's historical viewport across the occasional resize rebuild. */
export async function writeMobileTerminalProjection(terminal: Terminal, output: string): Promise<void> {
  if (!output) return
  const buffer = terminal.buffer.active
  const browsingHistory = buffer.viewportY < buffer.baseY
  const viewportY = buffer.viewportY
  await new Promise<void>(resolve => terminal.write(output, resolve))
  if (browsingHistory && output.includes('\x1bc')) terminal.scrollToLine(viewportY)
}
