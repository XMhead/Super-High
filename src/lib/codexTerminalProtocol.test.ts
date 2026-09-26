// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'

import { CodexTerminalRenderer } from './codexTerminalRenderer'

const synchronizedUpdateStart = '\x1b[?2026h'
const synchronizedUpdateEnd = '\x1b[?2026l'

type TerminalWithSynchronousCore = Terminal & {
  _core: { writeSync: (data: string) => void }
}

function writeTerminalSync(terminal: Terminal, data: string) {
  const core = (terminal as TerminalWithSynchronousCore)._core
  core.writeSync.call(core, data)
}

function repaint(lines: string[]): string {
  const body = lines.map((line, index) => (
    `\x1b[K${line}${index === lines.length - 1 ? '' : '\r\n'}`
  )).join('')
  return `${synchronizedUpdateStart}\x1b[H${body}${synchronizedUpdateEnd}`
}

function writeTerminal(terminal: Terminal, data: string) {
  return new Promise<void>((resolve) => terminal.write(data, resolve))
}

describe('Codex terminal protocol', () => {
  it('keeps upstream inline history in the normal xterm scrollback', async () => {
    const renderer = new CodexTerminalRenderer(80, 24)
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 100 })
    const upstreamHistory = `${synchronizedUpdateStart}\x1b[1;20r\x1b[20;1H\r\nfinalized transcript\x1b[r${synchronizedUpdateEnd}`

    await writeTerminal(terminal, renderer.render(upstreamHistory))

    expect(terminal.buffer.active.type).toBe('normal')
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0)

    renderer.dispose()
    terminal.dispose()
  })

  it('preserves Codex overlay transitions between normal and alternate buffers', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 100 })
    await writeTerminal(terminal, 'normal history\r\n')

    await writeTerminal(terminal, '\x1b[?1049h\x1b[?1007hoverlay')
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.buffer.active.baseY).toBe(0)

    await writeTerminal(terminal, '\x1b[?1007l\x1b[?1049l')
    expect(terminal.buffer.active.type).toBe('normal')

    terminal.dispose()
  })

  it('passes Codex synchronized frame diffs through without inventing scrollback', () => {
    const renderer = new CodexTerminalRenderer(40, 8)
    const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 100, logLevel: 'off' })
    const firstFrame = repaint(['1', '2', '3', '4', '5', '6', '› prompt', 'status'])
    const secondFrame = repaint(['2', '3', '4', '5', '6', '7', '› prompt', 'status'])

    expect(renderer.render(firstFrame)).toBe(firstFrame)
    expect(renderer.render(secondFrame)).toBe(secondFrame)
    writeTerminalSync(terminal, firstFrame + secondFrame)

    expect(terminal.buffer.active.type).toBe('normal')
    expect(terminal.buffer.active.baseY).toBe(0)
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('2')
    expect(terminal.buffer.active.getLine(5)?.translateToString(true)).toBe('7')

    renderer.dispose()
    terminal.dispose()
  })

  it('detects synchronized repaint frames across every output chunk boundary', () => {
    const input = repaint(['1', '2', '3', '4', '5', '6', '› prompt', 'status'])
      + repaint(['2', '3', '4', '5', '6', '7', '› prompt', 'status'])
    const completeRenderer = new CodexTerminalRenderer(40, 8)
    const expected = completeRenderer.render(input)
    completeRenderer.dispose()

    for (let split = 1; split < input.length; split += 1) {
      const renderer = new CodexTerminalRenderer(40, 8)
      const output = renderer.render(input.slice(0, split)) + renderer.render(input.slice(split))
      expect(output, `split at byte ${split}`).toBe(expected)
      renderer.dispose()
    }
  })

  it('does not synthesize scrollback while Codex is in an alternate-screen overlay', () => {
    const renderer = new CodexTerminalRenderer(40, 8)
    renderer.render(repaint(['1', '2', '3', '4', '5', '6', '› prompt', 'status']))
    const enterOverlay = `${synchronizedUpdateStart}\x1b[?1049h\x1b[Hoverlay${synchronizedUpdateEnd}`
    const overlayUpdate = repaint(['2', '3', '4', '5', '6', '7', 'overlay', 'status'])

    expect(renderer.render(enterOverlay)).toBe(enterOverlay)
    expect(renderer.render(overlayUpdate)).toBe(overlayUpdate)

    renderer.dispose()
  })
})
