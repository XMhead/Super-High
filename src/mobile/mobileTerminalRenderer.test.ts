// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { MobileTerminalRenderer, writeMobileTerminalProjection, MOBILE_TERMINAL_CLEAR } from './mobileTerminalRenderer'

const begin = '\x1b[?2026h'
const end = '\x1b[?2026l'
type SyncTerminal = Terminal & { _core: { writeSync(data: string): void } }
function apply(terminal: Terminal, output: string) { (terminal as SyncTerminal)._core.writeSync(output) }
function repaint(lines: string[]) {
  return `${begin}\x1b[H${lines.map((line, row) => `\x1b[${row + 1};1H\x1b[2K${line}`).join('')}${end}`
}
function contents(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) || '')
}
function pair(sourceRows: number, viewportRows: number, codex = false) {
  const terminal = new Terminal({ cols: 40, rows: viewportRows, scrollback: 4000, logLevel: 'off' })
  // An unopened browser xterm has no DOM Viewport. Route its public scroll call
  // into the real buffer service, as the browser Viewport normally does.
  terminal.scrollToLine = line => {
    const core = (terminal as unknown as { _core: { _bufferService: { scrollLines(amount: number): void } } })._core
    core._bufferService.scrollLines(line - terminal.buffer.active.viewportY)
  }
  return {
    renderer: new MobileTerminalRenderer(40, sourceRows, viewportRows, codex),
    terminal,
  }
}

describe('mobile terminal source-grid projection', () => {
  it('wraps desktop-width output on the phone without changing the parser grid or splitting wide cells', () => {
    const renderer = new MobileTerminalRenderer(120, 4, 6, false, 80)
    const terminal = new Terminal({ cols: 80, rows: 6, logLevel: 'off' })
    const text = 'a'.repeat(79) + '你好' + 'b'.repeat(30)
    const projected = renderer.render(`\x1b[31m${text}\r\n› prompt`)
    expect(projected).not.toContain('\x1bc')
    expect(projected).toContain(MOBILE_TERMINAL_CLEAR)
    apply(terminal, projected)
    const lines = contents(terminal).filter(Boolean)
    expect(lines).toEqual(['a'.repeat(79), '你好' + 'b'.repeat(30), '› prompt'])
    const chineseRow = terminal.buffer.active.getLine(4)!
    expect(chineseRow.getCell(0)?.getWidth()).toBe(2)
    expect(chineseRow.getCell(0)?.getFgColor()).toBe(1)
    apply(terminal, renderer.render('\x1b[1;81HX'))
    expect(contents(terminal).join('')).toContain('X')
    renderer.dispose(); terminal.dispose()
  })

  it('reflows retained history on phone rotation and keeps the prompt at the bottom of unused desktop rows', () => {
    const renderer = new MobileTerminalRenderer(120, 20, 8, false, 80)
    const terminal = new Terminal({ cols: 80, rows: 8, logLevel: 'off' })
    apply(terminal, renderer.render('a'.repeat(110) + '\r\n› prompt'))
    expect(contents(terminal).at(-1)).toBe('› prompt')
    expect(contents(terminal).filter(Boolean)).toEqual(['a'.repeat(80), 'a'.repeat(30), '› prompt'])
    terminal.resize(60, 8)
    renderer.resizeViewport(8, 60)
    apply(terminal, renderer.render(''))
    expect(contents(terminal).filter(Boolean)).toEqual(['a'.repeat(60), 'a'.repeat(50), '› prompt'])
    renderer.dispose(); terminal.dispose()
  })

  it('replaces wrapped live rows above a short phone viewport without duplicating fixed prompts', () => {
    const renderer = new MobileTerminalRenderer(120, 4, 3, false, 80)
    const terminal = new Terminal({ cols: 80, rows: 3, scrollback: 4000, logLevel: 'off' })
    for (let frame = 0; frame < 20; frame += 1) {
      apply(terminal, renderer.render(repaint([
        `${frame}:` + 'a'.repeat(100), 'b'.repeat(100), '› prompt', 'status',
      ])))
    }
    const lines = contents(terminal).filter(Boolean)
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('19:' + 'a'.repeat(77))
    expect(lines.filter(line => line === '› prompt')).toHaveLength(1)
    expect(lines.at(-1)).toBe('status')
    renderer.dispose(); terminal.dispose()
  })

  it('patches clipped live rows without replaying a long history and preserves colored wide cells', async () => {
    const renderer = new MobileTerminalRenderer(120, 4, 3, false, 80, true)
    const terminal = new Terminal({ cols: 80, rows: 3, scrollback: 4000, logLevel: 'off' })
    terminal.refresh = () => {}
    const paint = async (data: string) => {
      const output = renderer.render(data)
      await writeMobileTerminalProjection(terminal, output, renderer.takeHistoryCorrections())
      return output
    }
    await paint(Array.from({ length: 1000 }, (_, row) => `history ${row}\r\n`).join(''))
    await paint(repaint(['a'.repeat(100), 'b'.repeat(100), '› prompt', 'status']))
    const before = contents(terminal)
    const update = await paint(repaint(['\x1b[31m你好' + 'z'.repeat(90), 'b'.repeat(100), '› prompt', 'status']))
    expect(update).not.toContain(MOBILE_TERMINAL_CLEAR)
    expect(update.length).toBeLessThan(1000)
    const after = contents(terminal)
    expect(after.length).toBe(before.length)
    expect(after.slice(0, -6)).toEqual(before.slice(0, -6))
    expect(after.at(-6)).toBe('你好' + 'z'.repeat(76))
    const patched = terminal.buffer.active.getLine(terminal.buffer.active.length - 6)!
    expect(patched.getCell(0)?.getWidth()).toBe(2)
    expect(patched.getCell(0)?.getFgColor()).toBe(1)
    expect(after.filter(line => line === '› prompt')).toHaveLength(1)
    renderer.dispose(); terminal.dispose()
  })

  it('fills a taller viewport from actual source history without duplicating fixed status', () => {
    const { renderer, terminal } = pair(8, 12, true)
    for (let first = 1; first <= 7; first += 1) {
      apply(terminal, renderer.render(repaint([
        ...Array.from({ length: 6 }, (_, row) => String(first + row)), '› prompt', 'gpt-6-astra',
      ])))
    }
    expect(contents(terminal)).toEqual([
      ...Array.from({ length: 12 }, (_, row) => String(row + 1)), '› prompt', 'gpt-6-astra',
    ])
    expect(terminal.buffer.active.baseY).toBe(2)
    apply(terminal, renderer.render(repaint(['7', '8', '9', '10', '11', '12', '› prompt', 'gpt-5.6-sol'])))
    expect(contents(terminal).filter(line => line.includes('gpt-'))).toEqual(['gpt-5.6-sol'])
    renderer.dispose(); terminal.dispose()
  })

  it('makes clipped source rows scrollable in a short viewport and replaces changed rows once', async () => {
    const { renderer, terminal } = pair(8, 4)
    apply(terminal, renderer.render(repaint(['1', '2', '3', '4', '5', '6', '› prompt', 'gpt-6-astra'])))
    expect(contents(terminal)).toEqual(['1', '2', '3', '4', '5', '6', '› prompt', 'gpt-6-astra'])
    terminal.scrollToLine(1)
    const update = renderer.render(repaint(['changed', '2', '3', '4', '5', '6', '› prompt', 'gpt-5.6-sol']))
    await writeMobileTerminalProjection(terminal, update)
    expect(terminal.buffer.active.viewportY).toBe(1)
    expect(contents(terminal)).toEqual(['changed', '2', '3', '4', '5', '6', '› prompt', 'gpt-5.6-sol'])
    renderer.dispose(); terminal.dispose()
  })

  it('appends ordinary terminal history once and preserves historical viewport while output arrives', async () => {
    const { renderer, terminal } = pair(4, 7)
    apply(terminal, renderer.render(Array.from({ length: 12 }, (_, row) => String(row + 1)).join('\r\n')))
    expect(contents(terminal)).toEqual(Array.from({ length: 12 }, (_, row) => String(row + 1)))
    terminal.scrollToLine(1)
    await writeMobileTerminalProjection(terminal, renderer.render('\r\n13\r\n14'))
    expect(terminal.buffer.active.viewportY).toBe(1)
    expect(contents(terminal)).toEqual(Array.from({ length: 14 }, (_, row) => String(row + 1)))
    renderer.dispose(); terminal.dispose()
  })

  it('assembles DEC 2026 frames across every chunk boundary before showing model changes', () => {
    const frame = repaint(['first', 'second', 'prompt', 'gpt-6-astra'])
    for (let split = 1; split < frame.length; split += 1) {
      const { renderer, terminal } = pair(4, 6, true)
      apply(terminal, renderer.render(frame.slice(0, split), 0))
      expect(contents(terminal).join('')).not.toContain('gpt-6-astra')
      apply(terminal, renderer.render(frame.slice(split), 1))
      expect(contents(terminal).filter(Boolean)).toEqual(['first', 'second', 'prompt', 'gpt-6-astra'])
      renderer.dispose(); terminal.dispose()
    }
  })

  it('flushes an abnormal unclosed frame by age and supports explicit timer flush', () => {
    const { renderer, terminal } = pair(4, 4)
    apply(terminal, renderer.render(`${begin}\x1b[Hstill running`, 0))
    expect(renderer.hasPendingOutput).toBe(true)
    expect(contents(terminal).join('')).not.toContain('still running')
    apply(terminal, renderer.render('', 250))
    expect(contents(terminal).at(-1)).toBe('still running')
    expect(renderer.hasPendingOutput).toBe(false)
    apply(terminal, renderer.render(`${begin}\x1b[2;1Hsecond`, 300))
    apply(terminal, renderer.flushPending())
    expect(contents(terminal).at(-1)).toBe('second')
    renderer.dispose(); terminal.dispose()
  })

  it('retains colors, background cells and wide characters while clearing shorter replacement text', () => {
    const { renderer, terminal } = pair(4, 4)
    apply(terminal, renderer.render('\x1b[38;2;12;34;56m你好\x1b[0m gpt-6-astra\x1b[48;5;24m   '))
    expect(terminal.buffer.active.getLine(3)?.getCell(0)?.getFgColor()).toBe(0x0c2238)
    expect(terminal.buffer.active.getLine(3)?.getCell(0)?.getWidth()).toBe(2)
    expect(terminal.buffer.active.getLine(3)?.getCell(16)?.getBgColor()).toBe(24)
    apply(terminal, renderer.render('\x1b[H\x1b[0m\x1b[2Kgpt-5.6-sol'))
    expect(contents(terminal).at(-1)).toBe('gpt-5.6-sol')
    renderer.dispose(); terminal.dispose()
  })

  it('reprojects after source and viewport resize and keeps alternate overlays out of normal history', () => {
    const { renderer, terminal } = pair(4, 6)
    apply(terminal, renderer.render('one\r\ntwo\r\nthree\r\nfour\r\nfive'))
    apply(terminal, renderer.render('\x1b[?1049h\x1b[Hoverlay'))
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(contents(terminal).filter(Boolean)).toEqual(['overlay'])
    apply(terminal, renderer.render('\x1b[?1049l'))
    expect(terminal.buffer.active.type).toBe('normal')
    expect(contents(terminal).join('')).not.toContain('overlay')
    renderer.resizeSource(30, 3)
    renderer.resizeViewport(8)
    terminal.resize(30, 8)
    apply(terminal, renderer.render(''))
    expect(contents(terminal).filter(Boolean)).toEqual(['one', 'two', 'three', 'four', 'five'])
    renderer.resizeSource(30, 6)
    renderer.resizeViewport(10)
    terminal.resize(30, 10)
    apply(terminal, renderer.render(''))
    expect(contents(terminal).filter(Boolean)).toEqual(['one', 'two', 'three', 'four', 'five'])
    renderer.dispose(); terminal.dispose()
  })

  it('keeps history ordered after source ring-buffer eviction and leaves native scroll anchoring intact', async () => {
    const { renderer, terminal } = pair(4, 7)
    apply(terminal, renderer.render(Array.from({ length: 4050 }, (_, row) => String(row + 1)).join('\r\n')))
    const before = contents(terminal).filter(Boolean).map(Number)
    expect(before.at(-1)).toBe(4050)
    expect(new Set(before).size).toBe(before.length)
    terminal.scrollToLine(50)
    const anchor = terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)
    await writeMobileTerminalProjection(terminal, renderer.render(Array.from({ length: 10 }, (_, row) => `\r\n${4051 + row}`).join('')))
    const after = contents(terminal).filter(Boolean).map(Number)
    expect(after.at(-1)).toBe(4060)
    expect(after.every((value, index) => index === 0 || value === after[index - 1]! + 1)).toBe(true)
    expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe(anchor)
    renderer.dispose(); terminal.dispose()
  })
})
