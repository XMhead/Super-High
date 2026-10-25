import { expect, it } from 'vitest'
import type { UsageDailyModelRow } from '@/types'
import {
  HEATMAP_WEEKS,
  buildDailyTotals,
  buildHeatmapColumns,
  buildMonthLabels,
  buildRangeModelUsage,
  buildUsageSummary,
  formatDuration,
  formatTokens,
} from './usageStats'

function row(date: string, model: string, outputTokens: number, requestCount = 1): UsageDailyModelRow {
  return { date, model, requestCount, inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

const TODAY = '2026-10-19' // 周一
const rows = [
  row('2026-10-10', 'model-a', 10),
  row('2026-10-17', 'model-a', 100),
  row('2026-10-18', 'model-a', 50),
  row('2026-10-18', 'model-b', 200, 3),
]

it('summarizes lifetime totals and streaks, counting from yesterday when today is idle', () => {
  const summary = buildUsageSummary(buildDailyTotals(rows), 3_600_000, TODAY)
  expect(summary).toEqual({
    totalTokens: 360,
    peakDayTokens: 250,
    longestSessionMs: 3_600_000,
    currentStreakDays: 2,
    longestStreakDays: 2,
  })
})

it('builds 52 Sunday-first weeks ending with the current week and leaves future days blank', () => {
  const columns = buildHeatmapColumns(buildDailyTotals(rows), TODAY, 'daily')
  expect(columns).toHaveLength(HEATMAP_WEEKS)
  const last = columns.at(-1)!
  expect(last.cells.map(cell => cell.key).slice(0, 2)).toEqual(['2026-10-18', '2026-10-19'])
  expect(last.cells[0]).toMatchObject({ level: 4, hasUsage: true, future: false })
  expect(last.cells[1]).toMatchObject({ level: 0, future: false })
  expect(last.cells[2].future).toBe(true)
  expect(last.cells[0].tooltip).toContain('250 Token')

  const cumulative = buildHeatmapColumns(buildDailyTotals(rows), TODAY, 'cumulative')
  expect(cumulative.at(-1)!.tooltip).toContain('累计至 2026年10月19日 · 360 Token')
  expect(buildMonthLabels(columns).filter(label => label.label).length).toBeLessThanOrEqual(12)
  expect(buildMonthLabels(columns).reduce((sum, label) => sum + label.span, 0)).toBe(HEATMAP_WEEKS)
})

it('ranks range models, fills idle days and merges the tail into 其他', () => {
  const usage = buildRangeModelUsage(rows, TODAY, 7)
  expect(usage.points.map(point => point.date)).toEqual([
    '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19',
  ])
  expect(usage.series.map(slice => slice.key)).toEqual(['model-b', 'model-a'])
  expect(usage.points[5]).toMatchObject({ total: 250, values: [200, 50] })
  expect(usage.totalTokens).toBe(350)

  const many = Array.from({ length: 8 }, (_, index) => row(TODAY, `m${index}`, 100 - index))
  const merged = buildRangeModelUsage(many, TODAY, 7)
  expect(merged.series).toHaveLength(6)
  expect(merged.slices).toHaveLength(6)
  expect(merged.slices.at(-1)).toMatchObject({ key: '__other__', label: '其他', totalTokens: 95 + 94 + 93 })
})

it('formats compact Chinese token units and durations', () => {
  expect(formatTokens(9_999)).toBe('9,999')
  expect(formatTokens(12_345)).toBe('1.2 万')
  expect(formatTokens(10_696_855_259)).toBe('107 亿')
  expect(formatDuration(40_960_000)).toBe('11 小时 22 分钟')
  expect(formatDuration(0)).toBe('0 分钟')
})
