import type { CliChatControls, CliChatTurn } from './tauri'
import { cleanCliChatText } from './cliChatText'

/** Claude's own /context report is an estimate; retain that source explicitly. */
export function claudeContextFromOutput(output: string): CliChatControls['context'] {
  const text = cleanCliChatText(output)
  if (!/Context Usage/i.test(text)) return null
  const count = (value: string) => Math.round(Number.parseFloat(value.replace(/,/g, '')) * (/m$/i.test(value) ? 1e6 : /k$/i.test(value) ? 1000 : 1))
  const summary = text.match(/([\d,.]+[km]?)\s*\/\s*([\d,.]+[km]?)\s+tokens/i)
  if (!summary) return null
  const names: Record<string, string> = { 'system prompt': '系统提示', 'system tools': '系统工具', 'mcp server instructions': 'MCP 指令', 'memory files': 'Memory', skills: 'Skills', messages: '消息', 'autocompact buffer': '压缩预留', 'free space': '可用空间' }
  const segments = [...text.matchAll(/(System prompt|System tools|MCP server instructions|Memory files|Skills|Messages|Autocompact buffer|Free space):\s*([\d,.]+[km]?)/gi)].map(match => {
    const id = match[1]!.toLowerCase()
    return { id, label: names[id]!, tokens: count(match[2]!), kind: id === 'free space' ? 'free' as const : id === 'autocompact buffer' ? 'buffer' as const : 'used' as const }
  })
  return { usedTokens: count(summary[1]!), windowTokens: count(summary[2]!), inputTokens: null, outputTokens: null, cachedTokens: null, cacheHitRate: null, segments, source: 'claude-context-command' }
}

/** Rates include tool time: native providers do not all expose generation time. */
export function chatUsageLabels(turn: CliChatTurn): { tokens: string; detail: string; speed: string; cost: string } | null {
  const usage = turn.usage
  if (!usage) return null
  const count = (value: number) => value.toLocaleString('en-US')
  const known = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0
  const input = known(usage.inputTokens) ? usage.inputTokens! : null
  const output = known(usage.outputTokens) ? usage.outputTokens! : null
  const total = input !== null && output !== null ? input + output : null
  const detail = [input !== null ? `输入 ${count(input)}` : '', output !== null ? `输出 ${count(output)}` : '',
    known(usage.cacheReadTokens) ? `缓存读取 ${count(usage.cacheReadTokens!)}` : '',
    known(usage.cacheWriteTokens) ? `缓存写入 ${count(usage.cacheWriteTokens!)}` : ''].filter(Boolean).join(' · ')
  const duration = turn.durationMs ?? (turn.completedAt === null ? null : turn.completedAt - turn.startedAt)
  const speed = output !== null && duration !== null && duration > 0 ? `约 ${(output * 1000 / duration).toFixed(1)} tok/s` : ''
  const cost = known(usage.costUsd) ? `${usage.costEstimated ? '约 ' : ''}$${usage.costUsd!.toFixed(usage.costUsd! < .01 ? 4 : 2)}` : '费用 —'
  return { tokens: total !== null ? `${count(total)} tokens` : output !== null ? `${count(output)} 输出 tokens` : input !== null ? `${count(input)} 输入 tokens` : '', detail, speed, cost }
}
