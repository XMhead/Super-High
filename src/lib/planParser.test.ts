import { describe, it, expect } from 'vitest'
import { extractPlanBlock, parsePlanDecisions } from './planParser'

// 注意：CLI（尤其 Claude Code）会把 AI 回复当成 Markdown 渲染再写进终端缓冲。
// 渲染后 `### 决策 N` 丢掉字面 `###`、`- xxx` 列表项变成 `• xxx`，
// 解析器必须同时吃下「逐字」和「渲染后」两种形态。

const VERBATIM = [
  '<<<SUPERHIGH_PLAN',
  '### 决策 1',
  '- 问题：是否加全局错误处理？',
  '- Yes：添加 errorHandler。',
  '- No：保持现状。',
  '- 推荐解决方案：建议采纳。',
  'SUPERHIGH_PLAN>>>',
].join('\n')

// Claude Code TUI 渲染后：标题没了 ###，列表项成了 •，marker 行带 ⏺ 响应符与缩进。
const RENDERED = [
  ' ⏺ <<<SUPERHIGH_PLAN',
  '   决策 1',
  '   • 问题：是否加全局错误处理？',
  '   • Yes：添加 errorHandler。',
  '   • No：保持现状。',
  '   • 推荐解决方案：建议采纳。',
  '   决策 2',
  '   • 问题：是否写日志文件？',
  '   • Yes：加日志写入。',
  '   • No：只 console。',
  '   • 推荐解决方案：先不做。',
  '   SUPERHIGH_PLAN>>>',
].join('\n')

describe('planParser', () => {
  it('parses the verbatim skill text', () => {
    const block = extractPlanBlock(VERBATIM)
    expect(block).not.toBeNull()
    const decisions = parsePlanDecisions(block as string)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].title).toBe('决策 1')
    expect(decisions[0].question).toBe('是否加全局错误处理？')
    expect(decisions[0].yesText).toBe('添加 errorHandler。')
    expect(decisions[0].noText).toBe('保持现状。')
    expect(decisions[0].recommendation).toBe('建议采纳。')
    expect(decisions[0].recommendedChoice).toBe('yes')
  })

  it('parses Claude Code markdown-rendered output (### dropped, - -> •, glyph on marker)', () => {
    const block = extractPlanBlock(RENDERED)
    expect(block).not.toBeNull()
    const decisions = parsePlanDecisions(block as string)
    expect(decisions).toHaveLength(2)
    expect(decisions[0].title).toBe('决策 1')
    expect(decisions[0].question).toBe('是否加全局错误处理？')
    expect(decisions[0].yesText).toBe('添加 errorHandler。')
    expect(decisions[0].noText).toBe('保持现状。')
    expect(decisions[0].recommendation).toBe('建议采纳。')
    expect(decisions[0].recommendedChoice).toBe('yes')
    expect(decisions[1].title).toBe('决策 2')
    expect(decisions[1].question).toBe('是否写日志文件？')
  })

  it('parses a block whose rows got glued onto one line (full-screen TUI redraw)', () => {
    // Claude Code 用光标移动序列排版，stripTerminalAnsi 删掉后整块会粘成一行。
    const glued =
      '⏺ 我建议如下：<<<SUPERHIGH_PLAN### 决策 1' +
      '- 问题：是否加全局错误处理？- Yes：添加 errorHandler。' +
      '- No：保持现状。- 推荐解决方案：建议采纳。' +
      '### 决策 2- 问题：是否写日志文件？- Yes：加日志写入。' +
      '- No：只 console。- 推荐解决方案：先不做。SUPERHIGH_PLAN>>>'
    const block = extractPlanBlock(glued)
    expect(block).not.toBeNull()
    const decisions = parsePlanDecisions(block as string)
    expect(decisions).toHaveLength(2)
    expect(decisions[0].title).toBe('决策 1')
    expect(decisions[0].question).toBe('是否加全局错误处理？')
    expect(decisions[0].yesText).toBe('添加 errorHandler。')
    expect(decisions[0].noText).toBe('保持现状。')
    expect(decisions[0].recommendation).toBe('建议采纳。')
    expect(decisions[1].title).toBe('决策 2')
    expect(decisions[1].question).toBe('是否写日志文件？')
    expect(decisions[1].recommendation).toBe('先不做。')
  })

  it('parses explicit recommended choices for the current Plan format', () => {
    const block = [
      '<<<SUPERHIGH_PLAN',
      '### 决策 1',
      '- 问题：是否写测试？',
      '- Yes：补测试。',
      '- No：不补。',
      '- 推荐选项：Yes',
      '- 推荐解决方案：覆盖风险点。',
      '### 决策 2',
      '- 问题：是否重构？',
      '- Yes：重构。',
      '- No：不重构。',
      '- 推荐选项：No',
      '- 推荐解决方案：先保持范围。',
      'SUPERHIGH_PLAN>>>',
    ].join('\n')
    const decisions = parsePlanDecisions(extractPlanBlock(block) as string)

    expect(decisions[0].recommendedChoice).toBe('yes')
    expect(decisions[1].recommendedChoice).toBe('no')
    expect(decisions[1].recommendation).toBe('先保持范围。')
  })
})
