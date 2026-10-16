import { describe, expect, it } from 'vitest'
import { detectTerminalMenu } from './terminalMenu'

const lines = (...rows: string[]) => rows.map(text => ({ text, highlighted: false }))

describe('terminal menu detection', () => {
  it('reads a Claude permission prompt with its marker and inline hint', () => {
    const menu = detectTerminalMenu(lines(' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again', '   3. No, and tell Claude what to do differently (esc)'))
    expect(menu?.selectedIndex).toBe(0)
    expect(menu?.options.map(option => option.number)).toEqual([1, 2, 3])
  })
  it('ignores numbered prose without a selection or key hint', () => {
    expect(detectTerminalMenu(lines('1. install deps', '2. run build', '› ask anything'))).toBeNull()
    expect(detectTerminalMenu(lines('› 1. install deps', '  2. run build'))).toBeNull()
  })
  it('uses the last menu and marks checkbox lists', () => {
    const menu = detectTerminalMenu(lines('1. old', '2. older', '', '  1. [x] Lint', '❯ 2. [ ] Test', '  3. Submit', 'Enter to toggle · Esc to cancel'))
    expect(menu?.selectedIndex).toBe(1)
    expect(menu?.multi).toBe(true)
    expect(menu?.options[2]?.checkbox).toBe(false)
  })
})
