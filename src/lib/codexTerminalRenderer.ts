const synchronizedUpdateStart = '\x1b[?2026h'
const synchronizedUpdateEnd = '\x1b[?2026l'

function trailingMarkerPrefix(value: string): number {
  const maxLength = Math.min(value.length, synchronizedUpdateStart.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(synchronizedUpdateStart.slice(0, length))) return length
  }
  return 0
}

/** Keep Codex's synchronized frames intact and let xterm apply its native VT updates. */
export class CodexTerminalRenderer {
  private pending = ''

  constructor(_cols: number, _rows: number) {}

  resize(_cols: number, _rows: number) {}

  reset() {
    this.pending = ''
  }

  dispose() {}

  get pendingOutputLength(): number {
    return this.pending.length
  }

  flushPending(): string {
    const pending = this.pending
    this.pending = ''
    return pending
  }

  render(data: string): string {
    this.pending += data
    let output = ''

    while (this.pending) {
      const frameStart = this.pending.indexOf(synchronizedUpdateStart)
      if (frameStart === -1) {
        const carryLength = trailingMarkerPrefix(this.pending)
        const readyLength = this.pending.length - carryLength
        output += this.pending.slice(0, readyLength)
        this.pending = this.pending.slice(readyLength)
        break
      }

      if (frameStart > 0) {
        output += this.pending.slice(0, frameStart)
        this.pending = this.pending.slice(frameStart)
      }

      const frameEnd = this.pending.indexOf(synchronizedUpdateEnd, synchronizedUpdateStart.length)
      if (frameEnd === -1) break
      const end = frameEnd + synchronizedUpdateEnd.length
      output += this.pending.slice(0, end)
      this.pending = this.pending.slice(end)
    }

    return output
  }
}
