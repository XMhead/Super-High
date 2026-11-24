<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { X } from 'lucide-vue-next'
import CliProviderIcon from '@/components/icons/CliProviderIcon.vue'
import CliQuestionForm from './CliQuestionForm.vue'
import { backend, isTauri } from '@/lib/tauri'
import { applyTheme, registerCustomThemes } from '@/lib/theme'
import { applyFontStyle, registerCustomFonts, registerCustomFontStyles } from '@/lib/fontStyles'
import { cliProviderLabel } from '@/lib/cliProviders'
import { conversationColor, formatWorkDuration, NOTICE_OPEN_FILE_EVENT, NOTICE_OPEN_QUESTION_EVENT, type CompletionNotice } from '@/lib/cliCompletion'
import { linkWorkspacePaths, renderWorkspaceMarkdown } from '@/lib/workspacePathLinks'
import { targetFromAnchor } from '@/lib/linkTargets'
const props = defineProps<CompletionNotice>()
const noticeElement = ref<HTMLElement | null>(null)
const accentColor = computed(() => conversationColor(props.conversationId || props.title || props.provider))
const providerName = computed(() => cliProviderLabel(props.provider))
// 只保留 CLI 进程的标题与回答；标题缺失时退回本轮请求，再退回产品名。
const heading = computed(() => props.title.trim() || props.task.trim() || providerName.value)
const answerHtml = ref('')
const pathError = ref('')
let pathSequence = 0
watch([() => props.answer, () => props.workspace], async ([answer, workspace]) => {
  const sequence = ++pathSequence
  const html = answer.trim() ? renderWorkspaceMarkdown(answer, workspace) : ''
  answerHtml.value = html
  const linked = await linkWorkspacePaths(html, workspace, path => backend.resolveTerminalPath(path))
  if (!disposed && sequence === pathSequence) answerHtml.value = linked
}, { immediate: true })
const workDuration = computed(() => formatWorkDuration(props.durationMs))
const submitting = ref(false)
const active = ref(false)
const planError = ref('')
let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let closing = false
let unlistenExit: UnlistenFn | undefined
const currentPlan = ref(props.planRequest)
async function checkPlan() {
  const plan = props.planRequest
  if (!plan || !props.sessionId || disposed || closing || submitting.value) return
  try {
    const pending = await backend.getCliPlanRequest(props.sessionId, plan.connection, plan.requestId)
    if (disposed || closing || submitting.value) return
    // A successful empty lookup means the original request was answered or ended.
    // Transport failures reject separately so they cannot discard an unfinished answer.
    if (!pending) { active.value = false; closeNotice(); return }
    active.value = true
    currentPlan.value = pending
    planError.value = ''
  } catch (error) {
    if (disposed || closing || submitting.value) return
    active.value = false
    planError.value = String(error)
  }
  if (!disposed) pollTimer = setTimeout(() => { void checkPlan() }, 1000)
}
async function submitPlan(answers: Record<string, string[]>) {
  const plan = currentPlan.value
  if (!plan || !props.sessionId || !active.value || submitting.value) return
  submitting.value = true
  clearTimeout(pollTimer)
  planError.value = ''

  try {
    await backend.replyCliPlan(props.sessionId, plan.connection, plan.requestId, answers)
    closeNotice()
  } catch (error) { planError.value = String(error) }
  finally {
    submitting.value = false
    if (!disposed && !closing) pollTimer = setTimeout(() => { void checkPlan() }, 1000)
  }
}
onBeforeUnmount(() => { disposed = true; clearTimeout(pollTimer); unlistenExit?.() })
onMounted(async () => {
  if (props.planRequest) void checkPlan()
  if (props.asyncQuestion && props.sessionId && isTauri()) {
    try {
      const unlisten = await listen<{ sessionId: string }>('terminal-exit', event => {
        if (event.payload.sessionId === props.sessionId) closeNotice()
      })
      if (disposed) unlisten(); else unlistenExit = unlisten
    } catch (error) { console.error('监听会话退出失败', error) }
    try {
      const live = await backend.listLiveTerminalSessionIds()
      if (!live.includes(props.sessionId)) { closeNotice(); return }
    } catch (error) { console.error('检查会话状态失败', error) }
    if (disposed) return
  }
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
function closeNotice() {
  if (closing || disposed) return
  closing = true
  clearTimeout(pollTimer)
  void getCurrentWindow().close()
}
async function openQuestion() {
  if (!props.sessionId || !isTauri()) return
  await emit(NOTICE_OPEN_QUESTION_EVENT, { sessionId: props.sessionId, workspace: props.workspace })
  closeNotice()
}
// 通知窗口不能自行导航：文件链接交给主窗口在代码预览打开，网页链接交给系统浏览器。
async function handleAnswerClick(event: MouseEvent) {
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (!anchor) return
  event.preventDefault()
  const target = targetFromAnchor(anchor, props.workspace)
  if (!target || !isTauri()) return
  if (target.kind === 'url') { void backend.openUrl(target.url).catch(() => undefined); return }
  try {
    pathError.value = ''
    const resolved = await backend.resolveTerminalPath(target.path)
    if (!resolved) throw new Error(`未找到路径：${target.path}`)
    if (resolved.isFile) await emit(NOTICE_OPEN_FILE_EVENT, { ...target, path: resolved.path })
    else await backend.openPath(resolved.path)
    closeNotice()
  } catch (error) { pathError.value = error instanceof Error ? error.message : String(error) }
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
    <CliQuestionForm v-if="currentPlan" :request="currentPlan" :disabled="!active" :submitting="submitting" :error="planError" :async-question="asyncQuestion"
      @submit="submitPlan" @answer-click="handleAnswerClick" />
    <div v-else-if="answerHtml" class="notice-answer markdown-body" @click="handleAnswerClick" v-html="answerHtml" />
    <button v-if="asyncQuestion && !currentPlan && sessionId" class="notice-submit" type="button" @click="openQuestion">返回原会话回答</button>
    <p v-if="pathError" class="notice-plan-error" role="alert">{{ pathError }}</p>
    <p v-else-if="!planRequest && !answerHtml" class="notice-empty">未读取到最终回答，请回到原会话查看</p>
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
.cli-question-form { margin-top: 8px; }
.notice-submit { padding: 6px 10px; border: 1px solid var(--notice-accent); border-radius: 3px; background: var(--color-bg-primary); color: var(--color-text-primary); font: inherit; cursor: pointer; }
.measuring :deep(.notice-plan), .measuring :deep(.notice-questions) { overflow: visible; }
</style>
