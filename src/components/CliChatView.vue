<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowUp, Brain, Check, ChevronDown, ChevronRight, Copy, LoaderCircle, MessageSquareText, Square, Wrench, X } from 'lucide-vue-next'

import CliProviderIcon from './icons/CliProviderIcon.vue'
import CliChatAgents from './CliChatAgents.vue'
import CliChatChanges from './CliChatChanges.vue'
import CliChatControls from './CliChatControls.vue'
import { cliProviderLabel } from '@/lib/cliProviders'
import { conversationColor, formatWorkDuration, noticeLinkTarget } from '@/lib/cliCompletion'
import { linkWorkspacePaths, renderWorkspaceMarkdown } from '@/lib/workspacePathLinks'
import { cleanCliChatText, concreteModelOption, modelFromCommandOutput, modelFromMenuOption, modelFromScreen, modelOptionLabel, modelWithReasoning, reasoningOption } from '@/lib/cliChatText'
import { backend, isTauri, type CliChatModelOption, type CliChatStep, type CliChatTranscript, type CliChatTurn } from '@/lib/tauri'
import { agentCliCommandCatalogRevision, agentCliCommandDescription, agentCliCommandsFor, loadAgentCliCommandCatalog } from '@/lib/agentCliCommands'
import { detectTerminalMenu, hasNativeTerminalPanel, terminalChatActivity, terminalQuestionQueue, type TerminalScreenLine } from '@/lib/terminalMenu'
import { useWorkspaceStore } from '@/stores/workspace'
import type { CliNativeConversationSummary, TerminalSession } from '@/types'
import { chatUsageLabels, claudeContextFromOutput } from '@/lib/cliChatUsage'
import { cachedChatModels, rememberChatModels } from '@/lib/cliChatModelCache'

const props = withDefaults(defineProps<{
  session: TerminalSession
  screenLines: () => TerminalScreenLine[]
  /** Bumped after every xterm write so menu detection follows the real CLI screen. */
  screenRevision: number
  visible?: boolean
  sharedComposer?: boolean
  submitDraft?: () => Promise<string | undefined>
  canSend?: boolean
  confirmCompletion?: () => boolean
  /** Reading and drafting never resume a native session; only submission does. */
  history?: CliNativeConversationSummary
  submitHistory?: (text: string) => Promise<boolean>
}>(), { visible: true })
const emit = defineEmits<{ 'draft-keydown': [event: KeyboardEvent]; 'draft-paste': [event: ClipboardEvent]; 'native-interaction': [active: boolean] }>()
const draft = defineModel<string>('draft', { default: '' })

const store = useWorkspaceStore()
const isHidden = () => props.visible === false
// End + Ctrl+U clears the CLI's single-line editor before chat mode writes into it.
const CLEAR_LINE = '\u001b[F\u0015'
// Poll quickly only while a turn can still change; idle sessions keep the slower rate.
const POLL_MS = 1000
const ACTIVE_POLL_MS = 300

const transcript = ref<CliChatTranscript | null>(null)
const loadError = ref('')
const sendError = ref('')
const submitting = ref(false)
const openingQuestions = ref(false)
const input = ref<HTMLTextAreaElement | null>(null)
defineExpose({ input, runSlash })
const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const documentHidden = ref(document.hidden)
const intersects = ref(true)
const uiVisible = computed(() => props.visible !== false && !documentHidden.value && intersects.value && !store.settingsOpen)
let visibilityObserver: IntersectionObserver | undefined
const pending = ref<Array<{ id: string; text: string; at: number; baseline: Set<string>; uncertain: boolean }>>([])
const expanded = ref<Record<string, boolean>>({})
const slashIndex = ref(0)
const modelRequested = ref(false)
const selectingModel = ref(false)
const refreshingContext = ref(false)
const learnedModels = ref<CliChatModelOption[]>(cachedChatModels(props.session.id))
const now = ref(Date.now())
const copiedId = ref('')
const changeSummaries = ref<Array<{ turnId: string; files: number; added: number; removed: number }>>([])
const changeSummary = (id: string) => changeSummaries.value.find(summary => summary.turnId === id)
let mirrored = false
let pollTimer: number | undefined
let clockTimer: number | undefined
let modelTimer: number | undefined
let modelAttemptAt = 0
let disposed = false
let mirrorTask: Promise<unknown> = Promise.resolve()
let mirrorRevision = 0
let menuTask: Promise<unknown> | undefined
const settled = ref(new Map<string, { at: number; interrupted: boolean }>())
let idleTurn = ''
let idlePolls = 0
let revision: string | null = null
let versions: Record<string, string> = {}
const historyLimit = ref(40)
const hasMoreHistory = ref(false)
let loadingHistory = false
let generation = 0
let request = 0
let stickToBottom = true
let nativeTimer: number | undefined
let resizeObserver: ResizeObserver | undefined
const loaded = ref(false)
const markdownCache = new Map<string, { text: string; html: string }>()
const pathLinkRevision = ref(0)
// xterm can repaint many times per frame; menu detection only needs the latest frame.
const screenTick = ref(props.screenRevision)
let screenFrame: number | undefined
watch(() => props.screenRevision, () => {
  if (screenFrame !== undefined) return
  screenFrame = window.requestAnimationFrame(() => { screenFrame = undefined; screenTick.value = props.screenRevision })
})

const providerName = computed(() => cliProviderLabel(props.session.providerKind))
const accent = computed(() => conversationColor(props.session.nativeConversationId || props.session.id))
const cleanTurns = new WeakMap<CliChatTurn, { settled: unknown; turn: CliChatTurn }>()
const nativeContext = computed(() => {
  const last = transcript.value?.turns.at(-1)
  return props.session.providerKind === 'claude' && last?.prompt.trim() === '/context' ? claudeContextFromOutput(last.answer) : null
})
const turns = computed(() => (transcript.value?.turns ?? []).filter(turn => !(turn.prompt.trim() === '/context' && claudeContextFromOutput(turn.answer))).map(turn => {
  const state = settled.value.get(turn.id)
  const cached = cleanTurns.get(turn)
  if (cached && cached.settled === state) return cached.turn
  const cleaned = ({
  ...turn, prompt: cleanCliChatText(turn.prompt), answer: cleanCliChatText(turn.answer),
  ...(settled.value.has(turn.id) && turn.completedAt === null ? {
    completedAt: settled.value.get(turn.id)!.at,
    interrupted: settled.value.get(turn.id)!.interrupted,
    answer: cleanCliChatText(turn.answer || turn.steps.filter(step => step.kind === 'text').at(-1)?.detail || ''),
  } : {}),
    steps: turn.steps.map(step => ({ ...step, title: cleanCliChatText(step.title), detail: cleanCliChatText(step.detail), ...(step.output ? { output: cleanCliChatText(step.output) } : {}) })),
})
  cleanTurns.set(turn, { settled: state, turn: cleaned })
  return cleaned
}))
const lastTurn = computed(() => turns.value.at(-1))
const running = computed(() => !props.history && (submitting.value || pending.value.some(message => !message.uncertain) || Boolean(lastTurn.value && lastTurn.value.completedAt === null)))
const selectedModel = ref('')
const selectedEffort = ref('')
const observedModel = ref('')
const modelLabel = computed(() => {
  const model = selectedModel.value || observedModel.value || concreteModelOption(transcript.value?.model ?? '')
  return model ? modelWithReasoning(model, selectedEffort.value) : '选择模型'
})
const screen = computed(() => {
  void screenTick.value
  return props.screenLines()
})
const nativePanel = computed(() => !props.history && hasNativeTerminalPanel(screen.value))
const slashMode = computed(() => !props.history && !nativePanel.value && !modelRequested.value && /^\/\S*$/.test(draft.value))
const slashCommands = computed(() => {
  void agentCliCommandCatalogRevision.value
  if (!slashMode.value) return []
  const query = draft.value.slice(1).toLocaleLowerCase()
  const translated = store.settings?.agentCliCommandTranslation !== false
  return agentCliCommandsFor(props.session.providerKind)
    .filter(entry => !query || entry.command.slice(1).toLocaleLowerCase().includes(query))
    .map(entry => ({ command: entry.command, description: agentCliCommandDescription(entry, translated) }))
})
// 每次进入斜杠输入时重新读取配置，编辑命令目录后立即生效。
watch(slashMode, (active) => { if (active) void loadAgentCliCommandCatalog(true) })
const questionQueue = computed(() => !props.history ? terminalQuestionQueue(screen.value) : null)
const liveMenu = computed(() => slashMode.value || nativePanel.value ? null : detectTerminalMenu(screen.value))
let lastScreenModel = ''
watch(() => modelFromScreen(screen.value), model => {
  // Menus and blank repaint frames can hide and then reveal the same old header.
  if (model && model !== lastScreenModel) {
    lastScreenModel = model
    observedModel.value = model
    const normalize = (value: string) => value.toLowerCase().replace(/\b(?:with|effort)\b/g, '').replace(/[^a-z0-9]/g, '')
    if (!selectedModel.value || normalize(model) !== normalize(modelWithReasoning(selectedModel.value, selectedEffort.value))) {
      selectedModel.value = ''
      selectedEffort.value = ''
    }
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
watch(() => transcript.value?.turns.at(-1), turn => {
  if (props.history || !modelAttemptAt || !turn || turn.startedAt < modelAttemptAt - 1000 || !/^\/model(?:\s|$)/.test(turn.prompt.trim())) return
  const answer = cleanCliChatText(turn.answer)
  if (!/\bmodel not changed\b/i.test(answer)) return
  selectedModel.value = ''
  selectedEffort.value = ''
  modelRequested.value = false
  learnedModels.value = []
  rememberChatModels(props.session.id, [])
  sendError.value = `模型未切换：${answer.trim()}`
  modelAttemptAt = 0
})
// Reveal native panels at once, but ignore the blank frame of a repaint before hiding them again.
watch(() => props.visible !== false && !selectingModel.value && !slashMode.value && nativePanel.value, active => {
  window.clearTimeout(nativeTimer)
  if (active) emit('native-interaction', true)
  else nativeTimer = window.setTimeout(() => emit('native-interaction', false), 300)
}, { immediate: true })
const agents = computed(() => transcript.value?.agents ?? [])
const activeAgentTurns = computed(() => new Set(agents.value.filter(agent => agent.completedAt === null).map(agent => agent.parentTurnId)))
const agentVersions = computed(() => {
  const versions = new Map<string, string>()
  for (const agent of agents.value) versions.set(agent.parentTurnId, (versions.get(agent.parentTurnId) ?? '') + JSON.stringify(agent))
  return versions
})
const unassignedAgents = computed(() => agents.value.filter(agent => !turns.value.some(turn => turn.id === agent.parentTurnId)))
const empty = computed(() => loaded.value && !turns.value.length && !pending.value.length && !agents.value.length)

function turnKey(turn: CliChatTurn | undefined) { return turn ? `${turn.id}:${turn.prompt}` : '' }

function messageReceipts(turns: CliChatTurn[]) {
  return turns.flatMap(turn => turn.userMessages?.length
    ? turn.userMessages.map(message => ({ ...message, id: `${turn.id}:${message.id}` }))
    : turn.prompt ? [{ id: `${turn.id}:prompt`, text: turn.prompt, at: turn.startedAt }] : [])
}

function confirmPending(turns: CliChatTurn[]) {
  const receipts = messageReceipts(turns)
  const consumed = new Set<string>()
  const normalized = (text: string) => cleanCliChatText(text).replace(/\r\n?/g, '\n').trim()
  pending.value = pending.value.filter(message => {
    const receipt = receipts.find(receipt => !message.baseline.has(receipt.id) && !consumed.has(receipt.id)
      && receipt.at >= message.at - 2000 && normalized(receipt.text) === normalized(message.text))
    if (receipt) consumed.add(receipt.id)
    return !receipt
  })
  // One native receipt can confirm only one send, even for identical messages.
  for (const message of pending.value) for (const id of consumed) message.baseline.add(id)
}

async function poll(expandHistory = false) {
  if (disposed || (loadingHistory && !expandHistory)) return
  if (!uiVisible.value && !pending.value.length && !submitting.value) return
  if (props.history) {
    const epoch = generation
    const currentRequest = ++request
    try {
      const result = await backend.readCliConversationChat(props.history.cwd, props.history.sourcePath, historyLimit.value)
      if (disposed || epoch !== generation || currentRequest !== request) return
      hasMoreHistory.value = result.turns.length > historyLimit.value
      transcript.value = { ...result, turns: result.turns.slice(-historyLimit.value) }
      loaded.value = true
      loadError.value = ''
      if (!expandHistory) void scrollToBottom()
    } catch (error) {
      if (!disposed && epoch === generation && currentRequest === request) { loaded.value = true; loadError.value = `读取历史失败：${String(error)}` }
    }
    return
  }
  if (!isTauri()) { loaded.value = true; return }
  const sessionId = props.session.id
  const epoch = generation
  const currentRequest = ++request
  try {
    const known = expandHistory ? versions : Object.fromEntries((transcript.value?.turns.slice(-40) ?? []).map(turn => [turn.id, versions[turn.id] ?? '']))
    const page = await backend.readTerminalChatPage(sessionId, expandHistory ? null : revision, expandHistory ? historyLimit.value : 40, known)
    if (disposed || epoch !== generation || currentRequest !== request || props.session.id !== sessionId) return
    if (!expandHistory) revision = page?.revision ?? null
    versions = { ...versions, ...page?.versions }
    if (expandHistory || !loaded.value) hasMoreHistory.value = page?.hasMore ?? false
    let next = transcript.value
    if (!page) { next = null; versions = {}; hasMoreHistory.value = false; markdownCache.clear() }
    if (page?.transcript) {
      const previous = new Map(transcript.value?.turns.map(turn => [turn.id, turn]) ?? [])
      for (const turn of page.transcript.turns) previous.set(turn.id, turn)
      const first = transcript.value?.turns.findIndex(turn => turn.id === page.order[0]) ?? -1
      if (!expandHistory && first < 0) hasMoreHistory.value = page.hasMore
      const prefix = !expandHistory && first > 0 ? transcript.value!.turns.slice(0, first) : []
      next = { ...page.transcript, turns: [...prefix, ...page.order.map(id => previous.get(id)!).filter(Boolean)] }
      historyLimit.value = Math.max(historyLimit.value, next.turns.length)
      const retained = new Set(next.turns.map(turn => turn.id))
      for (const id of markdownCache.keys()) if (!retained.has(id.split('\0').at(-1)!)) markdownCache.delete(id)
      for (const id of Object.keys(versions)) if (!retained.has(id)) delete versions[id]
    }
    if (disposed || props.session.id !== sessionId) return
    loadError.value = ''
    loaded.value = true
    // An unchanged log must not rebuild every turn and its rendered Markdown.
    if (!page || page.transcript) transcript.value = next
    if (page?.transcript?.source) store.bindTerminalChatSource(sessionId, page.transcript.source)
    const latest = next?.turns.at(-1)
    if (latest && (latest.completedAt !== null || terminalChatActivity(screen.value) === 'busy')) settled.value.delete(latest.id)
    confirmPending(next?.turns ?? [])
    // Logs can end with a user/error record and no completion record. Require
    // several idle observations, so a repaint between submission and startup
    // cannot finish an active task.
    if (['claude', 'codex'].includes(props.session.providerKind)
      && latest?.completedAt === null && terminalChatActivity(screen.value) === 'idle') {
      const key = versions[latest.id] ?? turnKey(latest)
      idlePolls = idleTurn === key ? idlePolls + 1 : 1
      idleTurn = key
      if (idlePolls === 3) settled.value.set(latest.id, { at: Date.now(), interrupted: !latest.answer && !latest.steps.some(step => step.kind === 'text') })
    } else { idleTurn = ''; idlePolls = 0 }
  } catch (error) {
    if (epoch === generation && props.session.id === sessionId) loadError.value = `读取会话日志失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (epoch !== generation || currentRequest !== request) return
    if (!disposed) {
      for (const message of pending.value) if (Date.now() - message.at >= 15000) message.uncertain = true
    }
    if (!disposed && (uiVisible.value || pending.value.length || submitting.value)) schedulePoll(running.value ? ACTIVE_POLL_MS : POLL_MS)
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
function onScroll() {
  stickToBottom = isNearBottom()
  if ((scroller.value?.scrollTop ?? 1) < 80) void loadHistory()
}

async function loadHistory() {
  if (loadingHistory || !hasMoreHistory.value) return
  loadingHistory = true
  window.clearTimeout(pollTimer)
  const epoch = generation
  const el = scroller.value
  const height = el?.scrollHeight ?? 0
  const top = el?.scrollTop ?? 0
  historyLimit.value += 40
  try {
    await poll(true)
    await nextTick()
    if (el && epoch === generation) el.scrollTop = top + el.scrollHeight - height
  } finally { if (epoch === generation) loadingHistory = false }
}

async function scrollToBottom(force = false) {
  if (force) stickToBottom = true
  await nextTick()
  const el = scroller.value
  if (el && stickToBottom) el.scrollTop = el.scrollHeight
}

function markdown(id: string, text: string) {
  void pathLinkRevision.value
  const workspaceRoot = props.session.cwd || store.workspace?.rootPath || ''
  const key = `${workspaceRoot}\0${id}`
  const cached = markdownCache.get(key)
  if (cached?.text === text) return cached.html
  const html = renderWorkspaceMarkdown(text, workspaceRoot)
  const entry = { text, html }
  markdownCache.set(key, entry)
  void linkWorkspacePaths(html, workspaceRoot, path => backend.resolveTerminalPath(path), { fileIcons: true }).then(linked => {
    if (disposed || markdownCache.get(key) !== entry || linked === entry.html) return
    entry.html = linked
    pathLinkRevision.value++
  })
  return html
}

function write(data: string, sessionId = props.session.id) {
  if (props.history || props.visible === false || disposed || props.session.id !== sessionId) return Promise.resolve()
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
    if (!disposed && props.visible !== false && props.session.id === sessionId) await action(sessionId)
  }
  const task = (menuTask ? menuTask.then(run) : run())
    .catch(error => { if (!disposed && props.session.id === sessionId) sendError.value = `输入 CLI 失败：${String(error)}` })
  menuTask = task
  void task.then(() => { if (menuTask === task) menuTask = undefined })
  return task
}

// The draft mirrors into the CLI line editor only while it is a slash command, so the CLI shows its own suggestions.
watch(draft, (value) => {
  if (submitting.value || props.visible === false) return
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
watch(() => props.visible, visible => {
  if (visible === false) { mirrorRevision++; mirrored = false; emit('native-interaction', false) }
})

watch(liveMenu, (menu, previous) => {
  if (menu) window.clearTimeout(modelTimer)
  else if (previous && modelRequested.value) {
    // Codex may briefly clear its screen between the model and effort pages.
    modelTimer = window.setTimeout(() => { if (!liveMenu.value) modelRequested.value = false }, 1000)
  }
  if (['claude', 'codex'].includes(props.session.providerKind) && menu && modelRequested.value && !menu.options.some(option => reasoningOption(option.label))) {
    const options = menu.options.filter(option => !/^(?:back|show all|more models|other models|custom\b)/i.test(modelOptionLabel(option.label)))
    if (options.length) learnedModels.value = options.map(option => ({ id: `native:${option.number}`, nativeNumber: option.number,
      nativeSelected: /[✓✔]|\(current\)/i.test(option.label), label: modelOptionLabel(option.label), description: option.detail,
      efforts: learnedModels.value.find(model => model.nativeNumber === option.number && model.description === option.detail)?.efforts ?? [], defaultEffort: null }))
    rememberChatModels(props.session.id, learnedModels.value)
  }
  if (menu && modelRequested.value && menu.options.some(option => reasoningOption(option.label))) {
    learnedModels.value = learnedModels.value.map(model => model.nativeSelected ? { ...model,
      efforts: [...new Map([...model.efforts, ...menu.options.flatMap(option => {
        const id = reasoningOption(option.label)
        return id ? [{ id, label: id, description: option.detail }] : []
      })].map(effort => [effort.id, effort])).values()] } : model)
    rememberChatModels(props.session.id, learnedModels.value)
  }
})

async function runSlash(command: string) {
  if (props.history || isHidden() || submitting.value || nativePanel.value) return
  const sessionId = props.session.id
  submitting.value = true
  sendError.value = ''
  try {
    if (/^\/model(?:\s|$)/.test(command.trim())) modelAttemptAt = Date.now()
    await mirrorTask
    if (disposed || isHidden() || props.session.id !== sessionId) return
    modelRequested.value = command.trim() === '/model'
    mirrored = false
    draft.value = ''
    const revision = props.screenRevision
    await write(`${CLEAR_LINE}${command}`, sessionId)
    // Ink needs a separate Enter. A visible draft confirms it consumed the command.
    await waitForScreen(() => props.screenRevision !== revision && screen.value.some(line => line.text.includes(command)), 200)
    if (disposed || isHidden() || props.session.id !== sessionId) return
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
  if (submitting.value || isHidden()) return
  if (nativePanel.value) { emit('native-interaction', true); return }
  const text = draft.value.trim()
  if (!text && !(props.sharedComposer && props.canSend)) return
  if (props.history) {
    if (!props.history.resumeSupported || !props.submitHistory) return
    submitting.value = true
    sendError.value = ''
    try {
      const sent = await props.submitHistory(text)
      if (!disposed) {
        if (sent) draft.value = ''
        else sendError.value = '消息未发送，草稿已保留，请重试。'
      }
    } catch (error) {
      if (!disposed) sendError.value = `发送失败：${String(error)}`
    } finally { submitting.value = false }
    return
  }
  if (props.confirmCompletion?.()) return
  if (slashMode.value) {
    const selected = slashCommands.value[slashIndex.value]?.command
    await runSlash(selected && selected.startsWith(text) ? selected : text)
    return
  }
  const epoch = generation
  const message = { id: crypto.randomUUID(), text, at: Date.now(), baseline: new Set(messageReceipts(transcript.value?.turns ?? []).map(receipt => receipt.id)), uncertain: false }
  const removePending = () => { pending.value = pending.value.filter(item => item.id !== message.id) }
  modelRequested.value = false
  submitting.value = true
  sendError.value = ''
  try {
    await mirrorTask
    if (disposed || isHidden() || epoch !== generation) return
    // Show the message immediately; the CLI write and its separate Enter take a few hundred ms.
    message.at = Date.now()
    if (text) { pending.value.push(message); void scrollToBottom(true) }
    if (props.submitDraft) {
      if (mirrored) { mirrored = false; await write(CLEAR_LINE) }
      const sent = await props.submitDraft()
      if (disposed || epoch !== generation) return
      if (sent) {
        const current = pending.value.find(item => item.id === message.id)
        if (current) current.text = sent
        else if (!text) pending.value.push({ ...message, text: sent })
        void scrollToBottom(true); schedulePoll(ACTIVE_POLL_MS)
      }
      else { removePending(); sendError.value = '消息未发送，请检查终端状态后重试。' }
      return
    }
    draft.value = ''
    await write(CLEAR_LINE)
    if (disposed || isHidden() || epoch !== generation) { if (!disposed && epoch === generation && !draft.value) draft.value = text; removePending(); return }
    if (await store.sendTerminalConversationMessage(props.session.id, text)) schedulePoll(ACTIVE_POLL_MS)
    else { removePending(); draft.value = text; sendError.value = '消息未发送，请检查终端状态后重试。' }
  } catch (error) {
    if (disposed || epoch !== generation) return
    removePending()
    if (!draft.value) draft.value = text
    sendError.value = `发送失败：${String(error)}`
  } finally { submitting.value = false }
}

function stop() {
  for (const message of pending.value) message.uncertain = true
  void write('\u001b').catch(error => { sendError.value = `中断失败：${String(error)}` })
}

async function openQuestions() {
  if (openingQuestions.value) return
  openingQuestions.value = true
  try { await queueMenuInput(async sessionId => {
    const queue = questionQueue.value
    if (!queue || nativePanel.value || props.history) return
    await write(queue.key, sessionId)
    const opened = await waitForScreen(() => nativePanel.value || !questionQueue.value, 1200)
    if (!disposed && props.session.id === sessionId && !opened) sendError.value = 'CLI 问题尚未展开，请重试。'
  }) } finally { openingQuestions.value = false }
}

async function openModelMenu() {
  if (liveMenu.value) { await queueMenuInput(async sessionId => { await write('\u001b', sessionId) }); return }
  const id = props.session.id
  const savedDraft = draft.value
  modelRequested.value = true
  window.clearTimeout(modelTimer)
  await runSlash('/model')
  if (savedDraft && !disposed && props.session.id === id) draft.value = savedDraft
}

/** Keep the native CLI as owner of its selection, but display the cached list locally. */
async function applyCachedModel(model: CliChatModelOption, effort?: string) {
  if (selectingModel.value || running.value || props.history || nativePanel.value) {
    sendError.value = '请在本轮处理结束后切换模型。'
    return
  }
  const id = props.session.id
  const valid = () => !disposed && !isHidden() && props.session.id === id
  selectingModel.value = true
  modelAttemptAt = Date.now()
  modelRequested.value = true
  sendError.value = ''
  const normalize = (value: string) => modelOptionLabel(value).toLowerCase().replace(/[^a-z0-9.]/g, '')
  try {
    await mirrorTask
    if (!valid()) return
    // Do not clear the chat draft or append a synthetic conversation message.
    await write(`${CLEAR_LINE}/model`, id)
    await waitForScreen(() => screen.value.some(line => line.text.includes('/model')), 200)
    if (!valid()) return
    await write('\r', id)
    if (!await waitForScreen(() => Boolean(liveMenu.value), 4000) || !valid()) throw new Error('CLI 模型菜单未就绪')
    const options = liveMenu.value!.options
    const index = options.findIndex(option => model.nativeNumber !== undefined
      ? option.number === model.nativeNumber && normalize(option.label) === normalize(model.label) && option.detail === model.description
      : [option.label, modelFromMenuOption(option.label, option.detail) ?? ''].some(value => [model.id, model.label].some(target => normalize(value) === normalize(target))))
    if (index < 0) throw new Error('CLI 当前列表中没有该模型，请重新打开原生模型菜单')
    await selectOption(index)
    if (!valid()) return
    if (props.session.providerKind === 'codex') {
      if (!await waitForScreen(() => Boolean(liveMenu.value?.options.some(option => reasoningOption(option.label))), 4000)) throw new Error('CLI 推理强度菜单未就绪')
      const desired = effort || model.defaultEffort
      let at = desired ? liveMenu.value!.options.findIndex(option => reasoningOption(option.label) === desired) : liveMenu.value!.selectedIndex
      if (at < 0) {
        const more = liveMenu.value!.options.findIndex(option => /^more\s+reasoning/i.test(option.label))
        if (more >= 0) {
          await selectOption(more)
          at = liveMenu.value?.options.findIndex(option => reasoningOption(option.label) === desired) ?? -1
        }
      }
      if (at < 0) throw new Error('CLI 当前模型不提供该推理强度')
      await selectOption(at)
    }
    if (valid() && liveMenu.value) throw new Error('CLI 尚未确认模型选择，请检查原生选项')
    if (valid()) { modelRequested.value = false; input.value?.focus() }
  } catch (error) {
    if (valid()) sendError.value = `切换模型失败：${String(error instanceof Error ? error.message : error)}`
  } finally {
    if (props.session.id === id) selectingModel.value = false
  }
}

async function refreshNativeContext() {
  if (props.session.providerKind !== 'claude' || running.value || refreshingContext.value || selectingModel.value || liveMenu.value || props.history) return
  const id = props.session.id
  const before = transcript.value?.turns.at(-1)?.id
  const valid = () => !disposed && !isHidden() && props.session.id === id
  refreshingContext.value = true
  submitting.value = true
  try {
    await mirrorTask
    if (!valid()) return
    await write(`${CLEAR_LINE}/context`, id)
    await waitForScreen(() => screen.value.some(line => line.text.includes('/context')), 200)
    if (!valid()) return
    await write('\r', id)
    schedulePoll(0)
    const ready = await waitForScreen(() => Boolean(nativeContext.value) && transcript.value?.turns.at(-1)?.id !== before, 20000)
    if (!ready && valid()) sendError.value = 'CLI 暂未返回上下文分类，可稍后重新打开面板刷新。'
  } catch (error) {
    if (valid()) sendError.value = `读取上下文失败：${String(error)}`
  } finally {
    if (props.session.id === id) { refreshingContext.value = false; submitting.value = false }
  }
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
      if (!disposed && props.session.id === sessionId) rememberModelOption(option.label, option.detail, menu.options.some(option => reasoningOption(option.label)), option.number)
      await waitForScreen(() => menuIdentity(liveMenu.value) !== identity, 1200)
    }
  })
}

function rememberModelOption(label: string, detail: string, effortMenu: boolean, number?: number) {
  if (!modelRequested.value) return
  const effort = reasoningOption(label)
  if (effort) selectedEffort.value = effort
  else if (!effortMenu) {
    if (number !== undefined) {
      learnedModels.value = learnedModels.value.map(model => ({ ...model, nativeSelected: model.nativeNumber === number }))
      rememberChatModels(props.session.id, learnedModels.value)
    }
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
        rememberModelOption(option.label, option.detail, menu.options.some(option => reasoningOption(option.label)), option.number)
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
  if (props.history && turn.completedAt === null) return ''
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
  if (props.history && turn.completedAt === null) return `执行记录${suffix}`
  if (turn.completedAt === null) return `正在思考 ${turnDuration(turn)}${suffix}`
  return `${turn.interrupted ? '已中断' : '已处理'} ${turnDuration(turn)}${suffix}`
}

function latestStep(turn: CliChatTurn): CliChatStep | undefined {
  return [...turn.steps].reverse().find(step => step.kind !== 'user')
}

function stepIcon(step: CliChatStep) {
  return step.kind === 'tool' ? Wrench : step.kind === 'think' ? Brain : MessageSquareText
}

function toggle(turn: CliChatTurn) {
  expanded.value[turn.id] = !isExpanded(turn)
}

function isExpanded(turn: CliChatTurn) { return expanded.value[turn.id] ?? (turn.completedAt === null && !props.history) }

async function copy(turn: CliChatTurn, text: string) {
  await navigator.clipboard?.writeText(text)
  copiedId.value = turn.id
  window.setTimeout(() => { if (copiedId.value === turn.id) copiedId.value = '' }, 1200)
}

async function handleAnswerClick(event: MouseEvent) {
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (!anchor) return
  event.preventDefault()
  const target = noticeLinkTarget(anchor.getAttribute('href') ?? '', props.session.cwd)
  if (!target) return
  try {
    if (target.kind === 'url') await backend.openUrl(target.url)
    else {
      const resolved = await backend.resolveTerminalPath(target.path)
      if (!resolved) throw new Error(`未找到路径：${target.path}`)
      if (resolved.isFile) {
        await store.openTerminalFileLink(resolved.path, Number(anchor.getAttribute('data-line-number')) || target.lineNumber)
        window.dispatchEvent(new CustomEvent('superhigh:chat-preview'))
      }
      else await store.openPath(resolved.path)
    }
  } catch (error) {
    store.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}

watch(() => props.session.id, () => {
  modelAttemptAt = 0
  submitting.value = false
  transcript.value = null
  generation++
  revision = null
  versions = {}
  historyLimit.value = 40
  hasMoreHistory.value = false
  loadingHistory = false
  markdownCache.clear()
  loaded.value = false
  stickToBottom = true
  pending.value = []
  sendError.value = ''
  settled.value.clear()
  selectedModel.value = ''
  selectedEffort.value = ''
  observedModel.value = ''
  lastScreenModel = ''
  modelRequested.value = false
  selectingModel.value = false
  refreshingContext.value = false
  learnedModels.value = cachedChatModels(props.session.id)
  mirrored = false
  schedulePoll(0)
})

function syncClock() {
  window.clearInterval(clockTimer)
  clockTimer = undefined
  if (uiVisible.value && !props.history) {
    now.value = Date.now()
    clockTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
  }
}

function onVisibilityChange() { documentHidden.value = document.hidden }
watch(uiVisible, visible => {
  syncClock()
  if (visible) schedulePoll(0)
  else if (!pending.value.length && !submitting.value) window.clearTimeout(pollTimer)
})
watch(() => Boolean(pending.value.length) || submitting.value, confirming => {
  if (uiVisible.value) return
  if (confirming) schedulePoll(0)
  else window.clearTimeout(pollTimer)
})

onMounted(() => {
  // History resumes and mode switches mount a fresh reader before the native
  // log acknowledges the send. Keep the outgoing message visible while waiting.
  if (!props.history && store.terminalConversationReplyPending?.[props.session.id]) {
    const message = store.terminalConversation?.[props.session.id]?.filter(message => message.role === 'user').at(-1)
    if (message) pending.value.push({ id: message.id, text: message.content, at: Date.parse(message.timestamp), baseline: new Set(), uncertain: false })
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  void loadAgentCliCommandCatalog()
  if (typeof IntersectionObserver !== 'undefined' && root.value) {
    visibilityObserver = new IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === root.value)
      if (entry) intersects.value = entry.isIntersecting
    })
    visibilityObserver.observe(root.value)
  }
  void poll()
  syncClock()
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
  visibilityObserver?.disconnect()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (mirrored) void write(CLEAR_LINE)
})
</script>

<template>
  <section ref="root" class="cli-chat" :class="{ 'cli-chat--empty': empty && !slashMode && !liveMenu && !history, 'cli-chat--history': !!history }" :style="{ '--chat-accent': accent }" aria-label="聊天模式" @keydown="onMenuKeydown">
    <div ref="scroller" class="cli-chat-scroll" @scroll.passive="onScroll">
      <div class="cli-chat-column">
        <button v-if="hasMoreHistory" class="cli-chat-thinking-toggle" type="button" @click="loadHistory">加载更早记录</button>
        <h2 v-if="empty" class="cli-chat-welcome">{{ history ? '这条会话没有可显示的消息' : '我们要做什么？' }}</h2>
        <article v-for="turn in turns" :key="turn.id" v-memo="[turn, expanded[turn.id], copiedId === turn.id, turn.completedAt === null || activeAgentTurns.has(turn.id) ? now : 0, agentVersions.get(turn.id), pathLinkRevision, changeSummary(turn.id)]" class="cli-chat-turn">
          <div v-if="turn.prompt" class="cli-chat-user">
            <div class="cli-chat-user-bubble">{{ turn.prompt }}</div>
            <button class="cli-chat-icon-button" type="button" title="复制" @click="copy(turn, turn.prompt)">
              <Check v-if="copiedId === turn.id" :size="13" />
              <Copy v-else :size="13" />
            </button>
          </div>
          <div v-if="turn.steps.length || (turn.completedAt === null && !history)" class="cli-chat-thinking">
            <button class="cli-chat-thinking-toggle" type="button" :aria-expanded="isExpanded(turn)" @click="toggle(turn)">
              <LoaderCircle v-if="turn.completedAt === null && !history" :size="13" class="cli-chat-spin" />
              <component :is="isExpanded(turn) ? ChevronDown : ChevronRight" v-else :size="13" />
              <span>{{ turn.completedAt === null && !turn.steps.length && !turn.answer ? '等待 CLI 响应' : thinkingLabel(turn) }}</span>
              <span v-if="changeSummary(turn.id)?.files" class="cli-chat-change-summary">· {{ changeSummary(turn.id)!.files }} 个文件 <span class="cli-chat-added">+{{ changeSummary(turn.id)!.added }}</span> <span class="cli-chat-removed">−{{ changeSummary(turn.id)!.removed }}</span></span>
            </button>
            <div v-if="turn.completedAt === null && latestStep(turn) && latestStep(turn)!.kind !== 'text' && !isExpanded(turn)" class="cli-chat-step cli-chat-step--latest">
              <component :is="stepIcon(latestStep(turn)!)" :size="13" />
              <span class="cli-chat-step-title">{{ latestStep(turn)!.title }}</span>
              <span class="cli-chat-step-detail">{{ latestStep(turn)!.detail }}</span>
            </div>
            <ol v-if="turn.steps.some(step => step.kind === 'text' || step.kind === 'user') || isExpanded(turn)" class="cli-chat-steps">
              <template v-for="(step, index) in turn.steps" :key="index">
              <li v-if="step.kind === 'text' || step.kind === 'user' || isExpanded(turn)" :class="`cli-chat-step--${step.kind}`">
                <div v-if="step.kind === 'user'" class="cli-chat-user"><div class="cli-chat-user-bubble">{{ step.detail }}</div></div>
                <div v-else-if="step.kind === 'text'" class="cli-chat-interim markdown-body" @click="handleAnswerClick" v-html="markdown(`${turn.id}:step:${index}`, step.detail || step.title)" />
                <details v-else class="cli-chat-step-disclosure">
                <summary class="cli-chat-step">
                <component :is="stepIcon(step)" :size="13" />
                <span class="cli-chat-step-title">{{ step.title }}</span>
                <span class="cli-chat-step-detail" :title="step.detail">{{ step.detail }}</span>
                <ChevronRight :size="11" class="cli-chat-step-chevron" />
                </summary>
                <pre class="cli-chat-step-output">{{ step.output || step.detail || step.title }}</pre>
                </details>
              </li>
              </template>
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
            <div class="cli-chat-answer-body markdown-body" @click="handleAnswerClick" v-html="markdown(turn.id, turn.answer)" />
          </section>
          <p v-else-if="turn.interrupted" class="cli-chat-note">本轮已中断</p>
          <footer v-if="turn.completedAt !== null && chatUsageLabels(turn)" class="cli-chat-usage" aria-label="本轮用量">
            <span>{{ turnDuration(turn) }}</span>
            <span v-if="chatUsageLabels(turn)!.speed" title="按本轮总耗时估算，包含工具执行与等待时间">{{ chatUsageLabels(turn)!.speed }}</span>
            <span :title="chatUsageLabels(turn)!.detail">{{ chatUsageLabels(turn)!.tokens }}</span>
            <span title="原生日志记录的费用；缺失时显示 —">{{ chatUsageLabels(turn)!.cost }}</span>
          </footer>
        </article>
        <CliChatAgents :key="`${session.id}:other-agents`" :agents="unassignedAgents" :now="now" @answer-click="handleAnswerClick" />
        <article v-for="message in pending" :key="message.id" class="cli-chat-turn cli-chat-pending">
          <div class="cli-chat-user"><div class="cli-chat-user-bubble">{{ message.text }}</div></div>
          <p class="cli-chat-note">{{ message.uncertain ? '暂未确认 CLI 接收，仍在核对；可切到工作模式查看。' : '等待 CLI 接收消息' }}</p>
        </article>
        <p v-if="loadError" class="cli-chat-note cli-chat-error">{{ loadError }}</p>
        <button v-if="history && loadError" type="button" class="cli-chat-thinking-toggle" @click="poll()">重新读取</button>
        <p v-if="transcript?.agentError" class="cli-chat-note">子 Agent 记录查询失败：{{ transcript.agentError }}</p>
        <p v-if="sendError" class="cli-chat-note cli-chat-error" role="alert">{{ sendError }}</p>
      </div>
    </div>

    <div v-if="history && (!history.resumeSupported || !submitHistory)" class="cli-chat-history-dock"><slot name="history-actions" /></div>
    <div v-else class="cli-chat-dock">
      <div class="cli-chat-column">
        <button v-if="nativePanel" class="cli-chat-thinking-toggle" type="button" @click="emit('native-interaction', true)">继续操作 CLI 面板</button>
        <button v-else-if="questionQueue" class="cli-chat-thinking-toggle" type="button" :disabled="openingQuestions" :title="`展开 CLI 待答问题（${questionQueue.shortcut}）`" @click="openQuestions">回答 CLI 问题（{{ questionQueue.shortcut }}）</button>
        <div v-if="liveMenu && !selectingModel" class="cli-chat-popover" role="listbox" :aria-label="modelRequested ? '选择模型' : 'CLI 选项'">
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
        <CliChatChanges :session="session" :turns="turns" @summary="changeSummaries = $event" />
        <div class="cli-chat-composer">
          <slot name="completion" v-if="!liveMenu" />
          <slot name="attachments" />
          <textarea
            ref="input"
            v-model="draft"
            class="cli-chat-input"
            rows="1"
            :readonly="submitting || selectingModel"
            :placeholder="history ? `向 ${providerName} 发送消息` : running ? '正在处理，可继续输入…' : `向 ${providerName} 发送消息，输入 / 查看命令`"
            @keydown="onKeydown"
            @paste="emit('draft-paste', $event)"
          />
          <div class="cli-chat-composer-bar">
            <span class="cli-chat-provider"><CliProviderIcon :provider="session.providerKind" :size="13" />{{ providerName }}</span>
            <CliChatControls v-if="!history" :session-id="session.id" :visible="uiVisible" :label="modelLabel" :selection-label="selectedModel ? modelWithReasoning(selectedModel, selectedEffort) : ''" :busy="selectingModel || refreshingContext" :learned-models="learnedModels" :context-override="nativeContext" :refreshing-context="refreshingContext" :native-menu-open="!!liveMenu"
              @fallback="openModelMenu" @select="applyCachedModel" @focus-input="input?.focus()" @context="refreshNativeContext" />
            <slot name="composer-actions" />
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
.cli-chat-column { box-sizing: border-box; width: 100%; max-width: 880px; margin: 0 auto; padding: 0 32px; }
.cli-chat-scroll .cli-chat-column { padding-top: 28px; padding-bottom: 24px; }
.cli-chat--empty { justify-content: center; }
.cli-chat--empty .cli-chat-scroll { flex: 0 0 auto; overflow: visible; }
.cli-chat-welcome { margin: 0 0 8px; text-align: center; font-size: 22px; font-weight: var(--sh-weight-emphasis); }
.cli-chat-turn { display: flex; flex-direction: column; gap: 12px; margin-bottom: 30px; }
.cli-chat-user { display: flex; align-items: flex-start; flex-direction: row; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--color-border); }
.cli-chat-user-bubble { flex: 1; min-width: 0; padding: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-content); font-size: 13px; line-height: 1.7; font-weight: var(--sh-weight-emphasis); }
.cli-chat-icon-button { display: grid; place-items: center; flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.cli-chat-icon-button:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.cli-chat-thinking { display: flex; flex-direction: column; gap: 4px; }
.cli-chat-thinking-toggle { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 2px 4px; border: 0; border-radius: 3px; background: transparent; color: var(--color-text-secondary); font: inherit; font-size: 12.5px; font-variant-numeric: tabular-nums; cursor: pointer; }
.cli-chat-thinking-toggle:hover { color: var(--color-text-primary); background: var(--color-bg-hover); }
.cli-chat-change-summary { font-size: 11px; white-space: nowrap; }
.cli-chat-added { color: var(--color-accent-green); }
.cli-chat-removed { color: var(--color-accent-red); }
.cli-chat-steps { display: flex; flex-direction: column; gap: 5px; margin: 0 0 0 6px; padding: 2px 0 2px 12px; border-left: 1px solid var(--color-border); list-style: none; }
.cli-chat-step { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 4px; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }
.cli-chat-step > svg { flex: 0 0 auto; }
.cli-chat-step--latest { padding-left: 14px; }
.cli-chat-step-title { flex: 0 0 auto; min-width: 36px; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-primary); }
.cli-chat-step-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 11.5px; }
.cli-chat-step-disclosure > summary { list-style: none; cursor: pointer; border-radius: 3px; }
.cli-chat-step-disclosure > summary::-webkit-details-marker { display: none; }
.cli-chat-step-disclosure > summary:hover { background: var(--color-bg-hover); }
.cli-chat-step-chevron { margin-left: auto; color: var(--color-text-muted); }
.cli-chat-step-disclosure[open] .cli-chat-step-chevron { transform: rotate(90deg); }
.cli-chat-step-output { margin: 4px 0 8px 4px; padding: 8px 10px; max-height: 300px; overflow: auto; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); background: var(--color-bg-primary); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.cli-chat-interim { padding: 4px; font-size: 13px; line-height: 1.7; color: var(--color-text-secondary); }
.cli-chat-interim :deep(> :first-child) { margin-top: 0; }
.cli-chat-interim :deep(> :last-child) { margin-bottom: 0; }
.cli-chat-step--text .cli-chat-step-detail, .cli-chat-step--think .cli-chat-step-detail { font-family: inherit; }
.cli-chat-answer { padding: 8px 0; }
.cli-chat-answer-header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cli-chat-answer-header strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: var(--sh-weight-emphasis); }
.cli-chat-answer-icon { display: grid; place-items: center; flex: 0 0 auto; width: 20px; height: 20px; color: var(--chat-accent); }
.cli-chat-answer-meta { flex: 0 0 auto; color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cli-chat-answer-body { margin-top: 8px; font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.cli-chat-answer-body :deep(> :first-child) { margin-top: 0; }
.cli-chat-answer-body :deep(> :last-child) { margin-bottom: 0; }
.cli-chat-usage { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--color-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.cli-chat :deep(.workspace-file-link) { display: inline; text-decoration: none; }
.cli-chat :deep(.workspace-file-link .tree-kind-icon) { display: inline-flex; width: 14px; height: 14px; margin-right: 4px; vertical-align: -2px; }
.cli-chat :deep(.workspace-file-link:hover) { text-decoration: underline; }
.cli-chat :deep(:not(pre) > code) { color: var(--color-accent-yellow); overflow-wrap: anywhere; }
.cli-chat-note { margin: 0; color: var(--color-text-secondary); font-size: 12.5px; }
.cli-chat-error { color: var(--color-accent-red); }
.cli-chat-dock { flex: 0 0 auto; padding-top: 6px; padding-bottom: 18px; }
.cli-chat-history-dock { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; flex: none; min-height: 48px; padding: 8px 24px; border-top: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: 12px; }
.cli-chat-popover { display: flex; flex-direction: column; max-height: 320px; margin-bottom: 6px; padding: 4px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-secondary); box-shadow: none; }
.cli-chat-popover-title { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 4px 8px; color: var(--color-text-secondary); font-size: 12px; }
.cli-chat-option { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 4px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.cli-chat-option:hover, .cli-chat-option.active { background: var(--color-bg-hover); }
.cli-chat-option-label { flex: 0 0 auto; }
.cli-chat-option-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); font-size: 12px; }
.cli-chat-option-check { flex: 0 0 auto; margin-left: auto; }
.cli-chat-composer { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 8px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-tertiary); }
.cli-chat-composer:focus-within { border-color: var(--color-accent-blue); }
.cli-chat-input { box-sizing: border-box; width: 100%; min-height: 46px; max-height: 200px; padding: 0; border: 0; outline: none; resize: none; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 13.5px; line-height: 1.55; }
.cli-chat-input::placeholder { color: var(--color-text-muted); }
.cli-chat-composer-bar { display: flex; align-items: center; gap: 6px; min-width: 0; overflow-x: auto; }
.cli-chat-provider { display: inline-flex; align-items: center; flex: none; gap: 5px; color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; }
.cli-chat-model { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 260px; height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 12.5px; cursor: pointer; }
.cli-chat-model span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cli-chat-model:hover { border-color: var(--color-border); background: var(--color-bg-hover); }
.cli-chat-send { display: grid; place-items: center; flex: 0 0 auto; margin-left: auto; width: 28px; height: 28px; padding: 0; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-text-primary); color: var(--color-bg-primary); cursor: pointer; }
.cli-chat-send:disabled { background: var(--color-bg-hover); color: var(--color-text-muted); cursor: default; }
.cli-chat-spin { animation: cli-chat-spin 1s linear infinite; }
@keyframes cli-chat-spin { to { transform: rotate(360deg); } }
.cli-chat-composer :deep(.skill-completion-popup) { width: 100%; box-shadow: none; }
@media (max-width: 1000px) { .cli-chat-column { padding-left: 20px; padding-right: 20px; } .cli-chat-answer-meta { font-size: 10px; } }
@media (max-width: 700px) { .cli-chat-column { padding-left: 14px; padding-right: 14px; } .cli-chat-answer-header { flex-wrap: wrap; } .cli-chat-answer-meta { order: 1; width: 100%; } .cli-chat-history-dock { padding: 8px 14px; } }
@media (prefers-reduced-motion: reduce) { .cli-chat-spin { animation: none; } }
</style>
