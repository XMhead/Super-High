<script setup lang="ts">
// 设置「插件」的 Skill 脚本使用统计：复用使用统计看板，列出当前可见 skill 的全部脚本（含从未调用的），用来发现过时脚本。
import { computed, ref, watch } from 'vue'

import UsageDashboard from '@/components/UsageDashboard.vue'
import { buildScriptSummary, describeScriptCalls, describeScriptEntry, scriptRowsToUsageRows } from '@/lib/scriptUsage'
import { backend } from '@/lib/tauri'
import { formatCount, localDateKey } from '@/lib/usageStats'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ScriptUsageResponse } from '@/types'

const props = defineProps<{ preview?: boolean }>()
const store = useWorkspaceStore()
const usage = ref<ScriptUsageResponse | null>(null)
const loading = ref(false)
const loadError = ref('')
const today = ref(localDateKey())
const rootPath = computed(() => store.workspace?.rootPath ?? '')
const rows = computed(() => scriptRowsToUsageRows(usage.value?.daily ?? []))
const scripts = computed(() => usage.value?.scripts ?? [])
const summaryItems = computed(() => usage.value
  ? buildScriptSummary(rows.value, scripts.value, today.value)
  : ['累计调用', '用过的脚本', '单日峰值', '近 7 日', '最近使用'].map(label => ({ label, value: '--' })))
const ranking = computed(() => scripts.value.map(entry => ({
  key: entry.path,
  label: `${entry.skill}/${entry.script}`,
  title: entry.exists ? entry.path : `${entry.path}（文件已不存在）`,
  value: `${formatCount(entry.count)} 次`,
  meta: describeScriptEntry(entry),
  muted: !entry.exists || entry.count === 0,
})))
const empty = computed(() => {
  if (props.preview) return { title: '浏览器预览不读取会话记录', text: '请在桌面应用查看当前项目的 skill 脚本使用统计。' }
  if (!rootPath.value) return { title: '未打开项目', text: '打开项目后统计其中 skill 脚本的调用次数。' }
  if (!usage.value) return { title: '正在统计中', text: '首次统计需要读取全部 Claude Code、Codex 会话记录，之后只读新增部分。' }
  if (!scripts.value.length) return { title: '没有 skill 脚本', text: '当前项目与全局 skill 的 scripts/ 下没有脚本，也没有调用记录。' }
  return null
})

async function load() {
  const projectPath = rootPath.value
  if (props.preview || !projectPath) return
  loading.value = true
  loadError.value = ''
  today.value = localDateKey()
  try {
    const response = await backend.loadScriptUsage(projectPath)
    // 统计期间切换了项目时丢弃旧结果。
    if (projectPath === rootPath.value) usage.value = response
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

watch(rootPath, () => {
  usage.value = null
  void load()
}, { immediate: true })
</script>

<template>
  <UsageDashboard
    nested
    title="Skill 脚本使用统计"
    :loading="loading"
    :summary="summaryItems"
    :notice="loadError || usage?.error"
    :empty="empty"
    :rows="rows"
    :today="today"
    unit="次"
    :format-value="formatCount"
    :describe="describeScriptCalls"
    heatmap-title="脚本活跃度"
    trend-title="每日脚本调用"
    share-title="脚本调用占比"
    other-label="其他脚本"
    ranking-title="全部 skill 脚本"
    :ranking="ranking"
    @refresh="load"
  />
</template>
