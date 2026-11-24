<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus, Mic, Send, Camera, ImageIcon, File, X, Trash2, RefreshCw, Slash, Keyboard } from 'lucide-vue-next'
import CliProviderIcon from '@/components/icons/CliProviderIcon.vue'
import { appendVoiceText } from '@/lib/voiceInput'
import { renderCodeBlock, renderMarkdown } from '@/lib/markdown'
import type { CliChatTranscript } from '@/lib/tauri'
import '@/markdown.css'
import { useMobileVoiceInput } from '@/lib/mobileVoiceInput'
import { Terminal, type FontWeight } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import { buildTerminalTheme } from '@/lib/theme'
import { TerminalColorAdapter } from '@/lib/terminalColors'
import { fittedTerminalFontSize } from './terminalLayout'
import { MobileTerminalRenderer, writeMobileTerminalProjection, MOBILE_TERMINAL_FRAME_TIMEOUT_MS, MOBILE_TERMINAL_CLEAR } from './mobileTerminalRenderer'
import { detectTerminalMenu, type TerminalMenu } from '@/lib/terminalMenu'
import { CLI_PROVIDER_OPTIONS, cliProviderLabel, cliProviderVisible } from '@/lib/cliProviders'
import { TerminalTitleParser, terminalSessionTitle } from '@/lib/terminalTitle'
import type { CliNativeConversationDetail, CliNativeConversationSummary, CliProviderEnvironment, TerminalProviderKind, TerminalSession } from '@/types'

const props = withDefaults(defineProps<{ api: MobileHostApi; root: string; mode: 'terminal' | 'ai'; connected?: boolean; fontSize?: number; theme?: string; fontStyleId?: string; hiddenCliProviderIds?: string[]; initialDraft?: string; launcherTarget?: boolean }>(), { connected: true, fontSize: 14, theme: 'dark', fontStyleId: 'anthropic', hiddenCliProviderIds: () => [], initialDraft: '', launcherTarget: false })
const emit = defineEmits<{ connect: []; draftChange: [value: string] }>()
const sessions = ref<TerminalSession[]>([])
const providers = ref<CliProviderEnvironment[]>([])
const provider = ref<TerminalProviderKind>('codex')
const selectedId = ref('')
const displayMode = ref<'chat' | 'terminal'>('chat')
const chat = ref<CliChatTranscript | null>(null)
const chatScroller = ref<HTMLDivElement | null>(null)
const chatError = ref('')
let chatTimer: ReturnType<typeof setTimeout> | undefined
let chatGeneration = 0
async function pollChat(id: string, epoch: number) {
  try {
    const result = await props.api.terminalChat(id)
    if (disposed || epoch !== chatGeneration) return
    const scroller = chatScroller.value
    const follow = !chat.value || !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
    chat.value = result
    chatError.value = ''
    if (follow) {
      await nextTick()
      if (epoch === chatGeneration && chatScroller.value) chatScroller.value.scrollTop = chatScroller.value.scrollHeight
    }
  } catch (cause) {
    if (disposed || epoch !== chatGeneration) return
    chatError.value = cause instanceof MobileHostError && cause.status === 404
      ? '电脑端需要更新才能使用聊天模式，请切换到终端模式。'
      : `读取对话失败：${formatError(cause)}`
  }
  if (!disposed && epoch === chatGeneration) chatTimer = setTimeout(() => void pollChat(id, epoch), 1500)
}
watch([selectedId, displayMode], ([id, mode]) => {
  chatGeneration++
  clearTimeout(chatTimer)
  chat.value = null
  chatError.value = ''
  if (id && mode === 'chat') void pollChat(id, chatGeneration)
  if (mode === 'terminal') nextTick(() => scheduleFit())
})
const busy = ref(false)
const sending = ref(false)
const commandControlsOpen = ref(false)
const keysPinned = ref(false)
const menu = ref<TerminalMenu | null>(null)
const error = ref('')
const streamError = ref('')
const running = ref(false)
const draft = ref(props.initialDraft)
watch(draft, value => emit('draftChange', value))
const attachmentPanelOpen = ref(false)
const cameraInput = ref<HTMLInputElement | null>(null)
const albumInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
type Attachment = { id: number; file: File; state: 'uploading' | 'ready' | 'error'; path?: string; error?: string }
const attachments = ref<Attachment[]>([])
let attachmentId = 0
let uploadQueue: Promise<void> = Promise.resolve()
const attachmentsReady = computed(() => attachments.value.every(item => item.state === 'ready'))
const visibleCliProviders = computed(() => CLI_PROVIDER_OPTIONS.filter(entry => cliProviderVisible(entry.id, props.hiddenCliProviderIds)))
function toggleAttachments() {
  if (!props.connected) { emit('connect'); return }
  if (!props.root) { error.value = '请先选择工作区'; return }
  attachmentPanelOpen.value = !attachmentPanelOpen.value
  void nextTick(scheduleFit)
}
async function uploadAttachment(item: Attachment) {
  const client = props.api
  const root = props.root
  item.state = 'uploading'; item.error = ''
  try {
    const result = await client.uploadAttachment(root, item.file)
    if (disposed || client !== props.api || root !== props.root || !attachments.value.includes(item)) return
    item.path = result.path; item.state = 'ready'
  } catch (cause) {
    if (disposed || client !== props.api || root !== props.root || !attachments.value.includes(item)) return
    item.state = 'error'; item.error = formatError(cause)
  }
}
function selectAttachments(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!props.connected || !props.root || disposed) return
  for (const file of files) {
    attachments.value.push({ id: ++attachmentId, file, state: 'uploading' })
    queueUpload(attachments.value[attachments.value.length - 1])
  }
}
function queueUpload(item: Attachment) {
  item.state = 'uploading'; item.error = ''
  uploadQueue = uploadQueue.then(async () => { if (!disposed && attachments.value.includes(item)) await uploadAttachment(item) })
}
function removeAttachment(id: number) { attachments.value = attachments.value.filter(item => item.id !== id) }

const showHistory = ref(false)
const history = ref<CliNativeConversationSummary[]>([])
const conversation = ref<CliNativeConversationDetail | null>(null)
const terminalHost = ref<HTMLDivElement | null>(null)
const draftInput = ref<HTMLTextAreaElement | null>(null)
const inputFocused = ref(false)
function fitDraft() {
  const input = draftInput.value
  if (!input) return
  input.style.height = '0px'
  input.style.height = `${input.scrollHeight}px`
  scheduleFit()
}
watch(draft, fitDraft, { flush: 'post' })
watch(draftInput, fitDraft, { flush: 'post' })
const { voiceInputAvailable, isVoiceListening, voiceButtonTitle, voiceStatusMessage, toggleVoiceInput } = useMobileVoiceInput({
  focusInput: async () => { await nextTick(); draftInput.value?.focus() },
  appendText: (text) => { draft.value = appendVoiceText(draft.value, text) },
})
function focusDraft() {
  inputFocused.value = true
  scheduleFit()
}
async function launch(kind: TerminalProviderKind) {
  if (!cliProviderVisible(kind, props.hiddenCliProviderIds)) return
  if (!props.connected) { emit('connect'); return }
  if (!props.root) { error.value = '请先选择工作区'; return }
  provider.value = kind
  await create()
}

const isAiProvider = (kind: string) => CLI_PROVIDER_OPTIONS.some((entry) => entry.id === kind)
const availableProviders = computed(() => providers.value.filter((entry) => entry.available && isAiProvider(entry.providerKind)))
const visibleSessions = computed(() => sessions.value.filter((session) => inProject(session.cwd, props.root)
  && (props.mode === 'terminal' ? session.providerKind === 'local' : true)))
const activeSession = computed(() => visibleSessions.value.find((session) => session.id === selectedId.value))
let terminal: Terminal | undefined
let renderer: MobileTerminalRenderer | undefined
let frameTimer: ReturnType<typeof setTimeout> | undefined
const terminalColors = new TerminalColorAdapter()
let fit: FitAddon | undefined
let observer: ResizeObserver | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let sessionSyncTimer: ReturnType<typeof setTimeout> | undefined
let sessionRevision = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let cursor = 0
let receivedSnapshot = false
let disposed = false
let outputRequest: AbortController | undefined
let sourceCols = 120
let sourceRows = 32
let inputQueue: Promise<unknown> = Promise.resolve()
let pendingInputs = 0
const titles = new Map<string, { parser: TerminalTitleParser; cursor: number }>()
const titleRequests = new Map<string, AbortController>()

function updateTitle(id: string, state: { parser: TerminalTitleParser; cursor: number }, snapshot: { buffer: string; endByte: number; reset: boolean }) {
  if (snapshot.reset) {
    const previousTitle = state.parser.title
    state.parser = new TerminalTitleParser()
    state.parser.title = previousTitle
  }
  const title = state.parser.push(snapshot.buffer)
  state.cursor = snapshot.endByte
  const session = sessions.value.find(item => item.id === id)
  if (session && title !== undefined) session.terminalTitle = title
}

async function syncBackgroundTitles(client: MobileHostApi, root: string) {
  await Promise.all(visibleSessions.value.filter(session => session.id !== selectedId.value).map(async session => {
    if (titleRequests.has(session.id)) return
    const state = titles.get(session.id) ?? { parser: new TerminalTitleParser(), cursor: 0 }
    titles.set(session.id, state)
    const controller = new AbortController()
    titleRequests.set(session.id, controller)
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const snapshot = await client.terminalBuffer(session.id, state.cursor, { signal: controller.signal })
      if (!disposed && client === props.api && root === props.root && titles.get(session.id) === state && session.id !== selectedId.value) updateTitle(session.id, state, snapshot)
    } catch {
      // A closed session or temporary connection failure is handled by session polling.
    } finally { clearTimeout(timeout); if (titleRequests.get(session.id) === controller) titleRequests.delete(session.id) }
  }))
}

function startTitleScroll(event: MouseEvent) {
  const label = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.mobile-session-tab-label')
  const text = label?.firstElementChild as HTMLElement | null
  if (!label || !text) return
  const distance = Math.max(0, text.scrollWidth - label.clientWidth)
  label.style.setProperty('--title-scroll-distance', `${distance}px`)
  label.style.setProperty('--title-scroll-duration', `${Math.max(2, distance / 30)}s`)
  label.classList.toggle('is-overflowing', distance > 0)
}

function stopTitleScroll(event: MouseEvent) {
  (event.currentTarget as HTMLElement).querySelector('.mobile-session-tab-label')?.classList.remove('is-overflowing')
}

function currentMonoFontFamily() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
}

function currentMonoFontWeight(): FontWeight {
  const weight = Number(getComputedStyle(document.documentElement).getPropertyValue('--font-mono-weight'))
  return weight > 0 ? weight : 'normal'
}

function inProject(left: string, right: string) {
  const path = left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const root = right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return path === root || path.startsWith(`${root}/`)
}

async function act(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try { await action() } catch (cause) { error.value = formatError(cause) }
  finally { busy.value = false }
}

function formatError(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

async function refresh() {
  if (!props.connected || !props.root) return
  await act(syncSessions)
}

async function syncSessions() {
  const client = props.api
  const root = props.root
  const revision = sessionRevision
  const result = await client.listTerminals()
  if (disposed || client !== props.api || root !== props.root || revision !== sessionRevision) return
  sessions.value = result.map(session => ({ ...session, terminalTitle: titles.get(session.id)?.parser.title ?? session.terminalTitle }))
  const liveIds = new Set(result.map(session => session.id))
  for (const id of titles.keys()) if (!liveIds.has(id)) titles.delete(id)
  if (!activeSession.value) selectedId.value = visibleSessions.value[0]?.id ?? ''
  void syncBackgroundTitles(client, root)
}

async function pollSessions() {
  if (disposed) return
  try {
    if (props.connected && props.root && !busy.value) await syncSessions()
  } catch {
    // Output polling owns connection errors; a transient list failure must not erase tabs.
  } finally {
    if (!disposed) sessionSyncTimer = setTimeout(() => void pollSessions(), 1000)
  }
}

function removeSession(id: string) {
  sessionRevision++
  titles.delete(id)
  sessions.value = sessions.value.filter(session => session.id !== id)
  if (selectedId.value === id) selectedId.value = visibleSessions.value[0]?.id ?? ''
}

async function create() {
  if (!props.connected || !props.root || !cliProviderVisible(provider.value, props.hiddenCliProviderIds)) return
  await act(async () => {
    sessionRevision++
    const session = await props.api.createTerminal(props.root, props.mode === 'terminal' ? 'local' : provider.value)
    sessionRevision++
    sessions.value = [...sessions.value.filter((entry) => entry.id !== session.id), session]
    selectedId.value = session.id
    showHistory.value = false
  })
}

async function write(input: string, submit = false) {
  if (!activeSession.value || !running.value || disposed) return false
  const id = selectedId.value
  const epoch = generation
  const client = props.api
  pendingInputs++
  sending.value = true
  const task = inputQueue.then(async () => {
    if (disposed || epoch !== generation || client !== props.api) return false
    error.value = ''
    try {
      await client.writeTerminal(id, input)
      if (submit) {
        // Interactive CLIs debounce fast paste; a separate Enter commits the prompt.
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (disposed || epoch !== generation || client !== props.api) return false
        await client.writeTerminal(id, '\r')
      }
      return true
    } catch (cause) {
      if (!disposed && epoch === generation) error.value = `输入发送失败：${formatError(cause)}`
      return false
    }
  })
  inputQueue = task
  try { return await task }
  finally { pendingInputs--; sending.value = pendingInputs > 0 }
}

async function sendDraft() {
  if (sending.value || (!draft.value.trim() && !attachments.value.length) || !attachmentsReady.value) return
  const text = draft.value
  const sentAttachments = [...attachments.value]
  const value = [text, ...sentAttachments.map(item => `附件：${item.path}`)].filter(Boolean).join('\n')
  // CLI prompts use bracketed paste for multiline text and a delayed Enter.
  const ai = activeSession.value?.providerKind !== 'local'
  const input = ai && /[\r\n]/.test(value)
    ? `\u001b[200~${value.replace(/\r\n/g, '\n')}\u001b[201~`
    : ai ? value : `${value.replace(/\r?\n/g, '\r')}\r`
  if (await write(input, ai)) {
    if (draft.value === text) draft.value = ''
    attachments.value = attachments.value.filter(item => !sentAttachments.includes(item))
  }
}

async function openCommands() {
  terminal?.focus()
  if (await write('/')) commandControlsOpen.value = true
}

const keysOpen = computed(() => running.value && (commandControlsOpen.value || keysPinned.value || Boolean(menu.value)))

function arrowKey(direction: 'A' | 'B' | 'C' | 'D') {
  return terminal?.modes?.applicationCursorKeysMode ? `\u001bO${direction}` : `\u001b[${direction}`
}

// Key buttons must not focus xterm: its hidden textarea raises the phone keyboard.
async function commandKey(input: string) {
  if (await write(input)) {
    if (input === '\u001b') commandControlsOpen.value = false
  }
}

let repeatTimer: ReturnType<typeof setTimeout> | undefined
let repeated = false
function startRepeat(input: string) {
  stopRepeat()
  repeated = false
  repeatTimer = setTimeout(function tick() {
    repeated = true
    if (pendingInputs < 2) void write(input)
    repeatTimer = setTimeout(tick, 80)
  }, 350)
}
function stopRepeat() { clearTimeout(repeatTimer); repeatTimer = undefined }
function tapKey(input: string) {
  if (repeated) { repeated = false; return }
  void commandKey(input)
}

function updateMenu() {
  const next = running.value && renderer ? detectTerminalMenu(renderer.screenLines()) : null
  if (next && !menu.value) terminal?.textarea?.blur()
  menu.value = next
}

async function selectOption(index: number) {
  const current = menu.value
  const option = current?.options[index]
  if (!current || !option || sending.value) return
  const delta = index - current.selectedIndex
  const key = arrowKey(delta > 0 ? 'B' : 'A')
  // One write per key: Ink-based CLIs read a batched chunk as a single keypress.
  for (let step = 0; step < Math.abs(delta); step += 1) if (!await write(key)) return
  // Checkbox lists toggle and submit with their own keys; only move there.
  if (!option.checkbox) await write('\r')
}

function clickTerminal(event: MouseEvent) {
  if (!terminal || !running.value || terminal.hasSelection()) return
  const screen = terminalHost.value?.querySelector('.xterm-screen')?.getBoundingClientRect()
  if (!screen || screen.height <= 0) return
  const row = Math.floor((event.clientY - screen.top) * terminal.rows / screen.height)
  if (row < 0 || row >= terminal.rows) return
  const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? ''
  const number = menu.value && Number(line.match(/^\s*[›❯>▶▸➤→]?\s*(\d{1,2})[.)]\s/)?.[1])
  const option = number ? menu.value!.options.findIndex(entry => entry.number === number) : -1
  if (option >= 0) {
    terminal.textarea?.blur()
    void selectOption(option)
    return
  }
  const command = line.match(/^\s*(\/[a-zA-Z][\w:-]*)(?:\s|$)/)?.[1]
  if (!command) return
  commandControlsOpen.value = true
  // Complete the tapped menu entry without executing it; keep the CLI editor focused.
  terminal.focus()
  void write(`\u001b[F\u0015${command} `)
}

async function closeSession(id: string) {
  if (busy.value) return
  await act(async () => {
    await props.api.closeTerminal(id)
    removeSession(id)
  })
}

async function loadHistory() {
  showHistory.value = !showHistory.value
  conversation.value = null
  if (showHistory.value) await act(async () => { history.value = await props.api.listConversations(props.root) })
}

async function readHistory(entry: CliNativeConversationSummary) {
  await act(async () => { conversation.value = await props.api.readConversation(props.root, entry.sourcePath) })
}

async function resume(entry: CliNativeConversationDetail) {
  if (!entry.nativeSessionId || !cliProviderVisible(entry.providerKind, props.hiddenCliProviderIds)) return
  await act(async () => {
    sessionRevision++
    const session = await props.api.resumeConversation(props.root, entry.providerKind, entry.nativeSessionId!)
    sessionRevision++
    sessions.value = [...sessions.value.filter((item) => item.id !== session.id), session]
    selectedId.value = session.id
    showHistory.value = false
    conversation.value = null
  })
}

function scheduleFit() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(async () => {
    if (!terminalHost.value?.clientHeight || showHistory.value) return
    if (!terminal || !fit) return
    const view = terminal
    const epoch = generation
    await writeMobileTerminalProjection(view, '')
    if (disposed || epoch !== generation || terminal !== view) return
    const historyY = view.buffer.active.viewportY
    const browsingHistory = historyY < view.buffer.active.baseY
    terminal.options.fontSize = props.fontSize
    const available = fit.proposeDimensions()
    if (!available) return
    // Shrink only below 80 columns; wider screens (landscape, tablets) use every column.
    const displayCols = Math.min(sourceCols, Math.max(80, available.cols))
    terminal.options.fontSize = fittedTerminalFontSize(props.fontSize, available.cols, displayCols)
    // Account for the renderer rounding fractional cell widths to physical pixels.
    const fitted = fit.proposeDimensions()
    if (fitted && fitted.cols < displayCols && terminal.options.fontSize > 3) {
      terminal.options.fontSize = fittedTerminalFontSize(terminal.options.fontSize, fitted.cols, displayCols)
    }
    const viewport = fit.proposeDimensions()
    if (!viewport) return
    const cols = Math.min(displayCols, viewport.cols)
    terminal.resize(cols, viewport.rows)
    renderer?.resizeViewport(viewport.rows, cols)
    if (renderer) await writeMobileTerminalProjection(view, renderer.render(''), renderer.takeHistoryCorrections())
    if (browsingHistory && !disposed && epoch === generation && terminal === view) view.scrollToLine(historyY)
  }, 150)
}

function scheduleFrameFlush() {
  if (!renderer?.hasPendingOutput) {
    clearTimeout(frameTimer)
    frameTimer = undefined
    return
  }
  if (frameTimer !== undefined) return
  const epoch = generation
  frameTimer = setTimeout(() => {
    frameTimer = undefined
    if (disposed || epoch !== generation || !terminal || !renderer) return
    void writeMobileTerminalProjection(terminal, renderer.flushPending(), renderer.takeHistoryCorrections())
    updateMenu()
  }, MOBILE_TERMINAL_FRAME_TIMEOUT_MS)
}

async function poll(id: string, epoch: number) {
  if (disposed || epoch !== generation) return
  let nextDelay = 0
  try {
    const controller = new AbortController()
    outputRequest = controller
    const snapshot = await props.api.terminalBuffer(id, cursor, {
      waitMs: receivedSnapshot ? 1000 : 0, cols: sourceCols, rows: sourceRows, signal: controller.signal,
    })
    if (disposed || epoch !== generation) return
    receivedSnapshot = true
    const titleState = titles.get(id)
    if (titleState) updateTitle(id, titleState, snapshot)
    streamError.value = ''
    const wasRunning = running.value
    running.value = snapshot.running
    if (snapshot.cols && snapshot.rows) {
      if (sourceCols !== snapshot.cols || sourceRows !== snapshot.rows) {
        sourceCols = snapshot.cols
        sourceRows = snapshot.rows
        renderer?.resizeSource(sourceCols, sourceRows)
        scheduleFit()
      }
    } else {
      // Older Hosts do not wait for output; keep their idle polling bounded.
      nextDelay = snapshot.buffer ? 16 : 350
    }
    if (snapshot.reset) { renderer?.reset(); terminalColors.reset() }
    if (terminal && renderer) {
      const output = renderer.render(terminalColors.transform(snapshot.buffer, props.theme))
      await writeMobileTerminalProjection(terminal, output, renderer.takeHistoryCorrections())
      scheduleFrameFlush()
    }
    if (disposed || epoch !== generation) return
    updateMenu()
    cursor = snapshot.endByte
    if (!wasRunning && snapshot.running) scheduleFit()
    if (!snapshot.running) return
  } catch (cause) {
    if (disposed || epoch !== generation) return
    if (cause instanceof MobileHostError && cause.status === 404) {
      running.value = false
      streamError.value = ''
      removeSession(id)
      return
    }
    streamError.value = `连接中断，正在重试：${formatError(cause)}`
  }
  pollTimer = setTimeout(() => void poll(id, epoch), streamError.value ? 2500 : nextDelay)
}

watch([selectedId, () => props.theme], async () => {
  generation += 1
  outputRequest?.abort()
  const epoch = generation
  const id = selectedId.value
  if (id) {
    const parser = new TerminalTitleParser()
    parser.title = titles.get(id)?.parser.title
    titles.set(id, { parser, cursor: 0 })
  }
  clearTimeout(pollTimer)
  clearTimeout(frameTimer)
  frameTimer = undefined
  cursor = 0
  receivedSnapshot = false
  sourceCols = 120
  sourceRows = 32
  running.value = false
  commandControlsOpen.value = false
  menu.value = null
  streamError.value = ''
  if (terminal) await writeMobileTerminalProjection(terminal, MOBILE_TERMINAL_CLEAR)
  if (epoch !== generation || disposed) return
  renderer?.dispose()
  renderer = new MobileTerminalRenderer(sourceCols, sourceRows, terminal?.rows ?? sourceRows, terminal?.cols ?? 80, true)
  terminalColors.reset()
  await nextTick()
  scheduleFit()
  if (id && epoch === generation && !disposed) void poll(id, epoch)
})

watch(() => props.mode, () => {
  selectedId.value = visibleSessions.value[0]?.id ?? ''
  showHistory.value = false
  conversation.value = null
})
watch(showHistory, () => { void nextTick(scheduleFit) })

watch(() => props.fontStyleId, () => {
  if (!terminal) return
  terminal.options.fontFamily = currentMonoFontFamily()
  terminal.options.fontWeight = currentMonoFontWeight()
  terminal.refresh(0, terminal.rows - 1)
})

onMounted(async () => {
  window.addEventListener('resize', fitDraft)
  terminal = new Terminal({
    cols: 80, rows: sourceRows,
    fontSize: props.fontSize, fontFamily: currentMonoFontFamily(), fontWeight: currentMonoFontWeight(),
    theme: buildTerminalTheme(props.theme), scrollback: 4000, cursorBlink: false,
    minimumContrastRatio: 4.5,
    disableStdin: false, convertEol: false,
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(terminalHost.value!)
  terminal.onData(input => {
    if (input === '/') commandControlsOpen.value = true
    void write(input)
  })
  observer = new ResizeObserver(scheduleFit)
  observer.observe(terminalHost.value!)
  scheduleFit()
  if (!props.connected || !props.root) return
  await refresh()
  if (!disposed) sessionSyncTimer = setTimeout(() => void pollSessions(), 1000)
  try {
    providers.value = await props.api.listProviders()
    if (!availableProviders.value.some((entry) => entry.providerKind === provider.value)) {
      provider.value = availableProviders.value[0]?.providerKind ?? 'codex'
    }
  } catch (cause) { error.value = formatError(cause) }
})

watch(() => [props.fontSize, props.theme], () => {
  if (terminal) { terminal.options.fontSize = props.fontSize; terminal.options.theme = buildTerminalTheme(props.theme); scheduleFit() }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', fitDraft)
  disposed = true
  outputRequest?.abort()
  for (const request of titleRequests.values()) request.abort()
  generation += 1
  clearTimeout(pollTimer)
  clearTimeout(resizeTimer)
  observer?.disconnect()
  clearTimeout(sessionSyncTimer)
  chatGeneration++
  clearTimeout(chatTimer)
  clearTimeout(frameTimer)
  stopRepeat()
  renderer?.dispose()
  terminal?.dispose()
})
defineExpose({ refresh, loadHistory, showHistory, busy })
</script>

<template>
  <section class="mobile-sessions">
    <Teleport defer to="#mobile-cli-launchers" :disabled="!launcherTarget">
    <div class="mobile-session-toolbar mobile-cli-launchers" aria-label="CLI 工具">
      <button v-for="entry in visibleCliProviders" :key="entry.id" class="mobile-text-button" type="button"
        :disabled="busy || !cliProviderVisible(entry.id, hiddenCliProviderIds) || (connected && (!root || !availableProviders.some(p => p.providerKind === entry.id)))"
        :title="entry.name" @click="launch(entry.id)">
        <CliProviderIcon :provider="entry.id" :size="15" />{{ entry.shortName }}
      </button>
    </div>
    </Teleport>
    <div v-if="error || streamError" class="mobile-error" role="alert">{{ error || streamError }}</div>
    <div v-if="!showHistory && connected && root && visibleSessions.length" class="mobile-session-tabs" role="tablist" aria-label="会话列表">
      <div
        v-for="session in visibleSessions"
        :key="session.id"
        class="mobile-session-tab"
        :class="{ active: session.id === selectedId }"
      >
        <button type="button" role="tab" class="mobile-session-tab-select" :aria-selected="session.id === selectedId" :aria-label="terminalSessionTitle(session)" :title="terminalSessionTitle(session)" @mouseenter="startTitleScroll" @mouseleave="stopTitleScroll" @click="selectedId = session.id">
        <CliProviderIcon v-if="session.providerKind !== 'local'" :provider="session.providerKind" :size="14" class="mobile-session-tab-icon" />
        <span class="mobile-session-tab-label"><span>{{ terminalSessionTitle(session) }}</span></span>
        </button>
        <button
          type="button"
          class="mobile-session-tab-close"
          :aria-label="`关闭 ${terminalSessionTitle(session)}`"
          :disabled="busy"
          @click.stop="closeSession(session.id)"
        >
          <Trash2 :size="12" />
        </button>
      </div>
    </div>
    <div v-if="!showHistory && activeSession && activeSession.providerKind !== 'local'" class="mobile-chat-mode" aria-label="会话显示模式">
      <button class="mobile-text-button" type="button" :aria-pressed="displayMode === 'chat'" @click="displayMode = 'chat'">聊天</button>
      <button class="mobile-text-button" type="button" :aria-pressed="displayMode === 'terminal'" @click="displayMode = 'terminal'">终端</button>
    </div>
    <div v-if="showHistory" class="mobile-history">
      <template v-if="conversation">
        <div class="mobile-session-toolbar">
          <button class="mobile-text-button" @click="conversation = null">返回列表</button>
          <button class="mobile-text-button" :disabled="busy || !conversation.resumeSupported || !conversation.nativeSessionId || !cliProviderVisible(conversation.providerKind, hiddenCliProviderIds)" @click="resume(conversation)">继续对话</button>
        </div>
        <article v-for="message in conversation.messages" :key="message.id" class="mobile-chat-message">
          <strong>{{ message.role === 'user' ? '你' : cliProviderLabel(conversation.providerKind) }}</strong>
          <pre :class="{ 'chat-user-bubble': message.role === 'user' }">{{ message.content }}</pre>
        </article>
        <p v-if="!conversation.messages.length" class="mobile-empty">此记录没有可显示的消息。</p>
      </template>
      <template v-else>
        <button v-for="entry in history" :key="entry.sourcePath" class="mobile-history-row" :disabled="busy" @click="readHistory(entry)">
          <strong>{{ entry.title || cliProviderLabel(entry.providerKind) }}</strong>
          <small>{{ cliProviderLabel(entry.providerKind) }} · {{ entry.messageCount }} 条消息</small>
        </button>
        <p v-if="!busy && !history.length" class="mobile-empty">此工作区还没有 AI 对话记录。</p>
      </template>
    </div>
    <div v-if="!showHistory && activeSession && activeSession.providerKind !== 'local' && displayMode === 'chat'" ref="chatScroller" class="mobile-chat-scroll" aria-label="聊天记录">
      <p v-if="chatError" class="mobile-error" role="alert">{{ chatError }}</p>
      <p v-else-if="!chat?.turns.length" class="mobile-empty">等待对话内容</p>
      <article v-for="turn in chat?.turns ?? []" :key="turn.id" class="mobile-chat-turn">
        <div v-if="turn.prompt" class="mobile-chat-prompt chat-user-bubble">{{ turn.prompt }}</div>
        <details v-if="turn.steps.length" class="mobile-chat-steps">
          <summary>执行详情（{{ turn.steps.length }}）</summary>
          <div v-for="(step, index) in turn.steps" :key="index" class="mobile-chat-step">
            <strong>{{ step.title }}</strong>
            <div v-if="step.kind === 'text'" class="markdown-body" v-html="renderMarkdown(step.detail)" />
            <div v-else class="markdown-body" v-html="renderCodeBlock(step.output || step.detail || step.title)" />
          </div>
        </details>
        <div v-if="turn.answer" class="mobile-chat-answer">
          <strong>{{ cliProviderLabel(activeSession.providerKind) }}</strong>
          <div class="markdown-body" v-html="renderMarkdown(turn.answer)" />
        </div>
        <p v-else-if="turn.interrupted" class="mobile-empty">本轮已中断</p>
        <p v-else-if="turn.completedAt === null" class="mobile-empty">正在处理…</p>
      </article>
    </div>
    <div v-show="!showHistory && (!activeSession || activeSession.providerKind === 'local' || displayMode === 'terminal')" class="mobile-terminal-area">
      <div v-if="!activeSession" class="mobile-terminal-empty">
        <div class="terminal-empty-card">
          <strong>暂无 CLI 会话</strong>
          <p>{{ !connected ? '连接电脑后开始 CLI 会话。' : !root ? '从资源管理器选择工作区后开始 CLI 会话。' : '创建 CLI 会话后，上方显示原始 CLI 渲染，下方保留对话输入区。' }}</p>
          <div class="mobile-empty-launchers">
            <button v-for="entry in visibleCliProviders" :key="entry.id" class="mobile-text-button" type="button"
              :disabled="busy || (connected && (!root || !availableProviders.some(p => p.providerKind === entry.id)))"
              :title="entry.name" @click="launch(entry.id)"><CliProviderIcon :provider="entry.id" :size="15" />{{ entry.shortName }}</button>
          </div>
        </div>
      </div>
      <div ref="terminalHost" class="mobile-terminal" :class="{ 'is-empty': !activeSession }" aria-label="会话输出" @click="clickTerminal" />
    </div>
    <form v-if="!showHistory" class="mobile-session-input" :class="{ 'is-focused': inputFocused }" @submit.prevent="sendDraft">
      <div class="mobile-compose-row">
        <textarea ref="draftInput" v-model="draft" aria-label="消息" placeholder="输入消息或使用语音输入" rows="1" @focus="focusDraft" @blur="inputFocused = false; scheduleFit()" />
        <div class="mobile-compose-actions">
          <button class="mobile-icon-button" type="button" aria-label="添加附件" title="添加附件" :aria-expanded="attachmentPanelOpen" :disabled="sending" @click="toggleAttachments"><Plus :size="20" /></button>
          <button class="mobile-icon-button" type="button" aria-label="唤起指令" title="打开 CLI 指令菜单" :aria-expanded="commandControlsOpen" :disabled="!running || sending || commandControlsOpen" @click="openCommands"><Slash :size="19" /></button>
          <button class="mobile-icon-button" type="button" aria-label="按键栏" title="显示方向键、Esc、Tab 等按键" :aria-expanded="keysOpen" :disabled="!running" @click="keysPinned = !keysPinned"><Keyboard :size="19" /></button>
          <button class="mobile-icon-button" type="button" :aria-label="voiceButtonTitle" :title="voiceButtonTitle" :aria-pressed="isVoiceListening" :disabled="!voiceInputAvailable" @click="toggleVoiceInput"><Mic :size="19" /></button>
          <button class="mobile-icon-button mobile-send-button" type="submit" aria-label="发送" :disabled="!running || sending || !attachmentsReady || (!draft.trim() && !attachments.length)"><Send :size="18" /></button>
        </div>
      </div>
      <div v-if="menu" class="mobile-menu-options" role="listbox" aria-label="CLI 选项">
        <button v-for="(option, index) in menu.options" :key="option.number" class="mobile-menu-option" type="button" role="option"
          :aria-selected="index === menu.selectedIndex" :disabled="sending" @click="selectOption(index)">
          <span class="mobile-menu-option-number">{{ option.number }}</span>
          <span class="mobile-menu-option-text"><strong>{{ option.label }}</strong><small v-if="option.detail">{{ option.detail }}</small></span>
        </button>
      </div>
      <div v-if="keysOpen" class="mobile-command-controls" aria-label="CLI 按键">
        <button v-for="key in ([['↑', 'A', '上移'], ['↓', 'B', '下移'], ['←', 'D', '左移'], ['→', 'C', '右移']] as const)" :key="key[1]"
          class="mobile-text-button" type="button" :aria-label="key[2]"
          @pointerdown="startRepeat(arrowKey(key[1]))" @pointerup="stopRepeat" @pointerleave="stopRepeat" @pointercancel="stopRepeat"
          @contextmenu.prevent @click="tapKey(arrowKey(key[1]))">{{ key[0] }}</button>
        <button class="mobile-text-button" type="button" :disabled="sending" @click="commandKey('\r')">确认</button>
        <button class="mobile-text-button" type="button" :disabled="sending" @click="commandKey('\u001b')">退出</button>
        <button class="mobile-text-button" type="button" :disabled="sending" @click="commandKey(' ')">空格</button>
        <button class="mobile-text-button" type="button" :disabled="sending" @click="commandKey('\t')">Tab</button>
      </div>
      <div v-if="attachments.length" class="mobile-attachment-list" aria-label="待发送附件">
        <div v-for="item in attachments" :key="item.id" class="mobile-attachment-row">
          <File :size="15" /><span>{{ item.file.name }}<small>{{ item.state === 'uploading' ? '上传中…' : item.state === 'ready' ? '已上传' : item.error }}</small></span>
          <button v-if="item.state === 'error'" class="mobile-icon-button" type="button" aria-label="重试上传" :disabled="sending" @click="queueUpload(item)"><RefreshCw :size="15" /></button>
          <button class="mobile-icon-button" type="button" aria-label="移除附件" :disabled="sending" @click="removeAttachment(item.id)"><X :size="15" /></button>
        </div>
      </div>
      <div v-if="attachmentPanelOpen" class="mobile-attachment-actions" aria-label="附件来源">
        <button class="mobile-text-button" type="button" @click="cameraInput?.click()"><Camera :size="20" />拍照</button>
        <button class="mobile-text-button" type="button" @click="albumInput?.click()"><ImageIcon :size="20" />相册</button>
        <button class="mobile-text-button" type="button" @click="fileInput?.click()"><File :size="20" />文件</button>
      </div>
      <input ref="cameraInput" type="file" accept="image/*" capture="environment" hidden aria-label="拍照上传" @change="selectAttachments" />
      <input ref="albumInput" type="file" accept="image/*" multiple hidden aria-label="选择相册照片" @change="selectAttachments" />
      <input ref="fileInput" type="file" multiple hidden aria-label="选择文件" @change="selectAttachments" />
      <div v-if="voiceStatusMessage" class="mobile-voice-status" role="status">{{ voiceStatusMessage }}</div>
    </form>
  </section>
</template>
