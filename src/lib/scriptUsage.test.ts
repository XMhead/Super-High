import { expect, it } from 'vitest'
import type { ScriptUsageEntry } from '@/types'
import { buildScriptSummary, describeScriptCalls, describeScriptEntry, formatLastUsed, formatScriptSources, scriptRowsToUsageRows } from './scriptUsage'
import { buildDailyTotals, buildHeatmapColumns, buildRangeModelUsage } from './usageStats'

const TODAY = '2026-10-19'
const NOW = Date.parse('2026-10-19T12:00:00')
const rows = scriptRowsToUsageRows([
  { date: '2026-10-01', script: 'kit/scripts/old.py', count: 4 },
  { date: '2026-10-18', script: 'kit/scripts/run.py', count: 3 },
  { date: '2026-10-19', script: 'kit/scripts/run.py', count: 2 },
  { date: '2026-10-19', script: 'ops/scripts/check.ps1', count: 1 },
])

function entry(skill: string, script: string, count: number, lastUsedMs: number, extra: Partial<ScriptUsageEntry> = {}): ScriptUsageEntry {
  const skillDir = `D:/ws/.skillshare/skills/${skill}`
  return { skill, scope: 'project', skillDir, script, path: `${skillDir}/${script}`, count, recent30d: count, lastUsedMs, idleDays: null, exists: true, documented: true, sources: {}, ...extra }
}

const scripts: ScriptUsageEntry[] = [
  entry('kit', 'scripts/run.py', 5, NOW - 5 * 60_000, { sources: { claude: 4, codex: 1 } }),
  entry('ops', 'scripts/check.ps1', 1, NOW - 3 * 3_600_000, { sources: { superhigh: 1 } }),
  entry('kit', 'scripts/old.py', 4, NOW - 18 * 86_400_000, { exists: false, sources: { claude: 4 } }),
  entry('kit', 'scripts/helper.py', 0, 0, { documented: false, referencedBy: ['scripts/run.py'] }),
]

it('maps script calls onto the usage day series so charts count calls', () => {
  const range = buildRangeModelUsage(rows, TODAY, 7)
  expect(range.totalTokens).toBe(6)
  expect(range.series.map(slice => [slice.label, slice.totalTokens])).toEqual([['kit/scripts/run.py', 5], ['ops/scripts/check.ps1', 1]])
  const column = buildHeatmapColumns(buildDailyTotals(rows), TODAY, 'daily', describeScriptCalls).at(-1)!
  expect(column.cells.find(cell => cell.key === TODAY)?.tooltip).toBe('2026年10月19日 · 3 次调用')
})

it('summarizes totals, recent calls and last use', () => {
  expect(buildScriptSummary(rows, scripts, TODAY, NOW).map(item => item.value)).toEqual(['10 次', '3 / 4 个', '4 次', '6 次', '5 分钟前'])
  expect(describeScriptEntry(scripts[2], NOW)).toBe('18 天前 · Claude 4 · 已不存在')
  expect(describeScriptEntry(scripts[3], NOW)).toBe('从未调用 · 文档未提及 · 被 scripts/run.py 引用')
  expect(formatScriptSources({ codex: 1, claude: 4, superhigh: 0 })).toBe('Claude 4 · Codex 1')
  expect(formatLastUsed(0, NOW)).toBe('--')
  expect(formatLastUsed(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前')
  expect(formatLastUsed(NOW - 45 * 86_400_000, NOW)).toBe('2026年9月4日')
})
