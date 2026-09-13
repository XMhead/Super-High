import { describe, expect, it } from 'vitest'
import { THEMES } from './theme'
import { TerminalColorAdapter } from './terminalColors'

const replacement = '48;2;246;248;250'
const codexInput = '\x1b[48;2;41;41;41m› 测试输入\x1b[0m'
const adaptedInput = `\x1b[${replacement}m› 测试输入\x1b[0m`

describe('TerminalColorAdapter', () => {
  it('uses each light theme surface for the Codex input background', () => {
    for (const theme of Object.values(THEMES)) {
      const output = new TerminalColorAdapter().transform(codexInput, theme.id)
      if (theme.type === 'dark') {
        expect(output).toBe(codexInput)
      } else {
        const hex = theme.colors.bg.secondary.slice(1)
        const color = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)).join(';')
        expect(output).toBe(`\x1b[48;2;${color}m› 测试输入\x1b[0m`)
      }
    }
  })

  it('preserves foreground, underline colors, attributes and semantic backgrounds', () => {
    const original = '\x1b[1;38;2;40;48;100;58;5;40;48;2;128;0;0;4merror\x1b[49;39m'
    expect(new TerminalColorAdapter().transform(original, 'light')).toBe(original)
    expect(new TerminalColorAdapter().transform('\x1b[2;40;38;5;100mtext', 'light'))
      .toBe(`\x1b[2;${replacement};38;5;100mtext`)
  })

  it('adapts ANSI black and bright black, indexed grays and the xterm cube', () => {
    for (const background of ['40', '100', '48;5;0', '48;5;8', '48;5;16', '48;5;59', '48;5;232', '48;5;244']) {
      expect(new TerminalColorAdapter().transform(`\x1b[${background}m`, 'light')).toBe(`\x1b[${replacement}m`)
    }
    for (const background of ['41', '101', '48;5;1', '48;5;88', '48;5;245', '48;5;255', '48;2;129;129;129', '48;2;40;40;73']) {
      expect(new TerminalColorAdapter().transform(`\x1b[${background}m`, 'light')).toBe(`\x1b[${background}m`)
    }
    expect(new TerminalColorAdapter().transform('\x1b[48;2;96;128;96m', 'light')).toBe(`\x1b[${replacement}m`)
  })

  it('handles every chunk boundary, including an isolated ESC', () => {
    for (let split = 0; split <= codexInput.length; split++) {
      const adapter = new TerminalColorAdapter()
      expect(adapter.transform(codexInput.slice(0, split), 'light') + adapter.transform(codexInput.slice(split), 'light'))
        .toBe(adaptedInput)
    }
    const adapter = new TerminalColorAdapter()
    expect([...codexInput].map(char => adapter.transform(char, 'light')).join('')).toBe(adaptedInput)
  })

  it('does not interpret SGR-looking data inside OSC, DCS, SOS, PM or APC', () => {
    for (const start of ['\x1b]', '\x1bP', '\x1bX', '\x1b^', '\x1b_', '\x9d', '\x90', '\x98', '\x9e', '\x9f']) {
      const protectedData = `${start}title;${codexInput}\x1b\\`
      const source = protectedData + codexInput
      const adapter = new TerminalColorAdapter()
      expect([...source].map(char => adapter.transform(char, 'light')).join('')).toBe(protectedData + adaptedInput)
    }
    const osc = `\x1b]0;${codexInput}\x07`
    expect(new TerminalColorAdapter().transform(osc + codexInput, 'light')).toBe(osc + adaptedInput)
    const dcs = `\x1bPpayload\x07${codexInput}\x9c`
    expect(new TerminalColorAdapter().transform(dcs + codexInput, 'light')).toBe(dcs + adaptedInput)
  })

  it('preserves colon syntax, malformed colors and non-SGR control sequences', () => {
    for (const sequence of ['\x1b[48:2::41:41:41m', '\x1b[48:5:232m', '\x1b[48;2;41m', '\x1b[48;2;999;40;40m', '\x1b[48;5;m', '\x1b[48;6;40m', '\x1b[?40m', '\x1b[40H', '\x1b[2J', '\x1b(B']) {
      expect(new TerminalColorAdapter().transform(sequence, 'light')).toBe(sequence)
    }
  })

  it('handles C1 CSI, canceled sequences and bounded incomplete parameters', () => {
    expect(new TerminalColorAdapter().transform('\x9b40m', 'light')).toBe(`\x9b${replacement}m`)
    for (const cancel of ['\x18', '\x1a', '\x1b']) {
      const source = `\x1b[48;2;${cancel}${codexInput}`
      expect(new TerminalColorAdapter().transform(source, 'light')).toBe(`\x1b[48;2;${cancel}${adaptedInput}`)
    }
    const longSequence = `\x1b[${'0;'.repeat(3000)}40m`
    expect(new TerminalColorAdapter().transform(longSequence + codexInput, 'light')).toBe(longSequence + adaptedInput)
  })

  it('resets parser state before raw history replay and applies the current theme', () => {
    const adapter = new TerminalColorAdapter()
    expect(adapter.transform('\x1b[48;2;', 'light')).toBe('')
    adapter.reset()
    expect(adapter.transform(codexInput, 'dark')).toBe(codexInput)
    expect(adapter.transform(codexInput, 'light')).toBe(adaptedInput)
    adapter.transform('\x1b]title', 'light')
    adapter.reset()
    expect(adapter.transform(codexInput, 'light')).toBe(adaptedInput)
  })

  it('reads short hex theme surfaces and palette colors', () => {
    THEMES['test-short-hex'] = {
      ...THEMES.light,
      colors: { ...THEMES.light.colors, bg: { ...THEMES.light.colors.bg, secondary: '#eee' } },
      terminal: { ...THEMES.light.terminal, white: '#444', brightWhite: '#fff' },
    }
    try {
      expect(new TerminalColorAdapter().transform('\x1b[48;5;7m', 'test-short-hex')).toBe('\x1b[48;2;238;238;238m')
      expect(new TerminalColorAdapter().transform('\x1b[48;5;15m', 'test-short-hex')).toBe('\x1b[48;5;15m')
    } finally {
      delete THEMES['test-short-hex']
    }
  })
})
