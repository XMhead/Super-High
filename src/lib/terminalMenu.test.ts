import { describe, expect, it } from 'vitest'
import { detectSlashCommands, detectTerminalMenu, hasNativeTerminalPanel, terminalChatActivity, terminalQuestionQueue, terminalScreenLines } from './terminalMenu'

const lines = (...rows: string[]) => rows.map(text => ({ text, highlighted: false }))

describe('terminal menu detection', () => {
  it('opens the async queue using its displayed shortcut rather than a chat message', () => {
    expect(terminalQuestionQueue(lines('• Queued follow-up inputs', '  ? 1 question', '    shift+← to answer')))
      .toEqual({ shortcut: 'shift+←', key: '\u001b[1;2D' })
    expect(terminalQuestionQueue(lines('shift+← to answer'))).toBeNull()
    expect(terminalQuestionQueue(lines('• Queued follow-up inputs', 'ordinary input'))).toBeNull()
  })
  it.each([
    ['Queued follow-up inputs', 'Choose a colour', '› 1. Blue', '  2. Green', '  3. Other', 'enter submit   ctrl+] skip   shift+→ main prompt'],
    ['Choose a colour', 'Other: custom text', 'enter submit   ctrl+] skip   shift+→ main prompt'],
    ['Question 1/2', '› 1. Blue', '  2. Green', 'Tab to add notes · Enter to select · Esc to cancel'],
    ['Question 1/2 (2 unanswered)', 'Additional notes: custom text', 'tab to pick option | enter to submit answer | ←/→ to navigate questions | esc to interrupt'],
    ['Question 2/2 (1 unanswered)', '› plan-detail-1030', 'esc to clear notes | enter to submit all'],
    ['Choose checks', '› 1. [x] Lint', '  2. [ ] Test', '  3. Submit', 'Enter to toggle · Esc to cancel'],
  ])('preserves the complete native question form: %j', (...rows) => {
    expect(hasNativeTerminalPanel(lines(...rows))).toBe(true)
    expect(terminalChatActivity(lines(...rows))).not.toBe('idle')
  })
  it('preserves numbered rows when a CLI repaint leaves stale wrap flags', () => {
    const rows = ['Select Model and Effort', '› 1. GPT-6.1-Sol (current)  Workhorse', '  2. GPT-6-Astra  Frontier', 'Enter to select · Esc to cancel']
    const screen = terminalScreenLines({ rows: rows.length, buffer: { active: { baseY: 0, getLine: (index: number) => ({
      isWrapped: index > 0, translateToString: () => rows[index], getCell: () => undefined,
    }) } } } as unknown as Parameters<typeof terminalScreenLines>[0])
    expect(detectTerminalMenu(screen)?.options.map(option => option.label)).toEqual(['GPT-6.1-Sol (current)', 'GPT-6-Astra'])
  })
  it('keeps ordinary Claude permission footers in chat while preserving native tabs', () => {
    const footer = lines('Claude Opus 5.5 · API Usage Billing', '❯', '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')
    expect(hasNativeTerminalPanel(footer)).toBe(false)
    expect(terminalChatActivity(footer)).toBe('idle')
    expect(hasNativeTerminalPanel(lines('Settings  Status  Config', 'Tab to cycle · Esc to close'))).toBe(true)
  })
  it('keeps every Claude command when descriptions wrap across physical rows', () => {
    expect(detectSlashCommands(lines(
      '❯ * /Agent-Updater – Update instructions',
      '  /superhigh-workspace-config   Workspace settings and',
      '                                  CLI configuration',
      '  /update-config                Configure the harness',
      '                                  with settings.json',
      '', '❯ /',
    ))).toEqual([
      { command: '/Agent-Updater', description: '– Update instructions' },
      { command: '/superhigh-workspace-config', description: 'Workspace settings and CLI configuration' },
      { command: '/update-config', description: 'Configure the harness with settings.json' },
    ])
  })
  it('distinguishes an idle editor from a running task or a selection menu', () => {
    expect(terminalChatActivity(lines('❯ hello', 'esc to interrupt'))).toBe('busy')
    expect(terminalChatActivity(lines('❯ hello'))).toBe('idle')
    expect(terminalChatActivity(lines('❯ 1. Yes', '  2. No', 'Enter to select'))).toBe('unknown')
    expect(terminalChatActivity(lines('loading'))).toBe('unknown')
    expect(terminalChatActivity(lines('Settings  Status', 'Esc to cancel'))).toBe('unknown')
    expect(hasNativeTerminalPanel(lines('Settings  Status', 'Esc to cancel'))).toBe(true)
    expect(hasNativeTerminalPanel(lines('❯ 1. Yes', '  2. No', 'Esc to cancel'))).toBe(false)
  })
  it('ignores an old cursor marker farther left than the live model cursor', () => {
    const menu = detectTerminalMenu(lines('     1. Default  Use default model', '❯    2. Fable  Custom Fable model', '   ❯ 3. Claude Opus 5.5[1M] ✔  Custom model', 'Enter to set as default · Esc to cancel'))
    expect(menu?.selectedIndex).toBe(2)
  })
  it('prefers the cursor marker when the terminal theme gives every row a background', () => {
    const menu = detectTerminalMenu(['  1. Default (recommended)  Use the default', '❯ 2. Claude Haiku 5.5  Custom model', 'Enter to set as default · Esc to cancel'].map(text => ({ text, highlighted: true })))
    expect(menu?.selectedIndex).toBe(1)
    expect(menu?.options[1]?.label).toBe('Claude Haiku 5.5')
  })
  it('reads compact CLI suggestions separated by one space', () => {
    expect(detectSlashCommands(lines('❯ /model Set the AI model', '  /mcp (user) Manage MCP servers')).map(entry => entry.command)).toEqual(['/model', '/mcp'])
    expect(detectSlashCommands(lines('❯ * /Agent-Updater – Update instructions')).map(entry => entry.command)).toEqual(['/Agent-Updater'])
  })
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
  it('reads CLI slash suggestions without the echoed draft', () => {
    const codex = detectSlashCommands(lines('› /mo', '', '› /model     choose what model and reasoning effort to use', '  /mention   mention a file'))
    expect(codex).toEqual([{ command: '/model', description: 'choose what model and reasoning effort to use' }, { command: '/mention', description: 'mention a file' }])
    const claude = detectSlashCommands(lines('╭────╮', '│ > /m │', '╰────╯', '  /model                Set the AI model', '  /mcp (user)           Manage MCP servers'))
    expect(claude.map(entry => entry.command)).toEqual(['/model', '/mcp'])
    expect(detectSlashCommands(lines('› /mo'))).toEqual([])
    expect(detectSlashCommands(lines('› /model  choose a model', '', '› /mo'))).toEqual([{ command: '/model', description: 'choose a model' }])
  })
})
