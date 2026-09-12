import { getTheme } from './theme'

const ANSI_COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

function rgb(hex: string): number[] {
  const normalized = hex.replace('#', '')
  const expanded = normalized.length === 3 || normalized.length === 4
    ? normalized.slice(0, 3).split('').map(char => char + char).join('')
    : normalized.slice(0, 6)
  const value = Number.parseInt(expanded, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function isDarkNeutral(color: number[]): boolean {
  return Math.max(...color) <= 128 && Math.max(...color) - Math.min(...color) <= 32
}

function indexedColor(index: number, theme: ReturnType<typeof getTheme>): number[] {
  if (index < 16) return rgb(theme.terminal[ANSI_COLORS[index]])
  if (index >= 232) return Array(3).fill(8 + (index - 232) * 10)
  const cube = index - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return [levels[Math.floor(cube / 36)], levels[Math.floor(cube / 6) % 6], levels[cube % 6]]
}

function adaptSgr(sequence: string, theme: ReturnType<typeof getTheme>): string {
  if (theme.type !== 'light' || !sequence.endsWith('m')) return sequence
  const prefix = sequence.startsWith('\x1b[') ? '\x1b[' : '\x9b'
  const body = sequence.slice(prefix.length, -1)
  // Preserve colon subparameters and unrecognized syntax without interpreting RGB values as SGR codes.
  if (!/^[\d;]*$/.test(body)) return sequence
  const params = body.split(';')
  const result: string[] = []
  const replacement = `48;2;${rgb(theme.colors.bg.secondary).join(';')}`
  for (let index = 0; index < params.length; index++) {
    const code = Number(params[index])
    if (code === 38 || code === 48 || code === 58) {
      const mode = params[index + 1]
      const count = mode === '2' ? 3 : mode === '5' ? 1 : 0
      const values = params.slice(index + 2, index + 2 + count)
      if (!count || values.length !== count || values.some(value => !/^\d+$/.test(value) || Number(value) > 255)) {
        return sequence
      }
      const color = mode === '2' ? values.map(Number) : indexedColor(Number(values[0]), theme)
      result.push(code === 48 && isDarkNeutral(color)
        ? replacement
        : params.slice(index, index + 2 + count).join(';'))
      index += count + 1
    } else {
      result.push(code === 40 || code === 100 ? replacement : params[index])
    }
  }
  return `${prefix}${result.join(';')}m`
}

/** One adapter per terminal stream; reset before replaying raw history or starting a new session. */
export class TerminalColorAdapter {
  private state: 'text' | 'escape' | 'csi' | 'csiPass' | 'string' | 'stringEscape' = 'text'
  private pending = ''
  private osc = false

  reset(): void {
    this.state = 'text'
    this.pending = ''
    this.osc = false
  }

  transform(data: string, themeId: string): string {
    const theme = getTheme(themeId)
    let output = ''
    for (const char of data) {
      if (this.state === 'string' || this.state === 'stringEscape') {
        output += char
        if (char === '\x9c' || char === '\x18' || char === '\x1a' || (this.osc && char === '\x07')
          || (this.state === 'stringEscape' && char === '\\')) {
          this.state = 'text'
        } else {
          this.state = char === '\x1b' ? 'stringEscape' : 'string'
        }
        continue
      }
      if (this.state === 'csi' || this.state === 'csiPass') {
        if (char === '\x1b') {
          output += this.pending
          this.pending = char
          this.state = 'escape'
          continue
        }
        if (this.state === 'csiPass') output += char
        else this.pending += char
        if (char >= '@' && char <= '~') {
          output += adaptSgr(this.pending, theme)
          this.pending = ''
          this.state = 'text'
        } else if (char === '\x18' || char === '\x1a') {
          output += this.pending
          this.pending = ''
          this.state = 'text'
        } else if (this.pending.length > 4096) {
          output += this.pending
          this.pending = ''
          this.state = 'csiPass'
        }
        continue
      }
      if (this.state === 'escape') {
        if (char === '[') {
          this.pending += char
          this.state = 'csi'
          continue
        }
        output += this.pending
        this.pending = ''
        this.state = 'text'
        if (']PX^_'.includes(char)) {
          output += char
          this.osc = char === ']'
          this.state = 'string'
          continue
        }
      }
      if (char === '\x1b') {
        this.pending = char
        this.state = 'escape'
      } else if (char === '\x9b') {
        this.pending = char
        this.state = 'csi'
      } else {
        output += char
        if ('\x90\x98\x9d\x9e\x9f'.includes(char)) {
          this.osc = char === '\x9d'
          this.state = 'string'
        }
      }
    }
    return output
  }
}
