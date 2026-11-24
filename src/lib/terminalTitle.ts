import { cliProviderLabel, isCliProviderKind } from './cliProviders'
import type { TerminalSession } from '@/types'

export function terminalSessionTitle(session: TerminalSession): string {
  return session.name?.trim()
    || (isCliProviderKind(session.providerKind)
      ? session.terminalTitle?.trim() || cliProviderLabel(session.providerKind)
      : session.title)
    || '终端'
}

// Read OSC 0/2 from every session's output, even when its xterm is not mounted.
// Keep partial sequences across PTY chunks; never retain arbitrary terminal output.
export class TerminalTitleParser {
  title: string | undefined
  private state: 'text' | 'escape' | 'osc' | 'oscEscape' | 'ignore' | 'ignoreEscape' = 'text'
  private value = ''

  push(chunk: string): string | undefined {
    for (const char of chunk) {
      if (char === '\x18' || char === '\x1a') {
        this.state = 'text'
        this.value = ''
      } else if (this.state === 'ignore' || this.state === 'ignoreEscape') {
        if (char === '\x9c' || (this.state === 'ignoreEscape' && char === '\\')) this.state = 'text'
        else this.state = char === '\x1b' ? 'ignoreEscape' : 'ignore'
      } else if (this.state === 'osc' || this.state === 'oscEscape') {
        if (char === '\x07' || char === '\x9c' || (this.state === 'oscEscape' && char === '\\')) {
          if (/^[02];/.test(this.value)) this.title = this.value.slice(2).trim()
          this.state = 'text'
          this.value = ''
        } else if (char === '\x1b') {
          this.state = 'oscEscape'
        } else if (this.state === 'oscEscape') {
          this.value = ''
          this.escape(char)
        } else if (char >= ' ' && !(char >= '\x7f' && char <= '\x9f')) {
          this.value += char
          // Discard oversized OSCs (for example clipboard payloads), including
          // their remainder, until a terminator or a new escape sequence arrives.
          if (this.value.length > 4096) this.value = 'ignored;'
        }
      } else if (char === '\x1b') {
        this.state = 'escape'
      } else if (char === '\x9d') {
        this.value = ''
        this.state = 'osc'
      } else if (char === '\x90' || char === '\x98' || char === '\x9e' || char === '\x9f') {
        this.state = 'ignore'
      } else if (this.state === 'escape') {
        this.escape(char)
      }
    }
    return this.title
  }

  private escape(char: string) {
    this.state = char === ']' ? 'osc' : ['P', 'X', '^', '_'].includes(char) ? 'ignore' : 'text'
    this.value = ''
  }
}
