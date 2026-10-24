// 设置「使用统计」的视图数据：从 cc-switch 的「日期 × 模型」日序列派生摘要、热力图与区间图表。
// 计算口径参照 ZCode 设置页的 App Usage（摘要条、52 周热力图、每日模型趋势、模型占比）。
import type { UsageDailyModelRow } from '@/types'

export type UsageRange = '7d' | '30d'
export type HeatmapMode = 'daily' | 'weekly' | 'cumulative'
export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

export const USAGE_RANGES: { id: UsageRange, label: string, days: number }[] = [
  { id: '7d', label: '近 7 日', days: 7 },
  { id: '30d', label: '近 30 日', days: 30 },
]
export const HEATMAP_MODES: { id: HeatmapMode, label: string }[] = [
  { id: 'daily', label: '每日' },
  { id: 'weekly', label: '每周' },
  { id: 'cumulative', label: '累计' },
]
export const HEATMAP_WEEKS = 52
const DAYS_PER_WEEK = 7
const DAY_MS = 86_400_000
const VISIBLE_MONTH_LABELS = 12
const MAX_SERIES = 6

export interface UsageSummary {
  totalTokens: number
  peakDayTokens: number
  longestSessionMs: number
  currentStreakDays: number
  longestStreakDays: number
}

/** 看板摘要条的一格。 */
export interface UsageSummaryItem {
  label: string
  value: string
  hint?: string
}

/** 看板排行卡片的一行。 */
export interface UsageRankingRow {
  key: string
  label: string
  title?: string
  value: string
  meta?: string
  /** 已不存在的条目淡化显示。 */
  muted?: boolean
}

export interface UsageDayTotal {
  totalTokens: number
  requestCount: number
}

export interface HeatmapDisplayCell {
  key: string
  level: HeatmapLevel
  hasUsage: boolean
  /** 今天之后的格子只占位，不着色。 */
  future: boolean
  tooltip: string | null
}

export interface HeatmapDisplayColumn {
  key: string
  monthDate: string
  /** 每周、累计模式整列共用一个提示。 */
  tooltip: string | null
  cells: HeatmapDisplayCell[]
}

export interface HeatmapMonthLabel {
  key: string
  label: string
  span: number
}

export interface ModelSlice {
  key: string
  label: string
  colorIndex: number
  totalTokens: number
  share: number
}

export interface TrendPoint {
  date: string
  label: string
  total: number
  values: number[]
}

export interface RangeModelUsage {
  /** 趋势图的模型序列（按区间用量降序，最多 6 个）。 */
  series: ModelSlice[]
  points: TrendPoint[]
  /** 饼图切片：超过 6 个模型时合并为「其他」。 */
  slices: ModelSlice[]
  totalTokens: number
}

/** 真实消耗 Token：新增输入 + 输出 + 缓存写入 + 缓存命中（cc-switch 指标卡同口径）。 */
export function rowTotalTokens(row: UsageDailyModelRow) {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens
}

export function localDateKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayIndex(dateKey: string): number | null {
  const time = Date.parse(`${dateKey}T00:00:00.000Z`)
  return Number.isNaN(time) ? null : Math.floor(time / DAY_MS)
}

function dateKeyFromIndex(index: number) {
  return new Date(index * DAY_MS).toISOString().slice(0, 10)
}

export function buildDailyTotals(rows: UsageDailyModelRow[]) {
  const totals = new Map<string, UsageDayTotal>()
  for (const row of rows) {
    const total = totals.get(row.date) ?? { totalTokens: 0, requestCount: 0 }
    total.totalTokens += rowTotalTokens(row)
    total.requestCount += row.requestCount
    totals.set(row.date, total)
  }
  return totals
}

export function buildUsageSummary(totals: Map<string, UsageDayTotal>, longestSessionMs: number, today: string): UsageSummary {
  let totalTokens = 0
  let peakDayTokens = 0
  const activeDays = new Set<number>()
  for (const [date, total] of totals) {
    totalTokens += total.totalTokens
    peakDayTokens = Math.max(peakDayTokens, total.totalTokens)
    const index = dayIndex(date)
    if (index !== null && total.totalTokens > 0) activeDays.add(index)
  }

  let longestStreakDays = 0
  let run = 0
  let previous: number | null = null
  for (const index of [...activeDays].sort((left, right) => left - right)) {
    run = previous !== null && index === previous + 1 ? run + 1 : 1
    longestStreakDays = Math.max(longestStreakDays, run)
    previous = index
  }

  // 今天还没用量时从昨天起算，避免一早打开就显示连续 0 天。
  const todayIndex = dayIndex(today) ?? 0
  let cursor = activeDays.has(todayIndex) ? todayIndex : todayIndex - 1
  let currentStreakDays = 0
  while (activeDays.has(cursor)) {
    currentStreakDays += 1
    cursor -= 1
  }

  return { totalTokens, peakDayTokens, longestSessionMs, currentStreakDays, longestStreakDays }
}

function levelFor(value: number, max: number): HeatmapLevel {
  if (value <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as HeatmapLevel
}

function filledRowsFor(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0
  return Math.min(DAYS_PER_WEEK, Math.max(1, Math.ceil((value / max) * DAYS_PER_WEEK)))
}

/** 52 个自然周（周日为每列第一格），最后一列包含今天。 */
function heatmapWeekDates(today: string) {
  const todayIndex = dayIndex(today) ?? 0
  const weekday = new Date(todayIndex * DAY_MS).getUTCDay()
  const start = todayIndex - weekday - (HEATMAP_WEEKS - 1) * DAYS_PER_WEEK
  return Array.from({ length: HEATMAP_WEEKS }, (_, week) =>
    Array.from({ length: DAYS_PER_WEEK }, (_, offset) => start + week * DAYS_PER_WEEK + offset))
}

/** 列内包含 1 日时归入新月份，月份文字锚定到 1 日所在列（ZCode 同规则）。 */
function columnMonthDate(dates: string[]) {
  return dates.find(date => date.endsWith('-01')) ?? dates[0] ?? ''
}

/** 热力图提示里的数量描述；默认按 Token 与请求次数。 */
export type HeatmapValueDescriber = (total: UsageDayTotal) => string
const describeTokens: HeatmapValueDescriber = total => `${formatTokens(total.totalTokens)} Token · ${formatCount(total.requestCount)} 次请求`

export function buildHeatmapColumns(totals: Map<string, UsageDayTotal>, today: string, mode: HeatmapMode, describe: HeatmapValueDescriber = describeTokens): HeatmapDisplayColumn[] {
  const todayIndex = dayIndex(today) ?? 0
  const weeks = heatmapWeekDates(today)
  const dayTotal = (index: number) => totals.get(dateKeyFromIndex(index)) ?? { totalTokens: 0, requestCount: 0 }

  if (mode === 'daily') {
    const max = Math.max(0, ...weeks.flat().map(index => dayTotal(index).totalTokens))
    return weeks.map((week, weekIndex) => {
      const dates = week.map(dateKeyFromIndex)
      return {
        key: `daily-${weekIndex}`,
        monthDate: columnMonthDate(dates),
        tooltip: null,
        cells: week.map((index, offset) => {
          const total = dayTotal(index)
          const future = index > todayIndex
          return {
            key: dates[offset],
            level: future ? 0 : levelFor(total.totalTokens, max),
            hasUsage: total.totalTokens > 0,
            future,
            tooltip: future ? null : `${formatFullDay(dates[offset])} · ${describe(total)}`,
          }
        }),
      }
    })
  }

  const weekTotals = weeks.map(week => week.reduce((sum, index) => {
    const total = dayTotal(index)
    return { totalTokens: sum.totalTokens + total.totalTokens, requestCount: sum.requestCount + total.requestCount }
  }, { totalTokens: 0, requestCount: 0 }))
  const values = mode === 'weekly'
    ? weekTotals
    : weekTotals.reduce<UsageDayTotal[]>((acc, total) => {
        const last = acc.at(-1) ?? { totalTokens: 0, requestCount: 0 }
        acc.push({ totalTokens: last.totalTokens + total.totalTokens, requestCount: last.requestCount + total.requestCount })
        return acc
      }, [])
  const max = Math.max(0, ...values.map(value => value.totalTokens))

  return weeks.map((week, weekIndex) => {
    const dates = week.map(dateKeyFromIndex)
    const value = values[weekIndex]
    const level = levelFor(value.totalTokens, max)
    const filled = filledRowsFor(value.totalTokens, max)
    const endDate = dates[Math.min(DAYS_PER_WEEK - 1, Math.max(0, todayIndex - week[0]))]
    const label = mode === 'weekly' ? `${formatFullDay(endDate)} 所在周` : `累计至 ${formatFullDay(endDate)}`
    return {
      key: `${mode}-${weekIndex}`,
      monthDate: columnMonthDate(dates),
      tooltip: `${label} · ${describe(value)}`,
      cells: week.map((_, offset) => {
        const isFilled = offset >= DAYS_PER_WEEK - filled
        return { key: `${mode}-${dates[offset]}`, level: isFilled ? level : 0, hasUsage: isFilled && value.totalTokens > 0, future: false, tooltip: null }
      }),
    }
  })
}

export function buildMonthLabels(columns: HeatmapDisplayColumn[]): HeatmapMonthLabel[] {
  const labels: HeatmapMonthLabel[] = []
  for (const column of columns) {
    const key = column.monthDate.slice(0, 7)
    const last = labels.at(-1)
    if (last?.key === key) last.span += 1
    else labels.push({ key, label: `${Number(column.monthDate.slice(5, 7))}月`, span: 1 })
  }
  // 52 周可能跨 13 个月：保留起始月份的列宽以维持对齐，只隐藏文字，最多显示最近 12 个月。
  for (let index = 0; index < labels.length - VISIBLE_MONTH_LABELS; index += 1) labels[index].label = ''
  return labels
}

export function buildRangeModelUsage(rows: UsageDailyModelRow[], today: string, days: number): RangeModelUsage {
  const end = dayIndex(today) ?? 0
  const start = end - days + 1
  const inRange = rows.filter((row) => {
    const index = dayIndex(row.date)
    return index !== null && index >= start && index <= end
  })

  const modelTotals = new Map<string, number>()
  for (const row of inRange) modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + rowTotalTokens(row))
  const ranked = [...modelTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const totalTokens = ranked.reduce((sum, [, total]) => sum + total, 0)
  const toSlice = ([model, total]: [string, number], index: number): ModelSlice => ({
    key: model,
    label: model.trim() || '未知模型',
    colorIndex: index,
    totalTokens: total,
    share: totalTokens > 0 ? total / totalTokens : 0,
  })

  const series = ranked.slice(0, MAX_SERIES).map(toSlice)
  const seriesIndex = new Map(series.map((slice, index) => [slice.key, index]))
  const points: TrendPoint[] = Array.from({ length: days }, (_, offset) => {
    const date = dateKeyFromIndex(start + offset)
    return { date, label: formatShortDay(date), total: 0, values: series.map(() => 0) }
  })
  for (const row of inRange) {
    const point = points[(dayIndex(row.date) ?? start) - start]
    const tokens = rowTotalTokens(row)
    point.total += tokens
    const index = seriesIndex.get(row.model)
    if (index !== undefined) point.values[index] += tokens
  }

  const mergeOther = ranked.length > MAX_SERIES
  const slices = ranked.slice(0, mergeOther ? MAX_SERIES - 1 : MAX_SERIES).map(toSlice)
  if (mergeOther) {
    const other = ranked.slice(MAX_SERIES - 1).reduce((sum, [, total]) => sum + total, 0)
    slices.push({ key: '__other__', label: '其他', colorIndex: MAX_SERIES - 1, totalTokens: other, share: totalTokens > 0 ? other / totalTokens : 0 })
  }

  return { series, points, slices, totalTokens }
}

const tokenFormatter = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const countFormatter = new Intl.NumberFormat('zh-CN')

/** 紧凑 Token 数：中文单位与数字之间留空格，与天数、时长指标一致。 */
export function formatTokens(value: number) {
  if (!Number.isFinite(value)) return '--'
  if (value < 10_000) return countFormatter.format(value)
  return tokenFormatter.format(value).replace(/(?<=\d)(?=[万亿])/u, ' ')
}

export function formatCount(value: number) {
  return Number.isFinite(value) ? countFormatter.format(value) : '--'
}

export function formatPercent(share: number) {
  return `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`
}

export function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days} 天`)
  if (hours) parts.push(`${hours} 小时`)
  if (minutes || !parts.length) parts.push(`${minutes} 分钟`)
  return parts.join(' ')
}

export function formatShortDay(date: string) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
}

export function formatFullDay(date: string) {
  return `${date.slice(0, 4)}年${formatShortDay(date)}`
}
