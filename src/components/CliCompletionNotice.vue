<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { X } from 'lucide-vue-next'
import CliProviderIcon from '@/components/icons/CliProviderIcon.vue'
import { backend, isTauri } from '@/lib/tauri'
import { applyTheme, registerCustomThemes } from '@/lib/theme'
import { applyFontStyle, registerCustomFonts, registerCustomFontStyles } from '@/lib/fontStyles'
import { cliProviderLabel } from '@/lib/cliProviders'
import { conversationColor, formatWorkDuration, noticeLinkTarget, NOTICE_OPEN_FILE_EVENT, type CompletionNotice } from '@/lib/cliCompletion'
import { renderMarkdown } from '@/lib/markdown'
const props = defineProps<CompletionNotice>()
const noticeElement = ref<HTMLElement | null>(null)
const accentColor = computed(() => conversationColor(props.conversationId || props.title || props.provider))
const providerName = computed(() => cliProviderLabel(props.provider))
// 只保留 CLI 进程的标题与回答；标题缺失时退回本轮请求，再退回产品名。
const heading = computed(() => props.title.trim() || props.task.trim() || providerName.value)
const answerHtml = computed(() => props.answer.trim() ? renderMarkdown(props.answer) : '')
const workDuration = computed(() => formatWorkDuration(props.durationMs))
const choices = ref<Record<string, string>>({})
const notes = ref<Record<string, string>>({})
const multi = ref<Record<string, string[]>>({})
function toggleMulti(id: string, label: string) {
  const current = multi.value[id] ?? []
  multi.value[id] = current.includes(label) ? current.filter(item => item !== label) : [...current, label]
}
function selected(id: string) { return multi.value[id]?.length ? multi.value[id] : choices.value[id] ? [choices.value[id]] : [] }
const submitting = ref(false)
const active = ref(false)
const planError = ref('')
let pollTimer: ReturnType<typeof setTimeout> | undefined
let resolvedTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const canSubmit = computed(() => active.value && !submitting.value && props.planRequest?.questions.every(q => selected(q.id).length || notes.value[q.id]?.trim()))
async function checkPlan() {
  const plan = props.planRequest
  if (!plan || !props.sessionId || disposed) return
  try {
    const pending = await backend.getCliPlanRequest(props.sessionId, plan.connection, plan.requestId)
    if (disposed) return
    active.value = !!pending
    planError.value = pending ? '' : '该 Plan 问题已结束，请回到原会话查看'
    if (!pending) {
      resolvedTimer = setTimeout(closeNotice, 3000)
      return
    }
  } catch (error) {
    active.value = false
    planError.value = String(error)
  }
  if (!disposed) pollTimer = setTimeout(() => { void checkPlan() }, 1000)
}
async function submitPlan() {
  const plan = props.planRequest
  if (!plan || !props.sessionId || !canSubmit.value) return
  submitting.value = true
  planError.value = ''
  const answers = Object.fromEntries(plan.questions.map(q => [q.id, [...selected(q.id), notes.value[q.id]?.trim()].filter((v): v is string => !!v)]))
  try {
    await backend.replyCliPlan(props.sessionId, plan.connection, plan.requestId, answers)
    closeNotice()
  } catch (error) { planError.value = String(error) }
  finally { submitting.value = false }
}
onBeforeUnmount(() => { disposed = true; clearTimeout(pollTimer); clearTimeout(resolvedTimer) })
onMounted(async () => {
  if (props.planRequest) void checkPlan()
  try {
    const settings = await backend.getSettings()
    registerCustomThemes(settings.customThemes ?? [])
    registerCustomFonts(settings.customFonts)
    registerCustomFontStyles(settings.customFontStyles, settings.customFonts)
    applyTheme(settings.themeId)
    applyFontStyle(settings.fontStyleId, settings.customFonts, settings.customFontStyles)
  } catch (error) { console.error('读取管家通知样式失败', error) }
  await nextTick()
  await document.fonts.ready
  // 回报内容实际高度，原生窗口据此收缩，短回答不留大片空白。
  if (isTauri()) await emit(`${getCurrentWindow().label}-ready`, naturalHeight())
})
function naturalHeight() {
  const notice = noticeElement.value
  if (!notice) return 0
  notice.classList.add('measuring')
  const height = Math.ceil(notice.getBoundingClientRect().height)
  notice.classList.remove('measuring')
  return height
}
function closeNotice() { void getCurrentWindow().close() }
// 通知窗口不能自行导航：文件链接交给主窗口在代码预览打开，网页链接交给系统浏览器。
function handleAnswerClick(event: MouseEvent) {
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (!anchor) return
  event.preventDefault()
  const target = noticeLinkTarget(anchor.getAttribute('href') ?? '', props.workspace)
  if (!target || !isTauri()) return
  if (target.kind === 'url') { void backend.openUrl(target.url).catch(() => undefined); return }
  void emit(NOTICE_OPEN_FILE_EVENT, target).then(closeNotice)
}
function holdNotice(hover: boolean) {
  if (isTauri()) void emit(`${getCurrentWindow().label}-hold`, hover)
}
</script>

<template>
  <section ref="noticeElement" class="cli-completion-notice" :style="{ '--notice-accent': accentColor }" role="status" aria-live="polite" @pointerenter="holdNotice(true)" @pointerleave="holdNotice(false)">
    <header class="notice-header">
      <span class="notice-icon" :title="providerName"><CliProviderIcon :provider="provider" :size="16" /></span>
      <strong :title="heading">{{ heading }}</strong>
      <span v-if="workDuration && !planRequest" class="notice-duration" :title="`本轮工作了 ${workDuration}`">工作了 {{ workDuration }}</span>
      <button class="notice-close" type="button" aria-label="关闭管家通知" @click="closeNotice"><X :size="14" /></button>
    </header>
    <form v-if="planRequest" class="notice-plan" @submit.prevent="submitPlan">
      <fieldset v-for="question in planRequest.questions" :key="question.id" :disabled="!active || submitting">
        <legend>{{ question.header || 'Plan 问题' }}</legend>
        <div class="markdown-body" @click="handleAnswerClick" v-html="renderMarkdown(question.question)" />
        <label v-for="option in question.options" :key="option.label" class="notice-option" :class="{ selected: question.multiSelect ? multi[question.id]?.includes(option.label) : choices[question.id] === option.label }">
          <input v-if="question.multiSelect" type="checkbox" :value="option.label" :checked="multi[question.id]?.includes(option.label)" @change="toggleMulti(question.id, option.label)">
          <input v-else v-model="choices[question.id]" type="radio" :name="question.id" :value="option.label">
          <span><strong>{{ option.label }}</strong><span v-if="option.description">{{ option.description }}</span></span>
        </label>
        <label v-if="question.options.length && !question.multiSelect" class="notice-option" :class="{ selected: choices[question.id] === '' }">
          <input v-model="choices[question.id]" type="radio" :name="question.id" value="">
          <span>其他回答</span>
        </label>
        <label class="notice-notes">{{ question.options.length ? '补充说明或其他回答' : '回答' }}
          <input v-if="question.isSecret" v-model="notes[question.id]" type="password" autocomplete="off">
          <textarea v-else v-model="notes[question.id]" rows="2" />
        </label>
      </fieldset>
      <p v-if="planError" role="alert">{{ planError }}</p>
      <button class="notice-submit" type="submit" :disabled="!canSubmit">{{ submitting ? '正在回复…' : '回复此 Plan' }}</button>
    </form>
    <div v-else-if="answerHtml" class="notice-answer markdown-body" @click="handleAnswerClick" v-html="answerHtml" />
    <p v-else class="notice-empty">未读取到最终回答，请回到原会话查看</p>
  </section>
</template>

<style scoped>
.cli-completion-notice {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 10px 10px 10px 14px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--notice-accent);
  font-family: var(--font-ui);
  overflow: hidden;
}
.cli-completion-notice.measuring { height: auto; }
.cli-completion-notice.measuring .notice-answer { flex: none; overflow: visible; }
.notice-header { display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-width: 0; }
.notice-icon { display: grid; place-items: center; flex: 0 0 auto; width: 24px; height: 24px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-primary); }
strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: var(--sh-weight-emphasis); line-height: 24px; }
.notice-duration { flex: 0 0 auto; color: var(--color-text-secondary); font-size: 12px; line-height: 24px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.notice-close { flex: 0 0 auto; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.notice-close:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.notice-answer { flex: 1; min-height: 0; overflow: auto; margin-top: 8px; padding-right: 4px; font-size: 12.5px; line-height: 1.6; }
.notice-answer :deep(> :first-child) { margin-top: 0; }
.notice-answer :deep(> :last-child) { margin-bottom: 0; }
.notice-answer :deep(h1), .notice-answer :deep(h2), .notice-answer :deep(h3), .notice-answer :deep(h4) { margin: 8px 0 4px; font-size: 13px; }
.notice-answer :deep(p), .notice-answer :deep(ul), .notice-answer :deep(ol), .notice-answer :deep(pre) { margin: 0 0 6px; }
.notice-empty { margin: 8px 0 0; font-size: 12px; color: var(--color-text-secondary); }
.notice-plan { min-height: 0; overflow: auto; margin-top: 8px; font-size: 13px; }
.notice-plan fieldset { min-width: 0; margin: 0 0 10px; padding: 8px; border: 1px solid var(--color-border); }
.notice-plan legend { font-weight: var(--sh-weight-emphasis); padding: 0 4px; }
.notice-plan .markdown-body { font-size: inherit; overflow-wrap: anywhere; }
.notice-option { display: flex; gap: 6px; padding: 6px; margin-top: 4px; border: 1px solid var(--color-border); cursor: pointer; }
.notice-option.selected { border-color: var(--notice-accent); background: var(--color-bg-hover); }
.notice-option > span { min-width: 0; overflow-wrap: anywhere; }
.notice-option strong { display: block; font-size: inherit; white-space: normal; line-height: 1.5; }
.notice-option span span { display: block; color: var(--color-text-secondary); font-size: 12px; }
.notice-notes { display: grid; gap: 4px; margin-top: 8px; color: var(--color-text-secondary); }
.notice-notes textarea, .notice-notes input { box-sizing: border-box; width: 100%; padding: 6px; font: inherit; color: var(--color-text-primary); background: var(--color-bg-primary); border: 1px solid var(--color-border); resize: vertical; }
.notice-submit { padding: 6px 10px; border: 1px solid var(--notice-accent); border-radius: 3px; background: var(--color-bg-primary); color: var(--color-text-primary); font: inherit; cursor: pointer; }
.notice-submit:disabled { opacity: .5; cursor: default; }
.notice-plan [role="alert"] { color: var(--color-text-secondary); }
.measuring .notice-plan { overflow: visible; }
</style>
