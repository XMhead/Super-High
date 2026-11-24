<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import SourceBadge from './SourceBadge.vue'
import { backend } from '@/lib/tauri'
import { appConfirm } from '@/lib/appDialog'
import { AUTOMATION_SCOPE_LABELS, automationScheduleText, automationTime, type AutomationScope, type AutomationTask } from '@/lib/automation'
import { useWorkspaceStore } from '@/stores/workspace'

const props = defineProps<{ preview?: boolean }>()
const store = useWorkspaceStore()
const projectPath = computed(() => store.workspace?.rootPath ?? null)
const tasks = ref<AutomationTask[]>([])
const filter = ref<'all' | AutomationScope>('all')
const visibleTasks = computed(() => tasks.value.filter(task => filter.value === 'all' || task.scope === filter.value))
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const editing = ref(false)
const isNew = ref(false)
const draft = reactive({ id: '', scope: 'global' as AutomationScope, title: '', enabled: false, schedule: 'daily', at: '', time: '23:00', action: 'shutdown', command: '' })
let request = 0
let refreshTimer: ReturnType<typeof setInterval> | undefined

function errorText(value: unknown) { return value instanceof Error ? value.message : String(value) }
async function refresh(quiet = false) {
  if (props.preview) return
  const current = ++request
  const path = projectPath.value
  if (!quiet) loading.value = true
  try {
    const result = await backend.listAutomationTasks(path)
    if (current !== request) return
    tasks.value = result
    error.value = ''
  } catch (value) {
    if (current === request) error.value = `读取自动任务失败：${errorText(value)}`
  } finally { if (current === request) loading.value = false }
}
function edit(task: AutomationTask) {
  isNew.value = false
  Object.assign(draft, { id: task.id, scope: task.scope, title: task.title, enabled: task.enabled, schedule: task.schedule.kind, at: task.schedule.kind === 'once' ? task.schedule.at : '', time: task.schedule.kind === 'daily' ? task.schedule.time : '23:00', action: task.action.kind, command: task.action.kind === 'command' ? task.action.command : '' })
  editing.value = true
  notice.value = ''
}
function create() {
  const later = new Date(Date.now() + 3600000)
  const at = new Date(later.getTime() - later.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  Object.assign(draft, { id: crypto.randomUUID(), scope: filter.value === 'global' ? 'global' : projectPath.value ? 'project' : 'global', title: '', enabled: false, schedule: 'once', at, time: '23:00', action: 'command', command: '' })
  isNew.value = true
  editing.value = true
  notice.value = ''
}
async function save() {
  if (!draft.title.trim()) { error.value = '请填写任务名称。'; return }
  if (draft.schedule === 'once' && !draft.at) { error.value = '请选择执行时间。'; return }
  if (draft.schedule === 'daily' && !draft.time) { error.value = '请选择每日执行时间。'; return }
  if (draft.action === 'command' && !draft.command.trim()) { error.value = '请填写要执行的命令。'; return }
  const task: AutomationTask = {
    id: draft.id, scope: draft.scope, title: draft.title.trim(), enabled: draft.enabled,
    schedule: draft.schedule === 'once' ? { kind: 'once', at: draft.at } : { kind: 'daily', time: draft.time },
    action: draft.action === 'command' ? { kind: 'command', command: draft.command } : { kind: draft.action as 'shutdown' | 'restart' },
  }
  busy.value = true
  try {
    await backend.saveAutomationTask(task, projectPath.value)
    editing.value = false
    notice.value = '任务已保存。'
    await refresh()
  } catch (value) { error.value = `保存失败：${errorText(value)}` }
  finally { busy.value = false }
}
async function toggle(task: AutomationTask) {
  busy.value = true
  try { await backend.saveAutomationTask({ ...task, enabled: !task.enabled }, projectPath.value); await refresh() }
  catch (value) { error.value = `更新失败：${errorText(value)}` }
  finally { busy.value = false }
}
async function remove(task: AutomationTask) {
  if (!await appConfirm(`删除自动任务“${task.title}”？`, '删除自动任务', '删除')) return
  busy.value = true
  try {
    await backend.deleteAutomationTask(task.scope, task.id, projectPath.value)
    if (editing.value && draft.id === task.id && draft.scope === task.scope) editing.value = false
    await refresh()
  } catch (value) { error.value = `删除失败：${errorText(value)}` }
  finally { busy.value = false }
}
function actionLabel(task: AutomationTask) { return task.action.kind === 'shutdown' ? '关闭电脑' : task.action.kind === 'restart' ? '重启电脑' : '执行命令' }
function statusLabel(task: AutomationTask) {
  const labels: Record<string, string> = { success: '成功', failed: '失败', running: '执行中', missed: '已跳过', skipped: '已跳过', error: '失败' }
  return task.lastStatus ? labels[task.lastStatus] ?? task.lastStatus : '尚未执行'
}
watch(projectPath, () => { editing.value = false; void refresh() }, { immediate: true })
onMounted(() => { if (!props.preview) refreshTimer = setInterval(() => { if (!busy.value) void refresh(true) }, 15000) })
onBeforeUnmount(() => { request++; if (refreshTimer) clearInterval(refreshTimer) })
</script>

<template>
  <section class="settings-content-section automation-panel">
    <div class="settings-section-heading"><div class="section-title">自动任务</div></div>
    <div class="settings-block settings-row-group">
      <div class="settings-option-row">
        <div class="settings-main"><div class="settings-subtitle">执行范围</div><div class="settings-path">SuperHigh 运行期间按本机时间执行；退出或休眠时错过的任务不补跑。</div><div class="settings-path">项目任务按已登记的工作区执行，切换工作区不取消计时。</div></div>
      </div>
    </div>
    <div class="automation-toolbar">
      <div class="automation-filters" aria-label="任务来源">
        <button v-for="scope in (['all', 'system', 'global', 'project'] as const)" :key="scope" class="ghost-button small" :class="{ selected: filter === scope }" @click="filter = scope">{{ scope === 'all' ? '全部' : AUTOMATION_SCOPE_LABELS[scope] }}</button>
      </div>
      <div class="settings-inline-actions"><button class="ghost-button small" :disabled="preview || loading || busy" aria-label="刷新自动任务" @click="refresh()"><RefreshCw :size="14" /></button><button class="primary-button small" :disabled="preview || busy" @click="create"><Plus :size="14" />新建</button></div>
    </div>
    <p v-if="preview" class="settings-footnote">请在桌面应用中管理自动任务。</p>
    <p v-if="error" class="automation-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="settings-footnote" role="status">{{ notice }}</p>
    <form v-if="editing" class="settings-block automation-editor" aria-label="编辑自动任务" @submit.prevent="save">
      <div class="automation-field"><label for="automation-title">名称</label><input id="automation-title" v-model="draft.title" class="settings-input" required :disabled="busy" /></div>
      <div class="automation-field"><label for="automation-scope">来源</label><select id="automation-scope" v-model="draft.scope" class="settings-input" :disabled="busy || !isNew"><option v-if="draft.scope === 'system'" value="system">系统</option><option value="global">全局</option><option value="project" :disabled="!projectPath">项目</option></select></div>
      <div v-if="draft.scope === 'project'" class="settings-path">{{ projectPath }}</div>
      <div class="automation-field"><label for="automation-schedule">重复</label><select id="automation-schedule" v-model="draft.schedule" class="settings-input" :disabled="busy"><option value="once">仅一次</option><option value="daily">每天</option></select></div>
      <div class="automation-field"><label for="automation-time">执行时间</label><input id="automation-time" v-model="draft.at" v-if="draft.schedule === 'once'" type="datetime-local" class="settings-input" required :disabled="busy" /><input id="automation-time" v-else v-model="draft.time" type="time" class="settings-input" required :disabled="busy" /></div>
      <div class="automation-field"><label for="automation-action">操作</label><select id="automation-action" v-model="draft.action" class="settings-input" :disabled="busy"><option value="shutdown">关闭电脑</option><option value="restart">重启电脑</option><option v-if="draft.scope !== 'system'" value="command">执行命令</option></select></div>
      <div v-if="draft.action === 'command'" class="automation-command"><label for="automation-command">命令（PowerShell）</label><textarea id="automation-command" v-model="draft.command" class="settings-input" required :disabled="busy" rows="3" spellcheck="false" /><p class="settings-footnote">项目任务在所属工作区执行，全局任务在应用数据目录执行；命令最多运行 5 分钟。</p></div>
      <div v-else class="settings-path">到时将{{ draft.action === 'restart' ? '重启' : '关闭' }}电脑，请先保存工作。</div>
      <div class="automation-field"><span>启用</span><button type="button" class="toggle-button settings-switch" role="switch" :aria-checked="draft.enabled" aria-label="启用任务" :class="{ active: draft.enabled }" :disabled="busy" @click="draft.enabled = !draft.enabled"><span /></button></div>
      <div class="settings-inline-actions"><button class="primary-button small" type="submit" :disabled="busy">{{ busy ? '正在保存…' : '保存' }}</button><button class="ghost-button small" type="button" :disabled="busy" @click="editing = false">取消</button></div>
    </form>
    <div class="automation-list" :aria-busy="loading">
      <div v-for="task in visibleTasks" :key="`${task.scope}:${task.id}`" class="automation-task">
        <div class="automation-task-main"><SourceBadge :kind="task.scope === 'system' ? 'command' : task.scope" /><button class="automation-task-title" :disabled="preview || busy" @click="edit(task)">{{ task.title }}</button><button class="toggle-button settings-switch" role="switch" :aria-checked="task.enabled" :aria-label="`${task.title}启用`" :class="{ active: task.enabled }" :disabled="preview || busy" @click="toggle(task)"><span /></button></div>
        <div class="settings-path">{{ actionLabel(task) }} · {{ automationScheduleText(task.schedule) }}</div>
        <div class="settings-path">下次执行：{{ task.enabled ? automationTime(task.nextRun) : '未启用' }}</div>
        <div class="settings-path">上次结果：{{ statusLabel(task) }}<template v-if="task.lastRun"> · {{ automationTime(task.lastRun) }}</template></div>
        <div v-if="task.lastError" class="automation-error">{{ task.lastError }}</div>
        <div class="settings-inline-actions automation-task-actions"><button class="ghost-button small" :disabled="preview || busy" @click="edit(task)">编辑</button><button v-if="task.scope !== 'system'" class="ghost-button small" :disabled="preview || busy" :aria-label="`删除${task.title}`" @click="remove(task)"><Trash2 :size="13" />删除</button></div>
      </div>
      <div v-if="!visibleTasks.length && !loading && !error && !preview" class="empty-hint">{{ filter === 'all' ? '暂无自动任务' : `暂无${AUTOMATION_SCOPE_LABELS[filter]}任务` }}</div>
      <div v-if="loading && !tasks.length" class="settings-footnote">正在读取任务…</div>
    </div>
  </section>
</template>

<style scoped>
.automation-panel { container-type: inline-size; }
.automation-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.automation-filters { display: flex; gap: 4px; overflow-x: auto; min-width: 0; }
.automation-filters button { flex: none; }
.automation-filters .selected { color: var(--color-accent-blue); background: var(--color-bg-hover); }
.automation-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--color-accent-red); overflow-wrap: anywhere; }
.automation-editor { display: flex; flex-direction: column; gap: 12px; }
.automation-field { display: flex; gap: 16px; align-items: center; justify-content: space-between; font-size: 13px; }
.automation-field > label { flex: none; }
.automation-field > .settings-input { width: 65%; }
.automation-command { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.automation-command textarea { width: 100%; height: auto; resize: vertical; font-family: var(--font-mono); font-weight: var(--font-mono-weight); }
.automation-task { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 14px 0; border-bottom: 1px solid var(--color-border); }
.automation-task-main { display: flex; align-items: center; gap: 8px; }
.automation-task-title { flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 13px; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.automation-task-actions { margin-top: 4px; }
@container (max-width: 400px) { .automation-toolbar { gap: 4px; } .automation-filters { gap: 0; } .automation-filters button { padding-inline: 6px; } .automation-field { gap: 8px; } }
</style>
