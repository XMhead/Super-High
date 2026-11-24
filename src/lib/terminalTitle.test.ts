import { describe, expect, it } from 'vitest'
import { TerminalTitleParser, terminalSessionTitle } from './terminalTitle'

describe('terminal titles', () => {
  it.each(['\x07', '\x1b\\', '\x9c'])('reads split OSC 0/2 titles terminated with %j', (end) => {
    const parser = new TerminalTitleParser()
    for (const char of `output\x1b]0;分析项目 ${end}`) parser.push(char)
    expect(parser.title).toBe('分析项目')
    parser.push(`\x1b]2;等待输入${end}`)
    expect(parser.title).toBe('等待输入')
    parser.push(`\x1b]1;icon title${end}\x1b]52;clipboard${end}`)
    expect(parser.title).toBe('等待输入')
    expect(parser.push(`\x1b]2;${end}`)).toBe('')
  })

  it('ignores other control strings, cancelled OSCs and oversized payloads', () => {
    const parser = new TerminalTitleParser()
    parser.push('\x1bP\x1b]2;embedded\x07\x1b\\')
    parser.push('\x1b]2;cancelled\x18\x07')
    parser.push(`\x1b]2;${'x'.repeat(5000)}\x07`)
    expect(parser.title).toBeUndefined()
    expect(parser.push('\x9d2;新标题\x9c')).toBe('新标题')
  })

  it('uses product names until the CLI sets a title and respects explicit names', () => {
    const session = { id: 'one', providerKind: 'codex', title: 'Codex CLI', cwd: '' }
    expect(terminalSessionTitle(session)).toBe('Codex')
    expect(terminalSessionTitle({ ...session, terminalTitle: '正在整理' })).toBe('正在整理')
    expect(terminalSessionTitle({ ...session, terminalTitle: '正在整理', name: '自定名称' })).toBe('自定名称')
    expect(terminalSessionTitle({ ...session, providerKind: 'local', title: 'PowerShell', terminalTitle: 'shell path' })).toBe('PowerShell')
  })
})
