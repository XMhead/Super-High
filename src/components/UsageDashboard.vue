<script setup lang="ts">
// 使用统计看板：摘要条、52 周热力图、区间趋势、占比环形图与可选排行。
// 「使用统计」（Token）与「插件 · 脚本使用统计」（调用次数）共用这一份布局，数据口径由外层决定。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RefreshCw } from 'lucide-vue-next'

import {
  HEATMAP_MODES,
  HEATMAP_WEEKS,
  USAGE_RANGES,
  buildDailyTotals,
  buildHeatmapColumns,
  buildMonthLabels,
  buildRangeModelUsage,
  formatPercent,
  formatTokens,
  type HeatmapMode,
  type HeatmapValueDescriber,
  type UsageRange,
  type UsageRankingRow,
  type UsageSummaryItem,
} from '@/lib/usageStats'
import type { UsageDailyModelRow } from '@/types'

interface TooltipRow { color?: string, label: string, value: string }
interface TooltipState { x: number, y: number, title: string, rows: TooltipRow[] }

const props = withDefaults(defineProps<{
  title: string
  /** 嵌在其他设置页里时使用小标题，不再包一层设置分区。 */
  nested?: boolean
  loading?: boolean
  summary: UsageSummaryItem[]
  /** 红色错误提示，优先于空状态。 */
  notice?: string | null
  /** 有值时显示空状态而不是图表。 */
  empty?: { title: string, text: string } | null
  rows: UsageDailyModelRow[]
  today: string
  unit: string
  heatmapTitle: string
  trendTitle: string
  shareTitle: string
  otherLabel: string
  formatValue?: (value: number) => string
  describe?: HeatmapValueDescriber
  rankingTitle?: string
  ranking?: UsageRankingRow[]
}>(), { formatValue: formatTokens, ranking: () => [] })
const emit = defineEmits<{ refresh: [] }>()

const SERIES_COLORS = [
  'var(--color-accent-blue)',
  'var(--color-accent-green)',
  'var(--color-accent-purple)',
  'var(--color-accent-red)',
  'var(--color-accent-yellow)',
  'var(--color-text-muted)',
]
const HEATMAP_GRID_STYLE = { gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))` }
const TREND_HEIGHT = 220
const TREND_PAD = { top: 10, right: 24, bottom: 26, left: 24 }
const DONUT_SIZE = 200
const DONUT_STROKE = 30
const RANKING_PREVIEW = 20

const heatmapMode = ref<HeatmapMode>('daily')
const range = ref<UsageRange>('7d')
const tooltip = ref<TooltipState | null>(null)
const showAllRanking = ref(false)
const totals = computed(() => buildDailyTotals(props.rows))
const heatmapColumns = computed(() => buildHeatmapColumns(totals.value, props.today, heatmapMode.value, props.describe))
const monthLabels = computed(() => buildMonthLabels(heatmapColumns.value))
const rangeDays = computed(() => USAGE_RANGES.find(option => option.id === range.value)?.days ?? 7)
const rangeUsage = computed(() => buildRangeModelUsage(props.rows, props.today, rangeDays.value))
const visibleRanking = computed(() => showAllRanking.value ? props.ranking : props.ranking.slice(0, RANKING_PREVIEW))
const withUnit = (value: number) => `${props.formatValue(value)} ${props.unit}`

function showTooltipAt(x: number, y: number, title: string, rows: TooltipRow[] = []) {
  tooltip.value = { x: Math.min(Math.max(x, 120), window.innerWidth - 120), y, title, rows }
}

function showTooltip(target: Element, title: string, rows: TooltipRow[] = []) {
  const rect = target.getBoundingClientRect()
  showTooltipAt(rect.left + rect.width / 2, rect.top, title, rows)
}

function hideTooltip() {
  tooltip.value = null
}

function colorFor(index: number) {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}
// 区间趋势：按容器实际像素绘制 SVG，避免 viewBox 缩放拉伸文字与线宽。
const trendEl = ref<HTMLElement | null>(null)
const trendWidth = ref(600)
const hoverIndex = ref<number | null>(null)
const plotWidth = computed(() => Math.max(1, trendWidth.value - TREND_PAD.left - TREND_PAD.right))
const plotHeight = TREND_HEIGHT - TREND_PAD.top - TREND_PAD.bottom
// 独立折线而非堆叠图：Y 轴上限跟随可见序列的单点峰值，而不是每日总量。
const trendMax = computed(() => Math.max(0, ...rangeUsage.value.points.flatMap(point => point.values)))
const trendX = (index: number) => {
  const count = rangeUsage.value.points.length
  return TREND_PAD.left + (count <= 1 ? plotWidth.value / 2 : (index * plotWidth.value) / (count - 1))
}
const trendY = (value: number) => TREND_PAD.top + plotHeight - (trendMax.value > 0 ? (value / trendMax.value) * plotHeight : 0)
const trendPaths = computed(() => rangeUsage.value.series.map((slice, seriesIndex) => ({
  key: slice.key,
  color: colorFor(slice.colorIndex),
  d: rangeUsage.value.points.map((point, index) => `${index ? 'L' : 'M'}${trendX(index).toFixed(1)},${trendY(point.values[seriesIndex]).toFixed(1)}`).join(' '),
})))
const trendGridLines = computed(() => [0, 1, 2, 3].map(step => TREND_PAD.top + (plotHeight * step) / 3))
const trendAxisLabels = computed(() => {
  const count = rangeUsage.value.points.length
  const step = count > 45 ? 7 : 5
  return rangeUsage.value.points
    .map((point, index) => ({ index, label: point.label, x: trendX(index), anchor: index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle' }))
    .filter(({ index }) => count <= 14 || index === 0 || index === count - 1 || index % step === 0)
})

function onTrendMove(event: MouseEvent) {
  const svg = event.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const count = rangeUsage.value.points.length
  if (!count) return
  const spacing = count <= 1 ? 1 : plotWidth.value / (count - 1)
  const index = Math.min(count - 1, Math.max(0, Math.round((event.clientX - rect.left - TREND_PAD.left) / spacing)))
  hoverIndex.value = index
  const point = rangeUsage.value.points[index]
  // 0 用量序列没有可见趋势点，提示里只列当天有用量的序列。
  const rows = rangeUsage.value.series
    .map((slice, seriesIndex) => ({ color: colorFor(slice.colorIndex), label: slice.label, value: point.values[seriesIndex] }))
    .filter(item => item.value > 0)
    .map(item => ({ color: item.color, label: item.label, value: withUnit(item.value) }))
  // 当天总量含未绘制折线的序列（区间排名在前 6 之外），补一行让明细与标题总量对得上。
  const rest = point.total - point.values.reduce((sum, value) => sum + value, 0)
  if (rest > 0) rows.push({ color: SERIES_COLORS[SERIES_COLORS.length - 1], label: props.otherLabel, value: withUnit(rest) })
  showTooltipAt(rect.left + trendX(index), rect.top + TREND_PAD.top, `${point.label} · ${withUnit(point.total)}`, rows)
}

function onTrendLeave() {
  hoverIndex.value = null
  hideTooltip()
}
// 占比环形图：stroke-dasharray 画弧，多切片时留 2px 间隔。
const donutRadius = (DONUT_SIZE - DONUT_STROKE) / 2
const donutCircumference = 2 * Math.PI * donutRadius
const donutArcs = computed(() => {
  const slices = rangeUsage.value.slices
  const gap = slices.length > 1 ? 2 : 0
  let offset = 0
  return slices.map((slice) => {
    const length = slice.share * donutCircumference
    const arc = { key: slice.key, color: colorFor(slice.colorIndex), dash: `${Math.max(0, length - gap)} ${donutCircumference}`, offset: -offset, slice }
    offset += length
    return arc
  })
})

function onArcEnter(event: MouseEvent, slice: (typeof donutArcs.value)[number]['slice']) {
  showTooltipAt(event.clientX, event.clientY - 6, slice.label, [
    { color: colorFor(slice.colorIndex), label: withUnit(slice.totalTokens), value: formatPercent(slice.share) },
  ])
}

let resizeObserver: ResizeObserver | null = null
watch(trendEl, (element, previous) => {
  if (previous) resizeObserver?.unobserve(previous)
  if (element) {
    trendWidth.value = element.clientWidth || trendWidth.value
    resizeObserver?.observe(element)
  }
})
watch([range, heatmapMode], hideTooltip)

onMounted(() => {
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width) trendWidth.value = width
  })
  if (trendEl.value) resizeObserver.observe(trendEl.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <section :class="nested ? 'usage-dashboard usage-nested' : 'settings-content-section usage-dashboard'">
    <div :class="nested ? 'usage-nested-heading' : 'settings-section-heading'">
      <div v-if="nested" class="usage-nested-title">{{ title }}</div>
      <div v-else><div class="section-title">{{ title }}</div></div>
      <div class="settings-heading-actions">
        <button type="button" class="ghost-button small" :disabled="loading" @click="emit('refresh')">
          <RefreshCw :size="13" :class="{ 'usage-spin': loading }" />
          刷新
        </button>
      </div>
    </div>

    <div class="usage-summary-strip">
      <div v-for="item in summary" :key="item.label" class="usage-summary-item" :title="item.hint">
        <div class="usage-summary-value">{{ item.value }}</div>
        <div class="usage-summary-label">{{ item.label }}</div>
      </div>
    </div>

    <div v-if="notice" class="usage-notice" role="alert">{{ notice }}</div>
    <div v-else-if="empty" class="usage-empty">
      <div class="usage-empty-title">{{ empty.title }}</div>
      <div>{{ empty.text }}</div>
    </div>
    <template v-else>
      <section class="usage-card">
        <header class="usage-card-header">
          <h3>{{ heatmapTitle }}</h3>
          <div class="usage-segment" role="tablist" aria-label="热力图统计方式">
            <button
              v-for="option in HEATMAP_MODES"
              :key="option.id"
              type="button"
              role="tab"
              :aria-selected="heatmapMode === option.id"
              :class="{ active: heatmapMode === option.id }"
              @click="heatmapMode = option.id"
            >{{ option.label }}</button>
          </div>
        </header>
        <div class="usage-heatmap-grid" :style="HEATMAP_GRID_STYLE">
          <div
            v-for="column in heatmapColumns"
            :key="column.key"
            class="usage-heatmap-column"
            :class="{ 'column-hover': column.tooltip }"
            @mouseenter="column.tooltip && showTooltip($event.currentTarget as Element, column.tooltip)"
            @mouseleave="hideTooltip"
          >
            <div
              v-for="cell in column.cells"
              :key="cell.key"
              class="usage-heatmap-cell"
              :class="[`level-${cell.level}`, { used: cell.hasUsage, future: cell.future }]"
              @mouseenter="cell.tooltip && showTooltip($event.currentTarget as Element, cell.tooltip)"
              @mouseleave="!column.tooltip && hideTooltip()"
            />
          </div>
        </div>
        <div class="usage-heatmap-grid usage-heatmap-months" :style="HEATMAP_GRID_STYLE">
          <span v-for="label in monthLabels" :key="label.key" :style="{ gridColumn: `span ${label.span}` }">{{ label.label }}</span>
        </div>
      </section>
      <div class="usage-range-row">
        <span>时间范围</span>
        <div class="usage-segment" role="tablist" aria-label="时间范围">
          <button
            v-for="option in USAGE_RANGES"
            :key="option.id"
            type="button"
            role="tab"
            :aria-selected="range === option.id"
            :class="{ active: range === option.id }"
            @click="range = option.id"
          >{{ option.label }}</button>
        </div>
      </div>

      <section class="usage-card">
        <header class="usage-card-header"><h3>{{ trendTitle }}</h3></header>
        <div v-if="trendMax <= 0" class="usage-empty compact">当前区间暂无用量。</div>
        <template v-else>
          <div class="usage-legend" role="list">
            <span v-for="slice in rangeUsage.series" :key="slice.key" class="usage-legend-item" role="listitem" :title="slice.label">
              <i :style="{ background: colorFor(slice.colorIndex) }" /><span>{{ slice.label }}</span>
            </span>
          </div>
          <div ref="trendEl" class="usage-trend">
            <svg :width="trendWidth" :height="TREND_HEIGHT" role="img" :aria-label="`${trendTitle}折线图`" @mousemove="onTrendMove" @mouseleave="onTrendLeave">
              <line v-for="y in trendGridLines" :key="y" class="usage-grid-line" :x1="TREND_PAD.left" :x2="trendWidth - TREND_PAD.right" :y1="y" :y2="y" />
              <line v-if="hoverIndex !== null" class="usage-hover-line" :x1="trendX(hoverIndex)" :x2="trendX(hoverIndex)" :y1="TREND_PAD.top" :y2="TREND_PAD.top + plotHeight" />
              <path v-for="path in trendPaths" :key="path.key" :d="path.d" :stroke="path.color" class="usage-trend-line" />
              <template v-if="hoverIndex !== null">
                <circle
                  v-for="(slice, seriesIndex) in rangeUsage.series"
                  v-show="rangeUsage.points[hoverIndex].values[seriesIndex] > 0"
                  :key="slice.key"
                  :cx="trendX(hoverIndex)"
                  :cy="trendY(rangeUsage.points[hoverIndex].values[seriesIndex])"
                  r="3.5"
                  :fill="colorFor(slice.colorIndex)"
                />
              </template>
              <text v-for="label in trendAxisLabels" :key="label.index" class="usage-axis-label" :x="label.x" :y="TREND_HEIGHT - 6" :text-anchor="label.anchor">{{ label.label }}</text>
            </svg>
          </div>
        </template>
      </section>
      <section class="usage-card">
        <header class="usage-card-header"><h3>{{ shareTitle }}</h3></header>
        <div v-if="rangeUsage.totalTokens <= 0" class="usage-empty compact">当前区间暂无用量。</div>
        <div v-else class="usage-donut-layout">
          <div class="usage-donut">
            <svg :width="DONUT_SIZE" :height="DONUT_SIZE" role="img" :aria-label="`${shareTitle}环形图`">
              <g :transform="`rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`">
                <circle class="usage-donut-track" :cx="DONUT_SIZE / 2" :cy="DONUT_SIZE / 2" :r="donutRadius" :stroke-width="DONUT_STROKE" />
                <circle
                  v-for="arc in donutArcs"
                  :key="arc.key"
                  class="usage-donut-arc"
                  :cx="DONUT_SIZE / 2"
                  :cy="DONUT_SIZE / 2"
                  :r="donutRadius"
                  :stroke="arc.color"
                  :stroke-width="DONUT_STROKE"
                  :stroke-dasharray="arc.dash"
                  :stroke-dashoffset="arc.offset"
                  @mousemove="onArcEnter($event, arc.slice)"
                  @mouseleave="hideTooltip"
                />
              </g>
            </svg>
            <div class="usage-donut-center">
              <strong>{{ formatValue(rangeUsage.totalTokens) }}</strong>
              <span>{{ unit }}</span>
            </div>
          </div>
          <div class="usage-model-list" role="list">
            <div v-for="slice in rangeUsage.slices" :key="slice.key" class="usage-model-row" role="listitem">
              <i :style="{ background: colorFor(slice.colorIndex) }" />
              <span class="usage-model-name" :title="slice.label">{{ slice.label }}</span>
              <span class="usage-model-share">{{ formatPercent(slice.share) }}</span>
              <span class="usage-model-tokens">{{ withUnit(slice.totalTokens) }}</span>
            </div>
          </div>
        </div>
      </section>
      <section v-if="ranking.length" class="usage-card">
        <header class="usage-card-header">
          <h3>{{ rankingTitle }}</h3>
          <button v-if="ranking.length > RANKING_PREVIEW" type="button" class="ghost-button small" @click="showAllRanking = !showAllRanking">
            {{ showAllRanking ? '收起' : `显示全部 ${ranking.length} 个` }}
          </button>
        </header>
        <div class="usage-ranking" role="list">
          <div v-for="(row, index) in visibleRanking" :key="row.key" class="usage-ranking-row" :class="{ muted: row.muted }" role="listitem">
            <span class="usage-ranking-index">{{ index + 1 }}</span>
            <span class="usage-ranking-name" :title="row.title ?? row.label">{{ row.label }}</span>
            <span class="usage-ranking-value">{{ row.value }}</span>
            <span v-if="row.meta" class="usage-ranking-meta">{{ row.meta }}</span>
          </div>
        </div>
      </section>
    </template>
    <Teleport to="body">
      <div v-if="tooltip" class="usage-tooltip" :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }" role="tooltip">
        <div class="usage-tooltip-title">{{ tooltip.title }}</div>
        <div v-for="row in tooltip.rows" :key="row.label" class="usage-tooltip-row">
          <i v-if="row.color" :style="{ background: row.color }" />
          <span>{{ row.label }}</span>
          <b>{{ row.value }}</b>
        </div>
      </div>
    </Teleport>
  </section>
</template>
<style scoped>
.usage-dashboard { gap: 14px; }
.usage-dashboard .settings-section-heading { margin-bottom: 0; }
.usage-nested { min-width: 0; display: flex; flex-direction: column; }
.usage-nested-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.usage-nested-title { color: var(--color-text-primary); font-size: 15px; font-weight: var(--sh-weight-emphasis); }

.usage-card,
.usage-summary-strip {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--surface-panel-soft);
}

.usage-card { min-width: 0; padding: 12px 14px; }
.usage-card-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.usage-card-header h3 { margin: 0; font-size: 13px; font-weight: var(--sh-weight-emphasis); color: var(--color-text-primary); }

.usage-summary-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
.usage-summary-item { min-width: 0; padding: 12px 8px; text-align: center; }
.usage-summary-item + .usage-summary-item { border-left: 1px solid var(--color-border); }
.usage-summary-value {
  overflow: hidden;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: var(--sh-weight-emphasis);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.usage-summary-label { margin-top: 4px; overflow: hidden; color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }

.usage-segment { flex: none; display: inline-flex; border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden; }
.usage-segment button {
  height: 24px;
  padding: 0 10px;
  border: 0;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.usage-segment button + button { border-left: 1px solid var(--color-border); }
.usage-segment button:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.usage-segment button.active { background: var(--color-bg-tertiary); color: var(--color-text-primary); font-weight: var(--sh-weight-emphasis); }

.usage-range-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--color-text-primary); font-size: 13px; font-weight: var(--sh-weight-emphasis); }
.usage-heatmap-grid { display: grid; width: 100%; column-gap: 2px; }
.usage-heatmap-column { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.usage-heatmap-cell {
  width: 100%;
  aspect-ratio: 1;
  border: 1px solid transparent;
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
}
.usage-heatmap-cell.used { border-color: var(--color-border); }
.usage-heatmap-cell.level-1 { background: color-mix(in srgb, var(--color-accent-blue) 28%, transparent); }
.usage-heatmap-cell.level-2 { background: color-mix(in srgb, var(--color-accent-blue) 48%, transparent); }
.usage-heatmap-cell.level-3 { background: color-mix(in srgb, var(--color-accent-blue) 72%, transparent); }
.usage-heatmap-cell.level-4 { background: var(--color-accent-blue); }
.usage-heatmap-cell.future { background: transparent; }
.usage-heatmap-cell:not(.future):hover,
.usage-heatmap-column.column-hover:hover .usage-heatmap-cell { border-color: var(--color-text-muted); }
.usage-heatmap-months { margin-top: 8px; }
.usage-heatmap-months span { min-width: 0; overflow: hidden; color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }

.usage-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 8px; }
.usage-legend-item { min-width: 0; display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 12px; }
.usage-legend-item span { max-width: 260px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.usage-legend i,
.usage-model-row i,
.usage-tooltip-row i { flex: none; width: 10px; height: 10px; border-radius: 2px; }

.usage-trend { width: 100%; min-width: 0; overflow: hidden; }
.usage-trend svg { display: block; }
.usage-grid-line { stroke: var(--color-border); stroke-dasharray: 3 3; }
.usage-hover-line { stroke: var(--color-text-muted); stroke-width: 1; }
.usage-trend-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.usage-axis-label { fill: var(--color-text-muted); font-family: var(--font-ui); font-size: 11px; }

.usage-donut-layout { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 20px; padding: 4px 8px; }
.usage-donut { position: relative; width: 200px; height: 200px; }
.usage-donut svg { display: block; }
.usage-donut-track { fill: none; stroke: color-mix(in srgb, var(--color-text-muted) 10%, transparent); }
.usage-donut-arc { fill: none; cursor: default; }
.usage-donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.usage-donut-center strong { color: var(--color-text-primary); font-family: var(--font-mono); font-size: 15px; font-weight: var(--sh-weight-emphasis); }
.usage-donut-center span { color: var(--color-text-muted); font-size: 12px; }
.usage-model-list { min-width: 0; }
.usage-model-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
}
.usage-model-row:last-child { border-bottom: 0; }
.usage-model-name { min-width: 0; overflow: hidden; color: var(--color-text-primary); font-family: var(--font-mono); white-space: nowrap; text-overflow: ellipsis; }
.usage-model-share { color: var(--color-text-secondary); font-family: var(--font-mono); }
.usage-model-tokens { grid-column: 2; color: var(--color-text-muted); }
.usage-ranking { min-width: 0; }
.usage-ranking-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
}
.usage-ranking-row:last-child { border-bottom: 0; }
.usage-ranking-row.muted { opacity: 0.55; }
.usage-ranking-index { color: var(--color-text-muted); font-family: var(--font-mono); text-align: right; }
.usage-ranking-name { min-width: 0; overflow: hidden; color: var(--color-text-primary); font-family: var(--font-mono); white-space: nowrap; text-overflow: ellipsis; }
.usage-ranking-value { color: var(--color-text-primary); font-family: var(--font-mono); font-weight: var(--sh-weight-emphasis); white-space: nowrap; }
.usage-ranking-meta { grid-column: 2 / 4; color: var(--color-text-muted); }
.usage-empty {
  padding: 32px 16px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: center;
}
.usage-empty.compact { padding: 24px 12px; }
.usage-empty-title { margin-bottom: 6px; color: var(--color-text-primary); font-size: 13px; font-weight: var(--sh-weight-emphasis); }
.usage-notice {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--color-accent-red) 45%, var(--color-border));
  border-radius: 4px;
  color: var(--color-accent-red);
  font-size: 12px;
}

.usage-tooltip {
  position: fixed;
  z-index: 2000;
  min-width: 160px;
  max-width: 300px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-secondary-solid);
  box-shadow: none;
  color: var(--color-text-primary);
  font-size: 12px;
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 6px));
}
.usage-tooltip-title { color: var(--color-text-secondary); white-space: nowrap; }
.usage-tooltip-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.usage-tooltip-row span { min-width: 0; flex: 1; overflow: hidden; font-family: var(--font-mono); white-space: nowrap; text-overflow: ellipsis; }
.usage-tooltip-row b { font-family: var(--font-mono); font-weight: var(--sh-weight-emphasis); white-space: nowrap; }

.usage-spin { animation: usage-spin 900ms linear infinite; }
@keyframes usage-spin { to { transform: rotate(360deg); } }

@media (max-width: 720px) {
  .usage-summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-summary-item + .usage-summary-item { border-left: 0; }
  .usage-summary-item { border-top: 1px solid var(--color-border); }
  .usage-summary-item:nth-child(-n + 2) { border-top: 0; }
  .usage-summary-item:nth-child(even) { border-left: 1px solid var(--color-border); }
  .usage-donut-layout { grid-template-columns: minmax(0, 1fr); justify-items: center; }
  .usage-model-list { width: 100%; }
}
</style>
