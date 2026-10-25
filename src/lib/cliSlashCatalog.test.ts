import { describe, expect, it, vi } from 'vitest'
import { collectNativeSlashCommands } from './cliSlashCatalog'
import { detectSlashCommandMenu, type TerminalSlashMenu } from './terminalMenu'

describe('native CLI slash command catalog', () => {
  it('loads commands beyond the first viewport and restores the original selection without executing', async () => {
    const registry = Array.from({ length: 43 }, (_, index) => ({ command: `/native-${index}`, description: `Native command ${index}` }))
    let selected = 0
    let published: TerminalSlashMenu['commands'] = []
    const menu = (): TerminalSlashMenu => {
      const start = Math.max(0, Math.min(registry.length - 7, selected - 3))
      return { commands: registry.slice(start, start + 7), selectedCommand: registry[selected]!.command }
    }
    const write = vi.fn(async (key: string) => {
      expect(key).toBe('\u001b[A')
      selected = (selected + registry.length - 1) % registry.length
    })
    expect(await collectNativeSlashCommands(menu(), {
      current: () => true, write, waitForSelection: async () => menu(), update: entries => { published = entries },
    })).toBe(true)
    expect(published.map(entry => entry.command).sort()).toEqual(registry.map(entry => entry.command).sort())
    expect(selected).toBe(0)
    expect(write).toHaveBeenCalledTimes(registry.length)
  })

  it('stops writing when the user edits or changes sessions', async () => {
    let current = true
    const write = vi.fn(async () => { current = false })
    const waitForSelection = vi.fn(async () => null)
    expect(await collectNativeSlashCommands({ commands: [{ command: '/model', description: 'Choose model' }], selectedCommand: '/model' }, {
      current: () => current, write, waitForSelection, update: () => {},
    })).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(waitForSelection).not.toHaveBeenCalled()
  })

  it('does not mark a stalled or ambiguous native menu complete', async () => {
    const initial = { commands: [{ command: '/model', description: 'Choose model' }], selectedCommand: '/model' }
    expect(await collectNativeSlashCommands(initial, {
      current: () => true, write: async () => {}, waitForSelection: async () => null, update: () => {},
    })).toBe(false)
    const write = vi.fn(async () => {})
    expect(await collectNativeSlashCommands({ ...initial, selectedCommand: null }, {
      current: () => true, write, waitForSelection: async () => null, update: () => {},
    })).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('reads the live selection while excluding the echoed slash draft', () => {
    expect(detectSlashCommandMenu([
      { text: '  /model    Choose model', highlighted: false },
      { text: '› /permissions   Choose permissions', highlighted: true },
      { text: '', highlighted: false },
      { text: '› /', highlighted: false },
    ])?.selectedCommand).toBe('/permissions')
    expect(detectSlashCommandMenu([
      { text: '  /model   Choose model', highlighted: true },
      { text: '› /permissions   Choose permissions', highlighted: true },
    ])?.selectedCommand).toBe('/permissions')
  })
})
