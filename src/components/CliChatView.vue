<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowUp, Brain, Check, ChevronDown, ChevronRight, Copy, LoaderCircle, MessageSquareText, Square, Wrench, X } from 'lucide-vue-next'

import CliProviderIcon from './icons/CliProviderIcon.vue'
import CliChatAgents from './CliChatAgents.vue'
import { cliProviderLabel } from '@/lib/cliProviders'
import { conversationColor, formatWorkDuration, noticeLinkTarget } from '@/lib/cliCompletion'
import { renderMarkdown } from '@/lib/markdown'
import { cleanCliChatText, concreteModelOption, modelFromCommandOutput, modelFromMenuOption, modelFromScreen, modelWithReasoning, reasoningOption } from '@/lib/cliChatText'
import { backend, isTauri, type CliChatStep, type CliChatTranscript, type CliChatTurn } from '@/lib/tauri'
import { detectSlashCommands, detectTerminalMenu, hasNativeTerminalPanel, terminalChatActivity, type TerminalScreenLine } from '@/lib/terminalMenu'
import { useWorkspaceStore } from '@/stores/workspace'
import type { TerminalSession } from '@/types'

const props = defineProps<{
  session: TerminalSession
  screenLines: () => TerminalScreenLine[]
  /** Bumped after every xterm write so menu detection follows the real CLI screen. */
  screenRevision: number
  sharedComposer?: boolean
  submitDraft?: () => Promise<string | undefined>
  canSend?: boolean
  confirmCompletion?: () => boolean
}>()
const emit = defineEmits<{ 'draft-keydown': [event: KeyboardEvent]; 'draft-paste': [event: ClipboardEvent]; 'native-interaction': [active: boolean] }>()
const draft = defineModel<string>('draft', { default: '' })

const store = useWorkspaceStore()
// End + Ctrl+U clears the CLI's single-line editor before chat mode writes into it.
const CLEAR_LINE = '\u001b[F\u0015'
// Poll quickly only while a turn can still change; idle sessions keep the slower rate.
const POLL_MS = 1000
const ACTIVE_POLL_MS = 300

const transcript = ref<CliChatTranscript | null>(null)
const loadError = ref('')
const sendError = ref('')
const submitting = ref(false)
const input = ref<HTMLTextAreaElement | null>(null)
defineExpose({ input, runSlash })
const scroller = ref<HTMLElement | null>(null)
const pending = ref<{ text: string; at: number; baseline: string } | null>(null)
const expanded = ref<Record<string, boolean>>({})
const slashIndex = ref(0)
const modelRequested = ref(false)
const now = ref(Date.now())
const copiedId = ref('')
let mirrored = false
let pollTimer: number | undefined
let clockTimer: number | undefined
let modelTimer: number | undefined
let disposed = false
let mirrorTask: Promise<unknown> = Promise.resolve()
let mirrorRevision = 0
let menuTask: Promise<unknown> | undefined
const settled = ref(new Map<string, { at: number; interrupted: boolean }>())
let idleTurn = ''
let idlePolls = 0
let lastSnapshot = ''
let stickToBottom = true
let nativeTimer: number | undefined
let resizeObserver: ResizeObserver | undefined
const loaded = ref(false)
const markdownCache = new Map<string, string>()
// xterm can repaint many times per frame; menu detection only needs the latest frame.
const screenTick = ref(props.screenRevision)
let screenFrame: number | undefined
watch(() => props.screenRevision, () => {
  if (screenFrame !== undefined) return
  screenFrame = window.requestAnimationFrame(() => { screenFrame = undefined; screenTick.value = props.screenRevision })
})

const providerName = computed(() => cliProviderLabel(props.session.providerKind))
const accent = computed(() => conversationColor(props.session.nativeConversationId || props.session.id))
const turns = computed(() => (transcript.value?.turns ?? []).map(turn => ({
  ...turn, prompt: cleanCliChatText(turn.prompt), answer: cleanCliChatText(turn.answer),
  ...(settled.value.has(turn.id) && turn.completedAt === null ? {
    completedAt: settled.value.get(turn.id)!.at,
    interrupted: settled.value.get(turn.id)!.interrupted,
    answer: cleanCliChatText(turn.answer || turn.steps.filter(step => step.kind === 'text').at(-1)?.detail || ''),
  } : {}),
  steps: turn.steps.map(step => ({ ...step, title: cleanCliChatText(step.title), detail: cleanCliChatText(step.detail) })),
})))
const lastTurn = computed(() => turns.value.at(-1))
const running = computed(() => submitting.value || Boolean(pending.value) || Boolean(lastTurn.value && lastTurn.value.completedAt === null))
const selectedModel = ref('')
const selectedEffort = ref('')
const observedModel = ref('')
const modelLabel = computed(() => {
  const model = selectedModel.value || observedModel.value || concreteModelOption(transcript.value?.model ?? '')
  return model ? modelWithReasoning(model, selectedEffort.value) : '选择模型'
})
const slashMode = computed(() => /^\/\S*$/.test(draft.value))
const screen = computed(() => {
  void screenTick.value
  return props.screenLines()
})
const slashCommands = computed(() => slashMode.value ? detectSlashCommands(screen.value) : [])
const liveMenu = computed(() => slashMode.value ? null : detectTerminalMenu(screen.value))
let lastScreenModel = ''
watch(() => modelFromScreen(screen.value), model => {
  // Menus and blank repaint frames can hide and then reveal the same old header.
  if (model && model !== lastScreenModel) {
    lastScreenModel = model
    observedModel.value = model
    selectedModel.value = ''
    selectedEffort.value = ''
  }
}, { immediate: true })
watch(() => cleanCliChatText(transcript.value?.model ?? ''), (model, previous) => {
  // Logs can replace historical screen text, but never the CLI's current status.
  if (model && model !== previous && !modelFromScreen(screen.value, true)
    && (previous || (!selectedModel.value && !observedModel.value))) {
    observedModel.value = model
    selectedModel.value = ''
    selectedEffort.value = ''
  }
})
watch(() => {
  const latest = turns.value.at(-1)
  return latest?.prompt === '/model' ? modelFromCommandOutput(latest.answer) : undefined
}, model => {
  if (model && !modelFromScreen(screen.value, true) && (modelRequested.value || !observedModel.value)) { selectedModel.value = model; selectedEffort.value = '' }
})
// Reveal native panels at once, but ignore the blank frame of a repaint before hiding them again.
watch(() => !slashMode.value && hasNativeTerminalPanel(screen.value), active => {
  window.clearTimeout(nativeTimer)
  if (active) emit('native-interaction', true)
  else nativeTimer = window.setTimeout(() => emit('native-interaction', false), 300)
}, { immediate: true })
const agents = computed(() => transcript.value?.agents ?? [])
const unassignedAgents = computed(() => agents.value.filter(agent => !turns.value.some(turn => turn.id === agent.parentTurnId)))
const empty = computed(() => loaded.value && !turns.value.length && !pending.value && !agents.value.length)

function turnKey(turn: CliChatTurn | undefined) { return turn ? `${turn.id}:${turn.prompt}` : '' }

async function poll() {
  if (disposed) return
  if (!isTauri()) { loaded.value = true; return }
  const sessionId = props.session.id
  try {
    const next = await backend.readTerminalChat(sessionId)
    if (disposed || props.session.id !== sessionId) return
    loadError.value = ''
    loaded.value = true
    // An unchanged log must not rebuild every turn and its rendered Markdown.
    const snapshot = JSON.stringify(next)
    if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; transcript.value = next }
    const latest = next?.turns.at(-1)
    if (latest && (latest.completedAt !== null || terminalChatActivity(screen.value) === 'busy')) settled.value.delete(latest.id)
    if (pending.value && latest && turnKey(latest) !== pending.value.baseline
      && latest.startedAt >= pending.value.at - 2000) pending.value = null
    // Logs can end with a user/error record and no completion record. Require
    // several idle observations, so a repaint between submission and startup
    // cannot finish an active task.
    if (['claude', 'codex'].includes(props.session.providerKind)
      && latest?.completedAt === null && terminalChatActivity(screen.value) === 'idle') {
      const key = JSON.stringify(latest)
      idlePolls = idleTurn === key ? idlePolls + 1 : 1
      idleTurn = key
      if (idlePolls === 3) settled.value.set(latest.id, { at: Date.now(), interrupted: !latest.answer && !latest.steps.some(step => step.kind === 'text') })
    } else { idleTurn = ''; idlePolls = 0 }
  } catch (error) {
    if (props.session.id === sessionId) loadError.value = `读取会话日志失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (!disposed && pending.value && Date.now() - pending.value.at >= 15000) {
      const text = pending.value.text
      pending.value = null
      sendError.value = '未能确认 CLI 已接收消息，请切到工作模式检查终端后重试。'
      if (!draft.value) draft.value = text
    }
    if (!disposed) schedulePoll(running.value ? ACTIVE_POLL_MS : POLL_MS)
  }
}

function schedulePoll(delay: number) {
  window.clearTimeout(pollTimer)
  pollTimer = window.setTimeout(() => { void poll() }, delay)
}

function isNearBottom() {
  const el = scroller.value
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

/** Follow new output only while the reader is already at the bottom. */
function onScroll() { stickToBottom = isNearBottom() }

async function scrollToBottom(force = false) {
  if (force) stickToBottom = true
  await nextTick()
  const el = scroller.value
  if (el && stickToBottom) el.scrollTop = el.scrollHeight
}

function markdown(text: string) {
  let html = markdownCache.get(text)
  if (html === undefined) {
    html = renderMarkdown(text)
    if (markdownCache.size > 200) markdownCache.clear()
    markdownCache.set(text, html)
  }
  return html
}

function write(data: string, sessionId = props.session.id) {
  return store.writeTerminalInput(data, sessionId)
}

/** Continue as soon as xterm reflects the input; the timeout only bounds a missing repaint. */
function waitForScreen(ready: () => boolean, timeout: number): Promise<boolean> {
  if (ready()) return Promise.resolve(true)
  return new Promise(resolve => {
    const stop = watch(screen, () => { if (ready()) finish(true) }, { flush: 'sync' })
    const timer = window.setTimeout(() => finish(ready()), timeout)
    function finish(value: boolean) { stop(); window.clearTimeout(timer); resolve(value) }
  })
}

const menuIdentity = (menu: ReturnType<typeof detectTerminalMenu>) => menu?.options.map(option => `${option.number}:${option.label}`).join('\n')

function queueMenuInput(action: (sessionId: string) => Promise<void>) {
  const sessionId = props.session.id
  const run = async () => {
    if (!disposed && props.session.id === sessionId) await action(sessionId)
  }
  const task = (menuTask ? menuTask.then(run) : run())
    .catch(error => { if (!disposed && props.session.id === sessionId) sendError.value = `输入 CLI 失败：${String(error)}` })
  menuTask = task
  void task.then(() => { if (menuTask === task) menuTask = undefined })
  return task
}

// The draft mirrors into the CLI line editor only while it is a slash command, so the CLI shows its own suggestions.
watch(draft, (value) => {
  if (submitting.value) return
  let data: string | undefined
  if (slashMode.value) {
    mirrored = true
    slashIndex.value = 0
    data = `${CLEAR_LINE}${value}`
  } else if (mirrored) {
    mirrored = false
    data = CLEAR_LINE
  }
  if (data !== undefined) {
    const revision = ++mirrorRevision
    const sessionId = props.session.id
    mirrorTask = mirrorTask.then(() => disposed || revision !== mirrorRevision || props.session.id !== sessionId ? undefined : write(data!, sessionId))
      .catch(error => { sendError.value = `输入 CLI 失败：${String(error)}` })
  }
}, { flush: 'sync', immediate: true })

watch(liveMenu, (menu, previous) => {
  if (menu) window.clearTimeout(modelTimer)
  else if (previous && modelRequested.value) {
    // Codex may briefly clear its screen between the model and effort pages.
    modelTimer = window.setTimeout(() => { if (!liveMenu.value) modelRequested.value = false }, 1000)
  }
})

async function runSlash(command: string) {
  if (submitting.value) return
  const sessionId = props.session.id
  submitting.value = true
  sendError.value = ''
  try {
    await mirrorTask
    if (disposed || props.session.id !== sessionId) return
    modelRequested.value = command.trim() === '/model'
    mirrored = false
    draft.value = ''
    const revision = props.screenRevision
    await write(`${CLEAR_LINE}${command}`, sessionId)
    // Ink needs a separate Enter. A visible draft confirms it consumed the command.
    await waitForScreen(() => props.screenRevision !== revision && screen.value.some(line => line.text.includes(command)), 200)
    if (disposed || props.session.id !== sessionId) return
    await write('\r', sessionId)
    store.appendTerminalConversationMessage({ id: crypto.randomUUID(), sessionId, role: 'user', content: command, timestamp: new Date().toISOString() })
  } catch (error) {
    if (disposed || props.session.id !== sessionId) return
    modelRequested.value = false
    sendError.value = `执行 CLI 命令失败：${String(error)}`
    draft.value = command
  } finally { submitting.value = false }
}

async function send() {
  if (submitting.value) return
  const text = draft.value.trim()
  if (!text && !(props.sharedComposer && props.canSend)) return
  if (props.confirmCompletion?.()) return
  if (slashMode.value) {
    const selected = slashCommands.value[slashIndex.value]?.command
    await runSlash(selected && selected.startsWith(text) ? selected : text)
    return
  }
  const baseline = turnKey(lastTurn.value)
  modelRequested.value = false
  submitting.value = true
  sendError.value = ''
  try {
    await mirrorTask
    if (disposed) return
    // Show the message immediately; the CLI write and its separate Enter take a few hundred ms.
    const at = Date.now()
    if (text) { pending.value = { text, at, baseline }; void scrollToBottom(true) }
    if (props.submitDraft) {
      if (mirrored) { mirrored = false; await write(CLEAR_LINE) }
      const sent = await props.submitDraft()
      if (sent) { pending.value = { text: sent, at, baseline }; void scrollToBottom(true); schedulePoll(ACTIVE_POLL_MS) }
      else { pending.value = null; sendError.value = '消息未发送，请检查终端状态后重试。' }
      return
    }
    draft.value = ''
    await write(CLEAR_LINE)
    if (await store.sendTerminalConversationMessage(props.session.id, text)) schedulePoll(ACTIVE_POLL_MS)
    else { pending.value = null; draft.value = text; sendError.value = '消息未发送，请检查终端状态后重试。' }
  } catch (error) {
    pending.value = null
    if (!draft.value) draft.value = text
    sendError.value = `发送失败：${String(error)}`
  } finally { submitting.value = false }
}

function stop() {
  pending.value = null
  void write('\u001b').catch(error => { sendError.value = `中断失败：${String(error)}` })
}

async function openModelMenu() {
  if (liveMenu.value) { await queueMenuInput(async sessionId => { await write('\u001b', sessionId) }); return }
  modelRequested.value = true
  window.clearTimeout(modelTimer)
  await runSlash('/model')
}

async function selectOption(index: number) {
  input.value?.focus()
  const identity = menuIdentity(liveMenu.value)
  await queueMenuInput(async sessionId => {
    const menu = liveMenu.value
    const option = menu?.options[index]
    if (!menu || !option || menuIdentity(menu) !== identity) return
    const delta = index - menu.selectedIndex
    const key = delta > 0 ? '\u001b[B' : '\u001b[A'
    // Separate writes and observed selection changes preserve Ink key boundaries.
    for (let step = 0; step < Math.abs(delta); step += 1) {
      const selected = liveMenu.value?.selectedIndex
      await write(key, sessionId)
      const updated = await waitForScreen(() => menuIdentity(liveMenu.value) !== identity || liveMenu.value?.selectedIndex !== selected, 1200)
      if (disposed || props.session.id !== sessionId || menuIdentity(liveMenu.value) !== identity) return
      if (!updated) { sendError.value = 'CLI 选项尚未更新，请重试。'; return }
    }
    if (!option.checkbox) {
      await write('\r', sessionId)
      if (!disposed && props.session.id === sessionId) rememberModelOption(option.label, option.detail, menu.options.some(option => reasoningOption(option.label)))
      await waitForScreen(() => menuIdentity(liveMenu.value) !== identity, 1200)
    }
  })
}

function rememberModelOption(label: string, detail: string, effortMenu: boolean) {
  if (!modelRequested.value) return
  const effort = reasoningOption(label)
  if (effort) selectedEffort.value = effort
  else if (!effortMenu) {
    const model = modelFromMenuOption(label, detail)
    if (model) { selectedModel.value = model; selectedEffort.value = '' }
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  const menuKeys: Record<string, string> = { ArrowDown: '\u001b[B', ArrowUp: '\u001b[A', ArrowLeft: '\u001b[D', ArrowRight: '\u001b[C', Enter: '\r' }
  if (liveMenu.value && menuKeys[event.key] && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault()
    void queueMenuInput(async sessionId => {
      const menu = liveMenu.value
      if (!menu) return
      const identity = menuIdentity(menu)
      await write(menuKeys[event.key]!, sessionId)
      if (event.key === 'Enter' && !disposed && props.session.id === sessionId) {
        const option = menu.options[menu.selectedIndex]!
        rememberModelOption(option.label, option.detail, menu.options.some(option => reasoningOption(option.label)))
      }
      // A clamped edge and horizontal keys may legitimately produce no repaint.
      const canMove = event.key === 'ArrowDown' ? menu.selectedIndex < menu.options.length - 1
        : event.key === 'ArrowUp' ? menu.selectedIndex > 0 : event.key === 'Enter'
      await waitForScreen(() => menuIdentity(liveMenu.value) !== identity || liveMenu.value?.selectedIndex !== menu.selectedIndex, canMove ? 1200 : 40)
    })
    return
  }
  emit('draft-keydown', event)
  if (event.defaultPrevented) return
  const commands = slashCommands.value
  if (commands.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    slashIndex.value = (slashIndex.value + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length
    return
  }
  if (commands.length && event.key === 'Tab') {
    event.preventDefault()
    const selected = commands[slashIndex.value]
    if (selected) draft.value = selected.command
    return
  }
  if (event.key === 'Escape') {
    if (liveMenu.value) { event.preventDefault(); void queueMenuInput(async sessionId => { await write('\u001b', sessionId) }); return }
    if (draft.value) { event.preventDefault(); draft.value = ''; return }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

function onMenuKeydown(event: KeyboardEvent) {
  // Clicking an option or the model button moves focus away from the textarea.
  if (event.target !== input.value && liveMenu.value) onKeydown(event)
}

function fitInput() {
  const el = input.value
  if (!el) return
  el.style.height = '0px'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}
watch(draft, () => { void nextTick(fitInput) })

function turnDuration(turn: CliChatTurn) {
  if (turn.completedAt === null) return formatWorkDuration(now.value - turn.startedAt)
  return formatWorkDuration(turn.durationMs ?? turn.completedAt - turn.startedAt)
}

function clock(ms: number | null) {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function stepCount(turn: CliChatTurn) {
  return turn.steps.filter(step => step.kind === 'tool').length
}

function thinkingLabel(turn: CliChatTurn) {
  const tools = stepCount(turn)
  const suffix = tools ? ` · 调用 ${tools} 次工具` : ''
  if (turn.completedAt === null) return `正在思考 ${turnDuration(turn)}${suffix}`
  return `${turn.interrupted ? '已中断' : '已处理'} ${turnDuration(turn)}${suffix}`
}

function latestStep(turn: CliChatTurn): CliChatStep | undefined {
  return turn.steps.at(-1)
}

function stepIcon(step: CliChatStep) {
  return step.kind === 'tool' ? Wrench : step.kind === 'think' ? Brain : MessageSquareText
}

function toggle(turn: CliChatTurn) {
  expanded.value[turn.id] = !expanded.value[turn.id]
}

async function copy(turn: CliChatTurn, text: string) {
  await navigator.clipboard?.writeText(text)
  copiedId.value = turn.id
  window.setTimeout(() => { if (copiedId.value === turn.id) copiedId.value = '' }, 1200)
}

function handleAnswerClick(event: MouseEvent) {
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (!anchor) return
  event.preventDefault()
  const target = noticeLinkTarget(anchor.getAttribute('href') ?? '', props.session.cwd)
  if (!target) return
  if (target.kind === 'url') void backend.openUrl(target.url).catch(() => undefined)
  else void store.openTerminalFileLink(target.path, target.lineNumber)
}

watch(() => props.session.id, () => {
  transcript.value = null
  lastSnapshot = ''
  loaded.value = false
  stickToBottom = true
  pending.value = null
  settled.value.clear()
  selectedModel.value = ''
  selectedEffort.value = ''
  observedModel.value = ''
  lastScreenModel = ''
  modelRequested.value = false
  mirrored = false
})

onMounted(() => {
  void poll()
  clockTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
  void nextTick(() => input.value?.focus())
  // Content can grow without a poll (agents, images, expanded steps); keep the bottom pinned.
  const column = scroller.value?.firstElementChild
  if (column && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => { void scrollToBottom() })
    resizeObserver.observe(column)
    resizeObserver.observe(scroller.value!)
  }
})

onBeforeUnmount(() => {
  disposed = true
  window.clearTimeout(pollTimer)
  window.clearTimeout(modelTimer)
  window.clearInterval(clockTimer)
  window.clearTimeout(nativeTimer)
  if (screenFrame !== undefined) window.cancelAnimationFrame(screenFrame)
  resizeObserver?.disconnect()
  if (mirrored) void write(CLEAR_LINE)
})
</script>

<template>
  <section class="cli-chat" :class="{ 'cli-chat--empty': empty && !slashMode && !liveMenu }" :style="{ '--chat-accent': accent }" aria-label="聊天模式" @keydown="onMenuKeydown">
    <div ref="scroller" class="cli-chat-scroll" @scroll.passive="onScroll">
      <div class="cli-chat-column">
        <h2 v-if="empty" class="cli-chat-welcome">我们要做什么？</h2>
        <article v-for="turn in turns" :key="turn.id" class="cli-chat-turn">
          <div v-if="turn.prompt" class="cli-chat-user">
            <div class="cli-chat-user-bubble">{{ turn.prompt }}</div>
            <button class="cli-chat-icon-button" type="button" title="复制" @click="copy(turn, turn.prompt)">
              <Check v-if="copiedId === turn.id" :size="13" />
              <Copy v-else :size="13" />
            </button>
          </div>
          <div v-if="turn.steps.length || turn.completedAt === null" class="cli-chat-thinking">
            <button class="cli-chat-thinking-toggle" type="button" :aria-expanded="!!expanded[turn.id]" @click="toggle(turn)">
              <LoaderCircle v-if="turn.completedAt === null" :size="13" class="cli-chat-spin" />
              <component :is="expanded[turn.id] ? ChevronDown : ChevronRight" v-else :size="13" />
              <span>{{ turn.completedAt === null && !turn.steps.length && !turn.answer ? '等待 CLI 响应' : thinkingLabel(turn) }}</span>
            </button>
            <div v-if="turn.completedAt === null && latestStep(turn) && !expanded[turn.id]" class="cli-chat-step cli-chat-step--latest">
              <component :is="stepIcon(latestStep(turn)!)" :size="13" />
              <span class="cli-chat-step-title">{{ latestStep(turn)!.title }}</span>
              <span class="cli-chat-step-detail">{{ latestStep(turn)!.detail }}</span>
            </div>
            <ol v-if="expanded[turn.id]" class="cli-chat-steps">
              <li v-for="(step, index) in turn.steps" :key="index" class="cli-chat-step" :class="`cli-chat-step--${step.kind}`">
                <component :is="stepIcon(step)" :size="13" />
                <span class="cli-chat-step-title">{{ step.title }}</span>
                <span class="cli-chat-step-detail" :title="step.detail">{{ step.detail }}</span>
              </li>
            </ol>
          </div>
          <CliChatAgents :key="`${session.id}:${turn.id}`" :agents="agents.filter(agent => agent.parentTurnId === turn.id)" :now="now" @answer-click="handleAnswerClick" />
          <section v-if="turn.answer" class="cli-chat-answer">
            <header class="cli-chat-answer-header">
              <span class="cli-chat-answer-icon" :title="providerName"><CliProviderIcon :provider="session.providerKind" :size="14" /></span>
              <strong>{{ providerName }}</strong>
              <span v-if="turn.completedAt !== null" class="cli-chat-answer-meta" :title="`本轮工作了 ${turnDuration(turn)}，完成于 ${clock(turn.completedAt)}`">
                工作了 {{ turnDuration(turn) }} · {{ clock(turn.completedAt) }}
              </span>
              <button class="cli-chat-icon-button" type="button" title="复制回答" @click="copy(turn, turn.answer)">
                <Check v-if="copiedId === turn.id" :size="13" />
                <Copy v-else :size="13" />
              </button>
            </header>
            <div class="cli-chat-answer-body markdown-body" @click="handleAnswerClick" v-html="markdown(turn.answer)" />
          </section>
          <p v-else-if="turn.interrupted" class="cli-chat-note">本轮已中断</p>
        </article>
        <CliChatAgents :key="`${session.id}:other-agents`" :agents="unassignedAgents" :now="now" @answer-click="handleAnswerClick" />
        <article v-if="pending" class="cli-chat-turn">
          <div class="cli-chat-user"><div class="cli-chat-user-bubble">{{ pending.text }}</div></div>
          <p class="cli-chat-note">等待 CLI 接收消息</p>
        </article>
        <p v-if="loadError" class="cli-chat-note cli-chat-error">{{ loadError }}</p>
        <p v-if="transcript?.agentError" class="cli-chat-note">子 Agent 记录查询失败：{{ transcript.agentError }}</p>
        <p v-if="sendError" class="cli-chat-note cli-chat-error" role="alert">{{ sendError }}</p>
      </div>
    </div>

    <div class="cli-chat-dock">
      <div class="cli-chat-column">
        <div v-if="liveMenu" class="cli-chat-popover" role="listbox" :aria-label="modelRequested ? '选择模型' : 'CLI 选项'">
          <div class="cli-chat-popover-title">
            <span>{{ modelRequested ? '选择模型' : 'CLI 选项' }}</span>
            <button class="cli-chat-icon-button" type="button" title="取消（Esc）" @click="write('\u001b')"><X :size="13" /></button>
          </div>
          <button
            v-for="(option, index) in liveMenu.options"
            :key="option.number"
            class="cli-chat-option"
            :class="{ active: index === liveMenu.selectedIndex }"
            type="button"
            role="option"
            :aria-selected="index === liveMenu.selectedIndex"
            @click="selectOption(index)"
          >
            <span class="cli-chat-option-label">{{ option.label }}</span>
            <span v-if="option.detail" class="cli-chat-option-detail">{{ option.detail }}</span>
            <Check v-if="index === liveMenu.selectedIndex" :size="13" class="cli-chat-option-check" />
          </button>
        </div>
        <div v-else-if="slashCommands.length && !sharedComposer" class="cli-chat-popover" role="listbox" aria-label="CLI 命令">
          <button
            v-for="(entry, index) in slashCommands"
            :key="entry.command"
            class="cli-chat-option"
            :class="{ active: index === slashIndex }"
            type="button"
            role="option"
            :aria-selected="index === slashIndex"
            @mouseenter="slashIndex = index"
            @mousedown.prevent
            @click="runSlash(entry.command)"
          >
            <span class="cli-chat-option-label">{{ entry.command }}</span>
            <span class="cli-chat-option-detail">{{ entry.description }}</span>
          </button>
        </div>
        <div class="cli-chat-composer">
          <slot name="completion" v-if="!liveMenu" />
          <slot name="attachments" />
          <textarea
            ref="input"
            v-model="draft"
            class="cli-chat-input"
            rows="1"
            :readonly="submitting"
            :placeholder="running ? '正在处理，可继续输入…' : `向 ${providerName} 发送消息，输入 / 查看命令`"
            @keydown="onKeydown"
            @paste="emit('draft-paste', $event)"
          />
          <div class="cli-chat-composer-bar">
            <span class="cli-chat-provider"><CliProviderIcon :provider="session.providerKind" :size="13" />{{ providerName }}</span>
            <button class="cli-chat-model" type="button" title="打开 CLI 的 /model 选择模型" @click="openModelMenu">
              <span>{{ modelLabel }}</span>
              <ChevronDown :size="12" />
            </button>
            <button v-if="running && !draft.trim() && !canSend" class="cli-chat-send" type="button" title="中断（Esc）" @click="stop">
              <Square :size="12" />
            </button>
            <button v-else class="cli-chat-send" type="button" title="发送（Enter）" :disabled="submitting || (sharedComposer ? !canSend : !draft.trim())" @click="send">
              <ArrowUp :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cli-chat {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg-secondary-solid);
  color: var(--color-text-primary);
  font-family: var(--font-ui);
}
.cli-chat-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.cli-chat-column { box-sizing: border-box; width: 100%; max-width: 820px; margin: 0 auto; padding: 0 20px; }
.cli-chat-scroll .cli-chat-column { padding-top: 20px; padding-bottom: 12px; }
.cli-chat--empty { justify-content: center; }
.cli-chat--empty .cli-chat-scroll { flex: 0 0 auto; overflow: visible; }
.cli-chat-welcome { margin: 0 0 8px; text-align: center; font-size: 22px; font-weight: var(--sh-weight-emphasis); }
.cli-chat-turn { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.cli-chat-user { display: flex; align-items: flex-end; flex-direction: column; gap: 2px; }
.cli-chat-user-bubble { max-width: 80%; padding: 8px 12px; border-radius: 8px; background: var(--color-bg-tertiary); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.55; }
.cli-chat-icon-button { display: grid; place-items: center; flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.cli-chat-icon-button:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.cli-chat-thinking { display: flex; flex-direction: column; gap: 4px; }
.cli-chat-thinking-toggle { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 2px 4px; border: 0; border-radius: 3px; background: transparent; color: var(--color-text-secondary); font: inherit; font-size: 12.5px; font-variant-numeric: tabular-nums; cursor: pointer; }
.cli-chat-thinking-toggle:hover { color: var(--color-text-primary); background: var(--color-bg-hover); }
.cli-chat-steps { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0 0 0 10px; border-left: 1px solid var(--color-border); list-style: none; }
.cli-chat-step { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 4px; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }
.cli-chat-step > svg { flex: 0 0 auto; }
.cli-chat-step--latest { padding-left: 14px; }
.cli-chat-step-title { flex: 0 0 auto; color: var(--color-text-primary); }
.cli-chat-step-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 11.5px; }
.cli-chat-step--text .cli-chat-step-detail, .cli-chat-step--think .cli-chat-step-detail { font-family: inherit; }
.cli-chat-answer { padding: 10px 12px 10px 14px; border: 1px solid var(--color-border); border-left: 3px solid var(--chat-accent); border-radius: 4px; background: var(--color-bg-secondary); }
.cli-chat-answer-header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cli-chat-answer-header strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: var(--sh-weight-emphasis); }
.cli-chat-answer-icon { display: grid; place-items: center; flex: 0 0 auto; width: 22px; height: 22px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-primary); }
.cli-chat-answer-meta { flex: 0 0 auto; color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cli-chat-answer-body { margin-top: 8px; font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.cli-chat-answer-body :deep(> :first-child) { margin-top: 0; }
.cli-chat-answer-body :deep(> :last-child) { margin-bottom: 0; }
.cli-chat-note { margin: 0; color: var(--color-text-secondary); font-size: 12.5px; }
.cli-chat-error { color: var(--color-accent-red); }
.cli-chat-dock { flex: 0 0 auto; padding-bottom: 14px; }
.cli-chat-popover { display: flex; flex-direction: column; max-height: 320px; margin-bottom: 6px; padding: 4px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-secondary); box-shadow: none; }
.cli-chat-popover-title { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 4px 8px; color: var(--color-text-secondary); font-size: 12px; }
.cli-chat-option { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 4px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.cli-chat-option:hover, .cli-chat-option.active { background: var(--color-bg-hover); }
.cli-chat-option-label { flex: 0 0 auto; }
.cli-chat-option-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); font-size: 12px; }
.cli-chat-option-check { flex: 0 0 auto; margin-left: auto; }
.cli-chat-composer { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px 10px 8px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-secondary); }
.cli-chat-composer:focus-within { border-color: var(--color-accent-blue); }
.cli-chat-input { box-sizing: border-box; width: 100%; min-height: 22px; max-height: 200px; padding: 0; border: 0; outline: none; resize: none; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 13.5px; line-height: 1.55; }
.cli-chat-input::placeholder { color: var(--color-text-muted); }
.cli-chat-composer-bar { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cli-chat-provider { display: inline-flex; align-items: center; gap: 5px; margin-right: auto; color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; }
.cli-chat-model { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 260px; height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 12.5px; cursor: pointer; }
.cli-chat-model span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cli-chat-model:hover { border-color: var(--color-border); background: var(--color-bg-hover); }
.cli-chat-send { display: grid; place-items: center; flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-text-primary); color: var(--color-bg-primary); cursor: pointer; }
.cli-chat-send:disabled { background: var(--color-bg-hover); color: var(--color-text-muted); cursor: default; }
.cli-chat-spin { animation: cli-chat-spin 1s linear infinite; }
@keyframes cli-chat-spin { to { transform: rotate(360deg); } }
.cli-chat-composer :deep(.skill-completion-popup) { width: 100%; box-shadow: none; }
</style>
