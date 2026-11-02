<script setup lang="ts">
// 设置「使用统计」：界面参照 ZCode 设置页的 App Usage，数据只读取 cc-switch 的用量记录。
import { computed, onMounted, ref } from 'vue'

import UsageDashboard from '@/components/UsageDashboard.vue'
import { backend } from '@/lib/tauri'
import {
  buildDailyTotals,
  buildUsageSummary,
  formatCount,
  formatDuration,
  formatTokens,
  localDateKey,
} from '@/lib/usageStats'
import type { UsageStatsResponse } from '@/types'

const stats = ref<UsageStatsResponse | null>(null)
const loading = ref(false)
const loadError = ref('')
const today = ref(localDateKey())
const rows = computed(() => stats.value?.daily ?? [])
const totals = computed(() => buildDailyTotals(rows.value))
const hasUsage = computed(() => [...totals.value.values()].some(total => total.totalTokens > 0))
const summaryItems = computed(() => {
  const summary = buildUsageSummary(totals.value, stats.value?.longestSessionMs ?? 0, today.value)
  const ready = Boolean(stats.value?.available)
  return [
    { label: '累计 Token', value: ready ? formatTokens(summary.totalTokens) : '--' },
    { label: '单日峰值', value: ready ? formatTokens(summary.peakDayTokens) : '--' },
    { label: '最长会话', value: ready ? formatDuration(summary.longestSessionMs) : '--', hint: '按会话日志首尾请求计算，仅覆盖 cc-switch 保留明细的近 30 天' },
    { label: '当前连续', value: ready ? `${formatCount(summary.currentStreakDays)} 天` : '--' },
    { label: '最长连续', value: ready ? `${formatCount(summary.longestStreakDays)} 天` : '--' },
  ]
})
const empty = computed(() => {
  if (stats.value && !stats.value.available) return { title: '未找到 cc-switch 数据库', text: '使用统计只读读取 ~/.cc-switch/cc-switch.db，通过 cc-switch 使用 CLI 后即可显示。' }
  if (!stats.value) return { title: '正在统计中', text: '正在读取 cc-switch 用量记录。' }
  if (!hasUsage.value) return { title: '还没有可展示的数据', text: 'cc-switch 中暂无用量记录。' }
  return null
})

async function load() {
  loading.value = true
  loadError.value = ''
  today.value = localDateKey()
  try {
    stats.value = await backend.loadUsageStats()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <UsageDashboard
    title="使用统计"
    :loading="loading"
    :summary="summaryItems"
    :notice="loadError || stats?.error"
    :empty="empty"
    :rows="rows"
    :today="today"
    unit="Token"
    heatmap-title="Token 活跃度"
    trend-title="每日模型用量"
    share-title="模型用量占比"
    other-label="其他模型"
    @refresh="load"
  />
</template>
