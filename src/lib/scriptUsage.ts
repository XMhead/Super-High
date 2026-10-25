// 设置「插件」的 Skill 脚本使用统计：把「日期 × skill 脚本」调用次数映射成使用统计的日序列，复用同一套热力图与区间图表。
import type { ScriptUsageDailyRow, ScriptUsageEntry, UsageDailyModelRow } from '@/types'
import {
  buildDailyTotals,
  buildRangeModelUsage,
  buildUsageSummary,
  formatCount,
  formatFullDay,
  localDateKey,
  type HeatmapValueDescriber,
  type UsageSummaryItem,
} from './usageStats'

const SOURCE_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', superhigh: '脚本工具' }

/** 次数记在 outputTokens，rowTotalTokens 即调用次数；脚本路径占用模型位。 */
export function scriptRowsToUsageRows(rows: ScriptUsageDailyRow[]): UsageDailyModelRow[] {
  return rows.map(row => ({
    date: row.date,
    model: row.script,
    requestCount: row.count,
    inputTokens: 0,
    outputTokens: row.count,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }))
}

export const describeScriptCalls: HeatmapValueDescriber = total => `${formatCount(total.totalTokens)} 次调用`

export function buildScriptSummary(rows: UsageDailyModelRow[], scripts: ScriptUsageEntry[], today: string, now = Date.now()): UsageSummaryItem[] {
  const summary = buildUsageSummary(buildDailyTotals(rows), 0, today)
  const lastUsed = Math.max(0, ...scripts.map(entry => entry.lastUsedMs))
  const used = scripts.filter(entry => entry.count > 0).length
  return [
    { label: '累计调用', value: `${formatCount(summary.totalTokens)} 次`, hint: '只统计 skill 目录（含 SKILL.md）下 scripts/ 内的脚本，来自 Claude Code、Codex 会话与脚本工具面板；普通项目脚本和 .agent/tmp 不计入' },
    { label: '用过的脚本', value: `${formatCount(used)} / ${formatCount(scripts.length)} 个`, hint: '当前项目与全局 skill 的全部脚本中被调用过的数量' },
    { label: '单日峰值', value: `${formatCount(summary.peakDayTokens)} 次` },
    { label: '近 7 日', value: `${formatCount(buildRangeModelUsage(rows, today, 7).totalTokens)} 次` },
    { label: '最近使用', value: formatLastUsed(lastUsed, now) },
  ]
}

export function formatScriptSources(sources: Record<string, number>) {
  return Object.entries(sources)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([source, count]) => `${SOURCE_LABELS[source] ?? source} ${formatCount(count)}`)
    .join(' · ')
}

/** 排行行的补充说明：最近使用、来源，以及判断是否过时用的标记。 */
export function describeScriptEntry(entry: ScriptUsageEntry, now = Date.now()) {
  const parts = [entry.count ? formatLastUsed(entry.lastUsedMs, now) : '从未调用', formatScriptSources(entry.sources)]
  if (!entry.exists) parts.push('已不存在')
  if (!entry.documented) parts.push('文档未提及')
  if (entry.referencedBy?.length) parts.push(`被 ${entry.referencedBy.join('、')} 引用`)
  if (entry.scope === 'other') parts.push('不在当前可见 skill 中')
  return parts.filter(Boolean).join(' · ')
}

export function formatLastUsed(ms: number, now = Date.now()) {
  if (!ms) return '--'
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days} 天前` : formatFullDay(localDateKey(new Date(ms)))
}
