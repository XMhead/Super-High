import { expect, it } from 'vitest'
import { chatUsageLabels, claudeContextFromOutput } from './cliChatUsage'
import type { CliChatTurn } from './tauri'

const turn = { startedAt: 0, completedAt: 2000, durationMs: 1000 } as CliChatTurn
it('reads Claude native context categories and preserves the estimated source', () => {
  const usage = claudeContextFromOutput('\u001b[1mContext Usage\u001b[22m\n⛶ 357.4k/200k tokens (179%)\n⛁ System prompt: 1.7k tokens (0.2%)\n⛁ MCP server instructions: 203 tokens\n⛁ Skills: 2.7k tokens\nMessages: 352.8k tokens\nAutocompact buffer: 33k tokens\nFree space: 0 tokens')!
  expect([usage.usedTokens, usage.windowTokens, usage.source]).toEqual([357400, 200000, 'claude-context-command'])
  expect(usage.segments.find(segment => segment.id === 'mcp server instructions')?.tokens).toBe(203)
  expect(usage.segments.find(segment => segment.kind === 'buffer')?.tokens).toBe(33000)
  expect(claudeContextFromOutput('ordinary text 10/20 tokens')).toBeNull()
})
it('keeps missing costs and input counts unknown and labels average output speed', () => {
  expect(chatUsageLabels(turn)).toBeNull()
  expect(chatUsageLabels({ ...turn, usage: { inputTokens: null, outputTokens: 100, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costEstimated: false } }))
    .toEqual({ tokens: '100 输出 tokens', detail: '输出 100', speed: '约 100.0 tok/s', cost: '费用 —' })
})
it('shows real zero costs, includes cache detail and avoids dividing by zero', () => {
  expect(chatUsageLabels({ ...turn, durationMs: 0, usage: { inputTokens: 200, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: null, costUsd: 0, costEstimated: false } }))
    .toEqual({ tokens: '200 tokens', detail: '输入 200 · 输出 0 · 缓存读取 100', speed: '', cost: '$0.0000' })
})
