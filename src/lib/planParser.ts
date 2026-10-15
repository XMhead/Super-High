import type { PlanDecision } from '@/types'

// Plan 标记起止各自独占一行，用于在终端文本里定位决策内容。
export const PLAN_MARKER_START = '<<<SUPERHIGH_PLAN'
export const PLAN_MARKER_END = 'SUPERHIGH_PLAN>>>'

// CLI（尤其 Claude Code）把 AI 回复当 Markdown 渲染后再写进终端缓冲：
// `- xxx` 列表项会变成 `• xxx`，回复首行还会带一个 `⏺` 响应符。
// 这里要把「逐字」和「渲染后」两种前缀都剥掉，否则字段行匹配不到 label。
function stripMarkdownPrefix(line: string): string {
  return line
    .trim()
    .replace(/^[⏺▸▹►▶]\s*/, '')
    .replace(/^[-*+•‣◦·]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim()
}

function stripFieldPrefix(line: string, labels: string[]): string {
  let value = stripMarkdownPrefix(line)
  for (const label of labels) {
    const pattern = new RegExp(`^(?:${label})\\s*[：:]\\s*`, 'i')
    value = value.replace(pattern, '').trim()
  }
  return value
}

function firstValue(lines: string[], labels: string[]): string {
  const normalizedLabels = labels.map((label) => label.toLowerCase())
  const line = lines.find((item) => {
    const value = stripMarkdownPrefix(item).toLowerCase()
    return normalizedLabels.some((label) => value.startsWith(`${label}:`) || value.startsWith(`${label}：`))
  })
  return line ? stripFieldPrefix(line, labels) : ''
}

function firstLooseLine(lines: string[]): string {
  return lines
    .map(stripMarkdownPrefix)
    .find((line) => {
      if (!line) return false
      if (/^(问题|yes|no|推荐|推荐选项|推荐解决方案|建议方案|说明|选择|更多信息)\s*[：:]/i.test(line)) return false
      return true
    }) ?? ''
}

function splitDecisionBlocks(content: string): Array<{ title: string; content: string }> {
  const blocks: Array<{ title: string; content: string }> = []
  // 逐字形态是 `### 决策 N`；Claude Code 渲染后 `###` 被吃掉，只剩 `决策 N` 自成一行。
  // 两种都按「决策 N」标题切块。
  const headingPattern = /^[ \t]*(?:#{1,6}[ \t]+)?(决策\s*\d+[^\n]*?)[ \t]*$/gm
  const matches = [...content.matchAll(headingPattern)]
  if (!matches.length) return blocks
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const next = matches[index + 1]
    const start = (match.index ?? 0) + match[0].length
    const end = next?.index ?? content.length
    blocks.push({
      title: match[1].trim(),
      content: content.slice(start, end).trim(),
    })
  }
  return blocks
}

function decisionFromBlock(title: string, key: string, lines: string[]): PlanDecision {
  const recommendation = firstValue(lines, ['推荐解决方案', '推荐', '建议方案'])
  const recommendedChoice = firstValue(lines, ['推荐选项', '推荐选择', '建议选项', '建议选择'])
  return {
    key,
    title,
    question: firstValue(lines, ['问题']) || firstLooseLine(lines) || title,
    yesText: firstValue(lines, ['Yes']),
    noText: firstValue(lines, ['No']),
    recommendation,
    recommendedChoice: recommendedChoiceFromText(recommendedChoice) ?? recommendedChoiceFromText(recommendation),
    choice: 'pending',
    choiceNotes: {},
  }
}

function recommendedChoiceFromText(value: string): PlanDecision['recommendedChoice'] {
  if (!value.trim()) return null
  if (/(?:建议|推荐|应当|应该|优先).{0,8}(?:yes|是|采纳)/i.test(value)) return 'yes'
  if (/(?:建议|推荐|应当|应该|优先).{0,8}(?:no|否|拒绝|不采纳)/i.test(value)) return 'no'
  if (/(?:建议|推荐|应当|应该|优先).{0,8}(?:skip|跳过)/i.test(value)) return 'skip'
  if (/^(?:yes|是|采纳)\b/i.test(value)) return 'yes'
  if (/^(?:no|否|拒绝|不采纳)\b/i.test(value)) return 'no'
  if (/^(?:skip|跳过)\b/i.test(value)) return 'skip'
  return null
}

// 从清洗后的终端文本里截取最后一个完整 Plan 标记块（不含哨符）。
//
// 关键：检测跑在「原始 PTY 字节流」上。Claude Code 这类全屏 TUI 用光标移动序列
// 排版，而不是换行符；stripTerminalAnsi 把这些序列删掉后，原本分行的内容会**粘成一行**。
// 所以这里不再要求哨符「独占一行」，而是用子串定位：找最后一对 START…END。
export function extractPlanBlock(cleanedText: string): string | null {
  const text = cleanedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const endIdx = text.lastIndexOf(PLAN_MARKER_END)
  if (endIdx < 0) return null
  const startIdx = text.lastIndexOf(PLAN_MARKER_START, endIdx - 1)
  if (startIdx < 0 || startIdx >= endIdx) return null
  return text.slice(startIdx + PLAN_MARKER_START.length, endIdx).trim()
}

// 把可能被 TUI 排版粘成一行的 Plan 块重新切回结构化的多行：在「决策 N 标题」和
// 每个字段 label（问题 / Yes / No / 推荐解决方案…）前插入换行，供下游按行解析。
function normalizePlanBlock(block: string): string {
  return block
    // 标题：`### 决策 N` 或裸 `决策 N` 都归一为独占一行的 `决策 N`
    .replace(/[ \t]*#{0,6}[ \t]*(决策\s*\d+)/g, '\n$1')
    // 字段：可选列表前缀 + label + 冒号，强制换行（长 label 排前面以免被短的截断）
    .replace(/[ \t]*[-*+•‣◦·]?[ \t]*(问题|Yes|No|推荐解决方案|推荐选项|推荐选择|建议方案|建议选项|建议选择|推荐)[ \t]*([：:])/gi, '\n$1$2')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// 把 Plan 块文本解析为决策列表；无法解析出任何决策时返回 null。
export function parsePlanDecisions(block: string): PlanDecision[] {
  const normalized = normalizePlanBlock(block)
  const blocks = splitDecisionBlocks(normalized)
  if (!blocks.length) {
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (!lines.length) return []
    return [decisionFromBlock('决策 1', 'decision-1', lines)]
  }
  return blocks.map((item, index) => {
    const lines = item.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return decisionFromBlock(item.title, `decision-${index + 1}`, lines)
  })
}
