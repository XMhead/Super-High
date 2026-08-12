<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Cpu, MessageSquarePlus, Mic, MicOff, Play, Plus, RotateCcw, Save, Send, Square, TerminalSquare, Trash2, X } from 'lucide-vue-next'

import { buildTerminalTheme } from '@/lib/theme'
import {
  buildCliMessageWithImages,
  clipboardEventHasImages,
  extractPastedImagesFromClipboardApi,
  extractPastedImagesFromClipboardEvent,
  fileNameFromPath,
  type CliImageAttachment,
  type PastedImageCandidate,
} from '@/lib/cliImagePaste'
import { backend, onTerminalOutput, type TerminalOutputPayload } from '@/lib/tauri'
import { CLI_PROVIDER_OPTIONS, cliProviderLabel } from '@/lib/cliProviders'
import { CodexTerminalRenderer } from '@/lib/codexTerminalRenderer'
import { createLeftAltVoiceShortcutTracker } from '@/lib/leftAltVoiceShortcut'
import { appendVoiceText, useVoiceInput } from '@/lib/voiceInput'
import { useWorkspaceStore } from '@/stores/workspace'
import type { PlanProposal, ProjectTerminalAction, TerminalProviderKind, TerminalSession } from '@/types'

const props = withDefaults(defineProps<{
  mode?: 'cli' | 'local'
  cwd?: string
  initialPrompt?: string
  sessionIds?: string[]
  activeSessionId?: string | null
  compactTeam?: boolean
}>(), {
  mode: 'cli',
  cwd: '',
  initialPrompt: '',
  sessionIds: () => [],
  activeSessionId: null,
  compactTeam: false,
})

const store = useWorkspaceStore()
const host = ref<HTMLDivElement | null>(null)
const draftInput = ref<HTMLTextAreaElement | null>(null)
const selectedText = ref('')
const imageAttachmentsBySession = ref<Record<string, CliImageAttachment[]>>({})
const isPastingImage = ref(false)
const closingSessionIds = ref<Record<string, boolean>>({})
const startingProjectStartup = ref(false)
const phrasePanelOpen = ref(false)
const phraseTitle = ref('')
const phraseText = ref('')
const isSavingPhrase = ref(false)
const currentThemeId = computed(() => store.currentThemeId)
const isCliMode = computed(() => props.mode === 'cli')
const isCodexTerminal = computed(() => isCliMode.value && activeSession.value?.providerKind === 'codex')
const showCliConversation = computed(() => isCliMode.value && !props.compactTeam)
const sessions = computed(() => {
  const raw = !isCliMode.value
    ? store.localTerminalSessions
    : store.cliTerminalSessions
  if (!props.sessionIds || props.sessionIds.length === 0) return raw
  const idSet = new Set(props.sessionIds)
  return raw.filter((s) => idSet.has(s.id))
})
const activeSession = computed(() => {
  if (props.activeSessionId) {
    const scoped = sessions.value.find((session) => session.id === props.activeSessionId)
    if (scoped) return scoped
  }
  if (!isCliMode.value) return store.activeLocalTerminalSession
  const active = store.activeCliTerminalSession
  if (!props.sessionIds || props.sessionIds.length === 0) return active
  return sessions.value.find((session) => session.id === active?.id) ?? sessions.value[0] ?? null
})
const projectStartupSession = computed(() => (
  store.terminalSessions.find((session) => (
    session.providerKind === 'project-startup'
    && !session.restoredFromDisk
    && store.terminalExitCodes[session.id] == null
  )) ?? null
))
const isServiceStartupConfig = computed(() => store.projectStartupConfig?.mode === 'services')
const isSingleStartupConfig = computed(() => !!store.projectStartupConfig && !isServiceStartupConfig.value)
const projectStartupName = computed(() => store.projectStartupConfig?.name ?? '服务链')
const projectServices = computed(() => store.projectStartupConfig?.services ?? [])
const projectTerminalActions = computed(() => store.projectTerminalActions)
const hasProjectTerminalActions = computed(() => projectTerminalActions.value.length > 0)
const projectServiceChainActive = computed(() => ['starting', 'running'].includes(store.projectServiceRun?.chainStatus ?? 'idle'))
const serviceStatusLabel: Record<string, string> = {
  pending: '待启动',
  starting: '启动中',
  running: '运行中',
  externalRunning: '外部运行',
  failed: '失败',
  exited: '已退出',
}
const projectServiceSummary = computed(() => projectServices.value
  .filter((service) => {
    const run = store.projectServiceRun?.services[service.id]
    return !!run && !run.sessionId
  })
  .map((service) => `${service.name} ${serviceStatusLabel[projectServiceStatus(service.id)] ?? projectServiceStatus(service.id)}`)
  .join(' · ')
)
const activeDraft = computed({
  get: () => activeSession.value ? store.terminalDrafts[activeSession.value.id] ?? '' : '',
  set: (value: string) => {
    if (activeSession.value) store.setTerminalDraft(activeSession.value.id, value)
  },
})
const isEnded = computed(() => {
  const sessionId = activeSession.value?.id
  return !!sessionId && store.terminalExitCodes[sessionId] != null
})
const activeImageAttachments = computed(() => {
  const sessionId = activeSession.value?.id
  if (!sessionId) return [] as CliImageAttachment[]
  return imageAttachmentsBySession.value[sessionId] ?? []
})
const canSendDraft = computed(() => (
  !isEnded.value
  && !isPastingImage.value
  && (!!activeDraft.value.trim() || activeImageAttachments.value.length > 0)
))
const quickPhrases = computed(() => store.settings.quickPhrases ?? [])
const canSaveQuickPhrase = computed(() => (
  isCliMode.value
  && !!activeSession.value
  && !isEnded.value
  && !isSavingPhrase.value
  && !!phraseText.value.trim()
))

const {
  isVoiceListening,
  voiceButtonTitle,
  voiceInputAvailable,
  voiceInputState,
  voiceStatusMessage,
  toggleVoiceInput,
} = useVoiceInput({
  focusInput: focusDraftInput,
  appendText: (text) => {
    activeDraft.value = appendVoiceText(activeDraft.value, text)
    void nextTick(() => syncDraftHeight(draftInput.value, true))
  },
})
const leftAltVoiceShortcut = createLeftAltVoiceShortcutTracker()
let terminal: Terminal | null = null
let codexTerminalRenderer: CodexTerminalRenderer | null = null
let fitAddon: FitAddon | null = null
let webglAddon: WebglAddon | null = null
let resizeObserver: ResizeObserver | null = null
let visibilityObserver: IntersectionObserver | null = null
let terminalVisible = true
let resizeTimer: number | null = null
let terminalRenderFrame: number | null = null
let lastFitTime = 0
let lastKnownHostWidth = 0
let lastKnownHostHeight = 0
let draftHeightFitSuppressedUntil = 0
let bufferedOutputChunks: string[] = []
let renderedOutputEndByte = 0
let outputListenerCleanup: (() => void) | null = null
let activeSessionIdSnapshot: string | null = null
let bufferRefreshInFlightForSession: string | null = null
let deferredOutputEvents: TerminalOutputPayload[] = []
let terminalPrimeRetryTimers: number[] = []
let terminalPaneMounted = false
let terminalActivationToken = 0
let writeInFlight = false
const terminalBufferFailedSessionIds = new Set<string>()
const terminalWriteCharsPerFrame = 32 * 1024
const terminalMaxBufferedBytes = 2 * 1024 * 1024
const draftHeightFitSuppressionMs = 180
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

function providerLabel(session: TerminalSession): string {
  if (session.providerKind === 'project-service' || session.providerKind === 'project-startup') {
    return session.title || '服务端'
  }
  return cliProviderLabel(session.providerKind) || session.title || '终端'
}

function activeSessionTitle(session: TerminalSession): string {
  return session.name?.trim() || providerLabel(session)
}

function setActiveSession(sessionId: string) {
  store.setActiveTerminalSession(sessionId)
}

function createProviderSession(provider: TerminalProviderKind) {
  void (async () => {
    await store.createTerminalSession(provider, {
      cwd: props.cwd,
      initialPrompt: props.initialPrompt,
    })
    await syncActiveTerminalSession()
  })().catch((error) => {
    const label = provider === 'local' ? 'PowerShell' : providerLabel({
      id: '',
      title: '',
      providerKind: provider,
      cwd: '',
    })
    store.showErrorMessage(`启动 ${label} 失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

function openExternalProviderSession(provider: TerminalProviderKind) {
  void (async () => {
    const cwd = props.cwd.trim() || store.workspace?.rootPath?.trim()
    if (!cwd) throw new Error('当前没有可用的项目目录')
    await backend.openExternalCli(provider, cwd)
    store.showActivityMessage(`已在外部 CMD 启动 ${providerLabel({
      id: '',
      title: '',
      providerKind: provider,
      cwd,
    })}`)
  })().catch((error) => {
    const label = providerLabel({
      id: '',
      title: '',
      providerKind: provider,
      cwd: '',
    })
    store.showErrorMessage(`外部启动 ${label} 失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

async function toggleProjectStartup() {
  if (startingProjectStartup.value) return
  startingProjectStartup.value = true
  try {
    if (projectStartupSession.value) {
      await store.closeTerminalSession(projectStartupSession.value.id)
    } else {
      await store.createProjectStartupTerminalSession()
    }
  } catch (error) {
    store.showErrorMessage(`服务端操作失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    startingProjectStartup.value = false
  }
}

function projectServiceStatus(serviceId: string): string {
  return store.projectServiceRun?.services[serviceId]?.status ?? 'pending'
}

async function startProjectServices() {
  try {
    await store.startProjectServices()
  } catch (error) {
    store.showErrorMessage(`启动服务链失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// 终端动作图标按动作语义分配，避免项目配置里写 UI 细节。
function terminalActionIcon(action: ProjectTerminalAction): 'play' | 'restart' {
  if (action.kind === 'restart-project') return 'restart'
  return 'play'
}

// 执行当前工作区声明的本地终端动作。
function runProjectTerminalAction(action: ProjectTerminalAction) {
  void store.runProjectTerminalAction(action)
}

function terminalSessionState(session: TerminalSession): string | null {
  if (store.terminalExitCodes[session.id] != null) return '已退出'
  if (session.providerKind !== 'project-service') return null
  const service = projectServices.value.find((item) => (
    store.projectServiceRun?.services[item.id]?.sessionId === session.id
  ))
  return service ? serviceStatusLabel[projectServiceStatus(service.id)] ?? projectServiceStatus(service.id) : null
}

function openNewConversation() {
  store.setNewConversationDialogOpen(true)
}

async function closeSession(sessionId: string) {
  if (closingSessionIds.value[sessionId]) return
  closingSessionIds.value = { ...closingSessionIds.value, [sessionId]: true }
  try {
    await store.closeTerminalSession(sessionId)
  } finally {
    const next = { ...closingSessionIds.value }
    delete next[sessionId]
    closingSessionIds.value = next
  }
}

function disposeTerminal() {
  if (resizeTimer) window.clearTimeout(resizeTimer)
  resizeTimer = null
  if (terminalRenderFrame) window.cancelAnimationFrame(terminalRenderFrame)
  terminalRenderFrame = null
  clearTerminalPrimeRetryTimers()
  void outputListenerCleanup?.()
  outputListenerCleanup = null
  activeSessionIdSnapshot = null
  bufferRefreshInFlightForSession = null
  deferredOutputEvents = []
  resizeObserver?.disconnect()
  resizeObserver = null
  visibilityObserver?.disconnect()
  visibilityObserver = null
  window.removeEventListener('resize', scheduleFit)
  webglAddon?.dispose()
  webglAddon = null
  codexTerminalRenderer?.dispose()
  codexTerminalRenderer = null
  terminal?.dispose()
  terminal = null
  fitAddon = null
  lastKnownHostWidth = 0
  lastKnownHostHeight = 0
  draftHeightFitSuppressedUntil = 0
  bufferedOutputChunks = []
  renderedOutputEndByte = 0
  selectedText.value = ''
}

// 输入框软换行只会改变终端区域高度；这里跳过该路径的 fit，避免 CLI 全屏界面被 resize 后整屏重绘。
function shouldSkipDraftHeightFit(width: number, height: number): boolean {
  if (!showCliConversation.value) return false
  if (Date.now() > draftHeightFitSuppressedUntil) return false
  if (lastKnownHostWidth <= 0 || lastKnownHostHeight <= 0) return false
  const widthChanged = Math.abs(width - lastKnownHostWidth) > 1
  const heightChanged = Math.abs(height - lastKnownHostHeight) > 1
  return !widthChanged && heightChanged
}

function fitAndResize() {
  if (!terminal || !fitAddon || !activeSession.value || !host.value) return
  const width = host.value.offsetWidth
  const height = host.value.offsetHeight
  if (width <= 0 || height <= 0) return
  if (shouldSkipDraftHeightFit(width, height)) {
    lastKnownHostWidth = width
    lastKnownHostHeight = height
    return
  }
  try {
    fitAddon.fit()
    codexTerminalRenderer?.resize(terminal.cols, terminal.rows)
    void store.resizeTerminalSession(activeSession.value.id, terminal.cols, terminal.rows)
    lastKnownHostWidth = width
    lastKnownHostHeight = height
  } catch {
    // xterm can throw while a hidden pane is being resized.
  }
}

function scheduleFit() {
  if (resizeTimer) window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null
    lastFitTime = Date.now()
    fitAndResize()
  }, 80)
}

function terminalScrollback(): number {
  return isCodexTerminal.value ? 10_000 : isCliMode.value ? 5_000 : 1_000
}

function terminalScrollSensitivity(): number {
  return isCodexTerminal.value ? 1.25 : 1
}

function applyTerminalScrollOptions() {
  if (!terminal) return
  terminal.options.scrollback = terminalScrollback()
  terminal.options.scrollSensitivity = terminalScrollSensitivity()
  if (isCodexTerminal.value) {
    codexTerminalRenderer ??= new CodexTerminalRenderer(terminal.cols, terminal.rows)
    codexTerminalRenderer.resize(terminal.cols, terminal.rows)
  } else {
    codexTerminalRenderer?.dispose()
    codexTerminalRenderer = null
  }
}

function ensureTerminal() {
  if (!host.value || terminal) return
  fitAddon = new FitAddon()
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: isCliMode.value ? 14 : 13,
    convertEol: true,
    scrollback: terminalScrollback(),
    scrollOnUserInput: true,
    scrollSensitivity: terminalScrollSensitivity(),
    smoothScrollDuration: 0,
    theme: buildTerminalTheme(currentThemeId.value),
    allowProposedApi: true,
  })
  terminal.loadAddon(fitAddon)
  terminal.open(host.value)
  try {
    webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      webglAddon?.dispose()
      webglAddon = null
    })
    terminal.loadAddon(webglAddon)
  } catch {
    webglAddon = null
  }
  terminal.onData((data) => {
    if (activeSession.value) void store.writeTerminalInput(data, activeSession.value.id)
  })
  terminal.onSelectionChange(() => {
    selectedText.value = terminal?.getSelection() ?? ''
  })
  terminal.attachCustomKeyEventHandler((event) => {
    const key = event.key.toLowerCase()
    const isAccel = event.ctrlKey || event.metaKey
    if (event.type === 'keydown' && key === 'c' && isAccel) {
      const selection = terminal?.getSelection() ?? ''
      if (selection) {
        event.preventDefault()
        void navigator.clipboard?.writeText(selection)
        terminal?.clearSelection()
        selectedText.value = ''
        return false
      }
    }
    if (event.type === 'keydown' && key === 'v' && isAccel) {
      event.preventDefault()
      void pasteIntoTerminalFromClipboard()
      return false
    }
    return true
  })
  resizeObserver = new ResizeObserver(scheduleFit)
  resizeObserver.observe(host.value)
  visibilityObserver = new IntersectionObserver(
    (entries) => {
      const wasHidden = !terminalVisible
      terminalVisible = entries[0]?.isIntersecting ?? true
      if (terminalVisible && wasHidden && bufferedOutputChunks.length) {
        renderBuffer()
      }
    },
    { threshold: 0 },
  )
  visibilityObserver.observe(host.value)
  window.addEventListener('resize', scheduleFit)
  requestAnimationFrame(() => requestAnimationFrame(fitAndResize))
}

function renderBuffer() {
  if (writeInFlight) return
  if (terminalRenderFrame !== null) return
  if (!terminalVisible) return
  terminalRenderFrame = window.requestAnimationFrame(() => {
    terminalRenderFrame = null
    applyBufferedOutput()
  })
}

function applyBufferedOutput() {
  if (!terminal || writeInFlight) return
  if (!bufferedOutputChunks.length) return

  let data = ''
  while (bufferedOutputChunks.length && data.length < terminalWriteCharsPerFrame) {
    const chunk = bufferedOutputChunks[0]
    if (!chunk) {
      bufferedOutputChunks.shift()
      continue
    }
    const remaining = terminalWriteCharsPerFrame - data.length
    if (chunk.length <= remaining) {
      data += chunk
      bufferedOutputChunks.shift()
    } else {
      data += chunk.slice(0, remaining)
      bufferedOutputChunks[0] = chunk.slice(remaining)
      break
    }
  }

  if (!data) return
  const renderedData = codexTerminalRenderer?.render(data) ?? data
  if (!renderedData) {
    if (bufferedOutputChunks.length) renderBuffer()
    return
  }
  writeInFlight = true
  terminal.write(renderedData, () => {
    writeInFlight = false
    if (bufferedOutputChunks.length) renderBuffer()
  })
}

function queueOutput(chunk: string) {
  if (!chunk) return
  if (bufferedOutputChunks.length > 0) {
    const last = bufferedOutputChunks[bufferedOutputChunks.length - 1]
    if (last.length + chunk.length <= terminalWriteCharsPerFrame) {
      bufferedOutputChunks[bufferedOutputChunks.length - 1] = last + chunk
      trimBufferedOutput()
      renderBuffer()
      return
    }
  }
  bufferedOutputChunks.push(chunk)
  trimBufferedOutput()
  renderBuffer()
}

function trimBufferedOutput() {
  let totalBytes = 0
  for (const chunk of bufferedOutputChunks) totalBytes += chunk.length
  while (totalBytes > terminalMaxBufferedBytes && bufferedOutputChunks.length > 1) {
    const removed = bufferedOutputChunks.shift()!
    totalBytes -= removed.length
  }
}

function resetBufferedOutput() {
  if (terminalRenderFrame !== null) {
    window.cancelAnimationFrame(terminalRenderFrame)
    terminalRenderFrame = null
  }
  bufferedOutputChunks = []
  writeInFlight = false
  codexTerminalRenderer?.reset()
}

function clearTerminalPrimeRetryTimers() {
  for (const timer of terminalPrimeRetryTimers) {
    window.clearTimeout(timer)
  }
  terminalPrimeRetryTimers = []
}

function scheduleInitialBufferRetries(sessionId: string) {
  clearTerminalPrimeRetryTimers()
  for (const delay of [300, 1200]) {
    const timer = window.setTimeout(() => {
      terminalPrimeRetryTimers = terminalPrimeRetryTimers.filter((item) => item !== timer)
      if (sessionId !== activeSessionIdSnapshot) return
      if (terminalBufferFailedSessionIds.has(sessionId)) return
      if (renderedOutputEndByte > 0) return
      if (bufferRefreshInFlightForSession === sessionId) return
      void primeTerminalBuffer(sessionId)
    }, delay)
    terminalPrimeRetryTimers.push(timer)
  }
}

function sliceUtf8FromByte(value: string, startByte: number) {
  if (startByte <= 0) return value
  const bytes = utf8Encoder.encode(value)
  if (startByte >= bytes.length) return ''
  let offset = startByte
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) {
    offset += 1
  }
  return utf8Decoder.decode(bytes.subarray(offset))
}

function applyTerminalOutputEvent(event: TerminalOutputPayload) {
  if (event.sessionId !== activeSessionIdSnapshot) return
  if (event.endByte <= renderedOutputEndByte) return
  if (event.startByte > renderedOutputEndByte) {
    deferredOutputEvents.push(event)
    void primeTerminalBuffer(event.sessionId)
    return
  }

  const chunk = event.startByte < renderedOutputEndByte
    ? sliceUtf8FromByte(event.chunk, renderedOutputEndByte - event.startByte)
    : event.chunk
  renderedOutputEndByte = event.endByte
  terminalBufferFailedSessionIds.delete(event.sessionId)
  queueOutput(chunk)
}

function queueTerminalOutput(event: TerminalOutputPayload) {
  if (event.sessionId !== activeSessionIdSnapshot) return
  if (bufferRefreshInFlightForSession === event.sessionId) {
    deferredOutputEvents.push(event)
    return
  }
  applyTerminalOutputEvent(event)
}

async function bindOutputListener() {
  void outputListenerCleanup?.()
  outputListenerCleanup = null
  const targetSessionId = activeSessionIdSnapshot
  if (!targetSessionId) return
  outputListenerCleanup = await onTerminalOutput((event) => {
    if (event.sessionId !== targetSessionId) return
    queueTerminalOutput(event)
  })
}

async function syncActiveTerminalSession() {
  const activationToken = ++terminalActivationToken
  resetBufferedOutput()
  const session = activeSession.value
  renderedOutputEndByte = 0
  selectedText.value = ''
  bufferRefreshInFlightForSession = null
  deferredOutputEvents = []
  clearTerminalPrimeRetryTimers()

  if (!session) {
    await nextTick()
    if (!terminalPaneMounted || activationToken !== terminalActivationToken) return
    disposeTerminal()
    return
  }

  activeSessionIdSnapshot = session.id
  if (!terminal) {
    await nextTick()
    if (!terminalPaneMounted || activationToken !== terminalActivationToken) return
  }

  try {
    ensureTerminal()
    applyTerminalScrollOptions()
    await bindOutputListener()
  } catch (error) {
    store.showErrorMessage(`终端渲染初始化失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!terminalPaneMounted || activationToken !== terminalActivationToken) return
  void primeTerminalBuffer(session.id)
  scheduleInitialBufferRetries(session.id)
  fitAndResize()
  syncDraftHeight()
}

async function primeTerminalBuffer(sessionId: string) {
  if (bufferRefreshInFlightForSession === sessionId) return
  bufferRefreshInFlightForSession = sessionId
  let refreshed = false
  try {
    const snapshot = await backend.getTerminalBuffer(sessionId)
    if (sessionId !== activeSessionIdSnapshot) return
    terminal?.reset()
    resetBufferedOutput()
    renderedOutputEndByte = snapshot.endByte
    bufferedOutputChunks = snapshot.buffer ? [snapshot.buffer] : []
    renderBuffer()
    refreshed = true
    terminalBufferFailedSessionIds.delete(sessionId)
  } catch {
    if (sessionId === activeSessionIdSnapshot) {
      terminalBufferFailedSessionIds.add(sessionId)
      resetBufferedOutput()
      renderedOutputEndByte = 0
      queueOutput('\r\n[Super High] 这个终端会话已经失效。请关闭这个标签后新建会话。\r\n')
    }
  } finally {
    if (bufferRefreshInFlightForSession === sessionId) {
      bufferRefreshInFlightForSession = null
    }
    if (!refreshed || sessionId !== activeSessionIdSnapshot) {
      deferredOutputEvents = deferredOutputEvents.filter((event) => event.sessionId !== sessionId)
      return
    }
    const deferredEvents = deferredOutputEvents.filter((event) => event.sessionId === sessionId)
    deferredOutputEvents = deferredOutputEvents.filter((event) => event.sessionId !== sessionId)
    for (const event of deferredEvents) {
      applyTerminalOutputEvent(event)
    }
  }
}

async function sendDraft() {
  if (!activeSession.value || isEnded.value || isPastingImage.value) return
  const sessionId = activeSession.value.id
  const draft = activeDraft.value
  const attachments = imageAttachmentsBySession.value[sessionId] ?? []
  const message = buildCliMessageWithImages(draft, attachments.map((item) => item.path))
  if (!message.trim()) return
  await store.sendTerminalConversationMessage(sessionId, message)
  imageAttachmentsBySession.value = {
    ...imageAttachmentsBySession.value,
    [sessionId]: [],
  }
  syncDraftHeight(draftInput.value, true)
  requestAnimationFrame(() => terminal?.focus())
}

function onDraftKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void sendDraft()
}

function onDraftInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  activeDraft.value = target.value
  syncDraftHeight(target, true)
}

function resolvePasteProjectPath(): string | null {
  const workspaceRoot = store.workspace?.rootPath?.trim()
  if (workspaceRoot) return workspaceRoot
  const sessionCwd = activeSession.value?.cwd?.trim()
  if (sessionCwd) return sessionCwd
  const propCwd = props.cwd?.trim()
  if (propCwd) return propCwd
  return null
}

function setSessionAttachments(sessionId: string, attachments: CliImageAttachment[]) {
  imageAttachmentsBySession.value = {
    ...imageAttachmentsBySession.value,
    [sessionId]: attachments,
  }
}

function removeImageAttachment(attachmentId: string) {
  const sessionId = activeSession.value?.id
  if (!sessionId) return
  const next = (imageAttachmentsBySession.value[sessionId] ?? []).filter((item) => item.id !== attachmentId)
  setSessionAttachments(sessionId, next)
}

async function attachPastedImages(candidates: PastedImageCandidate[]): Promise<number> {
  if (!activeSession.value || isEnded.value || !candidates.length) return 0
  const projectPath = resolvePasteProjectPath()
  if (!projectPath) {
    store.showErrorMessage('无法保存粘贴图片：当前没有可用项目路径。')
    return 0
  }
  if (isPastingImage.value) return 0
  isPastingImage.value = true
  const sessionId = activeSession.value.id
  const attachments: CliImageAttachment[] = []
  const errors: string[] = []
  try {
    for (const candidate of candidates) {
      try {
        const savedPath = await backend.savePastedImage(
          projectPath,
          candidate.dataUrl,
          candidate.preferredName,
        )
        attachments.push({
          id: crypto.randomUUID(),
          path: savedPath,
          previewUrl: candidate.previewUrl,
          fileName: fileNameFromPath(savedPath),
        })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (attachments.length) {
      const existing = imageAttachmentsBySession.value[sessionId] ?? []
      setSessionAttachments(sessionId, [...existing, ...attachments])
      store.showActivityMessage(
        attachments.length === 1
          ? `已附加图片：${attachments[0].fileName}`
          : `已附加 ${attachments.length} 张图片`,
      )
      await focusDraftInput()
    }
    if (errors.length) store.showErrorMessage(`有 ${errors.length} 张图片粘贴失败：${errors[0]}`)
    return attachments.length
  } finally {
    isPastingImage.value = false
  }
}

async function onDraftPaste(event: ClipboardEvent) {
  if (!isCliMode.value || !activeSession.value || isEnded.value) return
  if (!clipboardEventHasImages(event)) return
  // Must cancel before any await, otherwise the browser may swallow the image paste.
  event.preventDefault()
  const candidates = await extractPastedImagesFromClipboardEvent(event)
  await attachPastedImages(candidates)
}

async function pasteIntoTerminalFromClipboard() {
  if (!activeSession.value) return
  if (isCliMode.value && showCliConversation.value) {
    const images = await extractPastedImagesFromClipboardApi()
    if (images.length) {
      await attachPastedImages(images)
      return
    }
  }
  try {
    const text = await navigator.clipboard?.readText()
    if (text) await store.writeTerminalInput(text, activeSession.value.id)
  } catch {
    // ignore clipboard permission failures
  }
}

function insertQuickPhrase(text: string) {
  if (!activeSession.value || isEnded.value) return
  const cleanText = text.trim()
  if (!cleanText) return
  activeDraft.value = activeDraft.value.trim()
    ? `${activeDraft.value.trimEnd()}\n\n${cleanText}`
    : cleanText
  void nextTick(() => {
    syncDraftHeight(draftInput.value, true)
    draftInput.value?.focus()
  })
}

function fillQuickPhraseFromDraft() {
  phraseText.value = activeDraft.value
}

async function saveQuickPhrase() {
  if (!canSaveQuickPhrase.value) return
  isSavingPhrase.value = true
  try {
    await store.addQuickPhrase(phraseTitle.value, phraseText.value)
    phraseTitle.value = ''
    phraseText.value = ''
  } catch (error) {
    store.showErrorMessage(`快捷短语保存失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    isSavingPhrase.value = false
  }
}

async function deleteQuickPhrase(id: string) {
  if (isSavingPhrase.value) return
  try {
    await store.deleteQuickPhrase(id)
  } catch (error) {
    store.showErrorMessage(`快捷短语删除失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function canUseLeftAltVoiceShortcut(): boolean {
  return isCliMode.value
    && !!activeSession.value
    && !isEnded.value
    && voiceInputAvailable.value
    && voiceInputState.value !== 'starting'
}

function onWindowKeydown(event: KeyboardEvent) {
  if (!isCliMode.value) return
  leftAltVoiceShortcut.keydown(event)
}

function onWindowKeyup(event: KeyboardEvent) {
  if (!isCliMode.value) return
  const shouldToggleVoice = leftAltVoiceShortcut.keyup(event)
  if (!shouldToggleVoice || !canUseLeftAltVoiceShortcut()) return
  event.preventDefault()
  event.stopPropagation()
  void toggleVoiceInput()
}

function onWindowBlur() {
  leftAltVoiceShortcut.reset()
}

function addSelectionToChat() {
  const text = selectedText.value.trim()
  if (!text) return
  const source = isCliMode.value ? 'CLI 渲染选中内容' : '本地终端选中内容'
  window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', {
    detail: { source, text },
  }))
  terminal?.focus()
}

function focusTerminal() {
  terminal?.focus()
}

function handleExternalInsert(event: Event) {
  if (!isCliMode.value || !activeSession.value) return
  const detail = (event as CustomEvent<{ insertMode?: 'plain'; source?: string; text?: string }>).detail
  const text = detail?.text?.trim()
  if (!text) return
  if (detail.insertMode === 'plain') {
    store.insertIntoTerminalDraft(activeSession.value.id, text)
    void nextTick(() => syncDraftHeight(draftInput.value, true))
    return
  }
  const source = detail.source || '外部选中内容'
  store.insertIntoTerminalDraft(activeSession.value.id, `${source}:\n\`\`\`\n${text}\n\`\`\``)
  void nextTick(() => syncDraftHeight(draftInput.value, true))
}

// 同步草稿输入框高度；用户输入导致的高度变化会短暂屏蔽终端 fit，避免触发后端 PTY resize。
function syncDraftHeight(target = draftInput.value, suppressTerminalFit = false) {
  if (!target) return
  const previousHeight = Number.parseFloat(target.style.height) || target.offsetHeight || target.clientHeight || 0
  target.style.height = 'auto'
  const nextHeight = Math.min(Math.max(target.scrollHeight, 28), 120)
  target.style.height = `${nextHeight}px`
  if (suppressTerminalFit && Math.abs(nextHeight - previousHeight) > 1) {
    draftHeightFitSuppressedUntil = Date.now() + draftHeightFitSuppressionMs
  }
}

async function focusDraftInput() {
  await nextTick()
  draftInput.value?.focus()
}

onMounted(async () => {
  terminalPaneMounted = true
  if (!isCliMode.value && store.workspace?.rootPath) void store.refreshProjectStartupConfig()
  await nextTick()
  await syncActiveTerminalSession()
  window.addEventListener('superhigh:add-selection-to-chat', handleExternalInsert)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('keyup', onWindowKeyup)
  window.addEventListener('blur', onWindowBlur)
})

watch(() => store.workspace?.rootPath, (rootPath) => {
  if (!isCliMode.value && rootPath) void store.refreshProjectStartupConfig()
})

watch(() => activeSession.value?.id ?? null, () => {
  if (!terminalPaneMounted) return
  phrasePanelOpen.value = false
  phraseTitle.value = ''
  void syncActiveTerminalSession()
})

watch(() => sessions.value.length, () => {
  if (!terminalPaneMounted) return
  if (!activeSession.value) return
  if (activeSession.value.id === activeSessionIdSnapshot && terminal) return
  void syncActiveTerminalSession()
})

watch(currentThemeId, () => {
  if (!terminal) return
  terminal.options.theme = buildTerminalTheme(currentThemeId.value)
})

watch(() => activeDraft.value, () => {
  void nextTick(() => syncDraftHeight())
})

onBeforeUnmount(() => {
  terminalPaneMounted = false
  terminalActivationToken += 1
  window.removeEventListener('resize', scheduleFit)
  window.removeEventListener('superhigh:add-selection-to-chat', handleExternalInsert)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keyup', onWindowKeyup)
  window.removeEventListener('blur', onWindowBlur)
  leftAltVoiceShortcut.reset()
  disposeTerminal()
})

// ---- Plan 表单 ----
const planDecisionIndex = ref(0)
const pendingPlan = computed(() => {
  if (!activeSession.value) return null
  const plans = store.cliPlans[activeSession.value.id] ?? []
  // 只取第一个未解决（未 resolved）的 Plan，一次显示一个
  return plans.find((item) => !item.resolvedAt) ?? null
})
const planCurrentDecision = computed(() => {
  if (!pendingPlan.value) return null
  return pendingPlan.value.decisions[planDecisionIndex.value] ?? null
})
const planAllDecided = computed(() => {
  if (!pendingPlan.value) return false
  return pendingPlan.value.decisions.every((item) => item.choice !== 'pending')
})
const planTotal = computed(() => pendingPlan.value?.decisions.length ?? 0)
const planHeaderTitle = computed(() => {
  if (!planCurrentDecision.value) return '决策'
  const current = planDecisionIndex.value + 1
  return planTotal.value > 1 ? `决策${current} / 决策${planTotal.value}` : `决策${current}`
})
const planChoiceOptions = [
  { value: 'yes', label: '是' },
  { value: 'no', label: '否' },
  { value: 'skip', label: '跳过' },
] as const

function planChoiceText(choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>): string {
  const decision = planCurrentDecision.value
  if (!decision) return ''
  if (choice === 'yes') return decision.yesText || '采纳这个决策'
  if (choice === 'no') return decision.noText || '不采纳这个决策'
  return '暂不处理这个决策'
}

function planChoiceNote(choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>): string {
  return planCurrentDecision.value?.choiceNotes?.[choice] ?? ''
}

function planRecommendedChoiceLabel(choice?: PlanProposal['decisions'][number]['recommendedChoice'] | null): string {
  if (choice === 'yes') return '推荐选：是'
  if (choice === 'no') return '推荐选：否'
  if (choice === 'skip') return '推荐选：跳过'
  return '推荐选：未明确'
}

function planRecommendationDiagram(decision: PlanProposal['decisions'][number]): string {
  const recommended = decision.recommendedChoice
  const rows = [
    ['是', recommended === 'yes' ? '推荐' : '可选', compactPlanText(decision.yesText || '采纳')],
    ['否', recommended === 'no' ? '推荐' : '可选', compactPlanText(decision.noText || '不采纳')],
    ['跳过', recommended === 'skip' ? '推荐' : '可选', '暂不处理'],
  ]
  const width = Math.max(...rows.map((row) => row[2].length), 8)
  const line = `+------+--------+${'-'.repeat(width + 2)}+`
  return [
    line,
    `| 选项 | 状态   | ${'含义'.padEnd(width)} |`,
    line,
    ...rows.map(([choice, state, text]) => `| ${choice.padEnd(4)} | ${state.padEnd(6)} | ${text.padEnd(width)} |`),
    line,
  ].join('\n')
}

function compactPlanText(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 28 ? `${text.slice(0, 27)}...` : text
}

function setPlanChoice(choice: PlanProposal['decisions'][number]['choice']) {
  const plan = pendingPlan.value
  if (!plan || !activeSession.value) return
  store.setPlanDecisionChoice(activeSession.value.id, plan.id, plan.decisions[planDecisionIndex.value].key, choice)
}
function setPlanChoiceNote(choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>, event: Event) {
  const plan = pendingPlan.value
  const decision = planCurrentDecision.value
  if (!plan || !decision || !activeSession.value) return
  const value = (event.target as HTMLTextAreaElement).value
  store.setPlanDecisionChoiceNote(activeSession.value.id, plan.id, decision.key, choice, value)
}
function planNextDecision() {
  if (planDecisionIndex.value + 1 < planTotal.value) planDecisionIndex.value += 1
}
function planPrevDecision() {
  if (planDecisionIndex.value > 0) planDecisionIndex.value -= 1
}
function submitPlan() {
  if (!pendingPlan.value || !activeSession.value) return
  void store.submitPlanProposal(activeSession.value.id, pendingPlan.value.id)
  planDecisionIndex.value = 0
}
</script>

<template>
  <section
    class="panel terminal-panel"
    :class="{
      'cli-terminal-panel': isCliMode,
      'local-terminal-panel': !isCliMode,
      'team-terminal-panel': compactTeam,
    }"
  >
    <div class="terminal-tabs-bar">
      <div class="terminal-session-tabs">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="terminal-tab"
          :class="{ active: activeSession?.id === session.id }"
          :title="session.cwd"
        >
          <button
            type="button"
            class="terminal-tab-main"
            @click="setActiveSession(session.id)"
          >
            <span class="terminal-tab-name">{{ activeSessionTitle(session) }}</span>
            <span v-if="terminalSessionState(session)" class="terminal-tab-state">
              {{ terminalSessionState(session) }}
            </span>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            title="关闭会话"
            :disabled="closingSessionIds[session.id]"
            @click.stop="closeSession(session.id)"
          >
            <Trash2 :size="12" />
          </button>
        </div>
      </div>
      <div v-if="!compactTeam" class="terminal-actions">
        <template v-if="isCliMode">
          <button
            v-for="provider in CLI_PROVIDER_OPTIONS"
            :key="provider.id"
            class="ghost-button"
            :title="`左键在 SuperHigh 内启动 ${provider.name}；右键在外部 CMD 启动`"
            @click="createProviderSession(provider.id)"
            @contextmenu.prevent.stop="openExternalProviderSession(provider.id)"
          >
            <TerminalSquare v-if="provider.icon === 'terminal'" :size="13" />
            <Cpu v-else :size="13" />
            <span>{{ provider.shortName }}</span>
          </button>
        </template>
        <template v-else>
          <template v-if="hasProjectTerminalActions">
            <button
              v-for="action in projectTerminalActions"
              :key="action.id"
              class="ghost-button"
              :disabled="store.projectTerminalActionBusy[action.id]"
              :title="action.tooltip || action.label"
              @click="runProjectTerminalAction(action)"
            >
              <RotateCcw v-if="terminalActionIcon(action) === 'restart'" :size="13" />
              <Play v-else :size="13" />
              <span>{{ store.projectTerminalActionBusy[action.id] ? '执行中' : action.label }}</span>
            </button>
            <button
              v-if="store.projectServiceRun"
              class="ghost-button"
              title="关闭本轮由 SuperHigh 启动的服务终端；外部运行的服务不会被关闭"
              @click="store.closeProjectServiceSessions()"
            >
              <Square :size="13" />
              <span>关闭托管终端</span>
            </button>
          </template>
          <template v-else-if="isServiceStartupConfig">
            <button
              class="ghost-button"
              :disabled="store.projectServicesStarting || projectServiceChainActive"
              :title="`启动 ${projectStartupName}`"
              @click="startProjectServices"
            >
              <Play :size="13" />
              <span>{{ store.projectServicesStarting ? '启动中' : '启动服务链' }}</span>
            </button>
            <button
              v-if="store.projectServiceRun"
              class="ghost-button"
              title="关闭本轮由 SuperHigh 启动的服务终端；外部运行的服务不会被关闭"
              @click="store.closeProjectServiceSessions()"
            >
              <Square :size="13" />
              <span>关闭托管终端</span>
            </button>
            <div
              v-if="projectServiceSummary"
              class="project-service-summary"
              title="这些服务没有可在此切换的 SuperHigh 控制台"
            >
              <span>服务链：</span>
              <span>{{ projectServiceSummary }}</span>
            </div>
          </template>
          <button
            v-if="isSingleStartupConfig"
            class="ghost-button"
            :disabled="startingProjectStartup"
            :title="projectStartupSession ? '关闭 SuperHigh 内的服务端进程；平滑关服请先在终端输入 stop' : `在 SuperHigh 终端启动 ${projectStartupName}`"
            @click="toggleProjectStartup"
          >
            <Square v-if="projectStartupSession" :size="13" />
            <Play v-else :size="13" />
            <span>{{ projectStartupSession ? '关闭服务端' : '启动服务端' }}</span>
          </button>
        </template>
      </div>
    </div>

    <div v-if="activeSession" class="terminal-body" :class="{ 'with-cli-input': showCliConversation }">
      <div class="cli-render-region" @click="focusTerminal">
        <div ref="host" class="terminal-host" :class="{ 'codex-terminal-host': isCodexTerminal }" />
        <button
          v-if="selectedText.trim()"
          type="button"
          class="add-selection-button"
          @click="addSelectionToChat"
        >
          <MessageSquarePlus :size="13" />
          <span>添加到对话框</span>
        </button>
      </div>

      <div
        v-if="showCliConversation"
        class="cli-conversation-region"
      >
        <!-- Plan 表单：CLI Agent 输出 Plan 标记块后在此内联渲染 -->
        <div v-if="pendingPlan" class="plan-form">
          <div class="plan-form-header">
            <span class="plan-form-title">{{ planHeaderTitle }}</span>
            <div class="plan-header-actions">
              <button v-if="planTotal > 1" class="ghost-button" :disabled="planDecisionIndex === 0" @click="planPrevDecision">上一个</button>
              <button v-if="planTotal > 1" class="ghost-button" :disabled="planDecisionIndex + 1 >= planTotal" @click="planNextDecision">下一个</button>
              <button
                class="primary-button"
                :disabled="!planAllDecided"
                title="所有决策处理完毕后直接写入 CLI 会话，不经过输入框"
                @click="submitPlan"
              >发送回执</button>
            </div>
          </div>
          <div v-if="planCurrentDecision" class="plan-decision">
            <div class="plan-decision-main">
              <div class="plan-decision-question">{{ planCurrentDecision.question }}</div>
              <div class="plan-recommendation-line">
                <span class="plan-recommendation-choice">
                  {{ planRecommendedChoiceLabel(planCurrentDecision.recommendedChoice) }}
                </span>
                <span v-if="planCurrentDecision.recommendation" class="plan-recommendation">
                  {{ planCurrentDecision.recommendation }}
                </span>
              </div>
              <div class="plan-decision-choices">
                <div
                  v-for="option in planChoiceOptions"
                  :key="option.value"
                  class="plan-choice-row"
                  :class="{
                    active: planCurrentDecision.choice === option.value,
                    recommended: planCurrentDecision.recommendedChoice === option.value,
                    [option.value]: true,
                  }"
                >
                  <button
                    class="plan-choice"
                    :class="option.value"
                    @click="setPlanChoice(option.value)"
                  >{{ option.label }}</button>
                  <div class="plan-choice-text">{{ planChoiceText(option.value) }}</div>
                  <textarea
                    class="plan-choice-note"
                    rows="1"
                    :value="planChoiceNote(option.value)"
                    :placeholder="`${option.label} 的补充`"
                    @focus="setPlanChoice(option.value)"
                    @input="setPlanChoiceNote(option.value, $event)"
                  />
                </div>
              </div>
              <div v-if="planCurrentDecision.choice !== 'pending'" class="plan-choice-result">
                {{ planCurrentDecision.choice === 'yes' ? '已选：是' : planCurrentDecision.choice === 'no' ? '已选：否' : '已选：跳过' }}
                <span
                  v-if="planCurrentDecision.choiceNotes?.[planCurrentDecision.choice]"
                  class="plan-recommendation"
                > — {{ planCurrentDecision.choiceNotes[planCurrentDecision.choice] }}</span>
              </div>
            </div>
            <div class="plan-ascii-panel">
              <pre>{{ planRecommendationDiagram(planCurrentDecision) }}</pre>
            </div>
          </div>
        </div>

        <div v-if="phrasePanelOpen" class="cli-phrase-panel" aria-label="快捷短语">
          <div class="cli-phrase-save">
            <input
              v-model="phraseTitle"
              class="cli-phrase-title-input"
              placeholder="标题（可选）"
              :disabled="isEnded || isSavingPhrase"
              data-testid="terminal-quick-phrase-title"
            />
            <button
              type="button"
              class="cli-phrase-fill-button"
              :disabled="isEnded || !activeDraft.trim() || isSavingPhrase"
              data-testid="terminal-quick-phrase-fill-draft"
              @click="fillQuickPhraseFromDraft"
            >
              使用当前输入
            </button>
          </div>
          <textarea
            v-model="phraseText"
            class="cli-phrase-text-input"
            rows="3"
            placeholder="短语内容"
            :disabled="isEnded || isSavingPhrase"
            data-testid="terminal-quick-phrase-text"
          />
          <div class="cli-phrase-save-actions">
            <button
              type="button"
              class="cli-phrase-save-button"
              title="保存快捷短语"
              :disabled="!canSaveQuickPhrase"
              data-testid="terminal-save-quick-phrase"
              @click="saveQuickPhrase"
            >
              <Save :size="13" />
              <span>{{ isSavingPhrase ? '保存中...' : '保存' }}</span>
            </button>
          </div>
          <div v-if="quickPhrases.length" class="cli-phrase-list">
            <div v-for="phrase in quickPhrases" :key="phrase.id" class="cli-phrase-row">
              <button
                type="button"
                class="cli-phrase-main"
                :title="phrase.text"
                :disabled="isEnded"
                data-testid="terminal-quick-phrase-insert"
                @click="insertQuickPhrase(phrase.text)"
              >
                <span>{{ phrase.title }}</span>
                <small>{{ phrase.text }}</small>
              </button>
              <button
                type="button"
                class="cli-phrase-delete"
                title="删除快捷短语"
                :disabled="isSavingPhrase"
                data-testid="terminal-quick-phrase-delete"
                @click="deleteQuickPhrase(phrase.id)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
        </div>

        <div class="cli-input-shell">
          <div class="cli-input-stack">
            <div v-if="activeImageAttachments.length" class="cli-image-attachments" data-testid="terminal-image-attachments">
              <div
                v-for="attachment in activeImageAttachments"
                :key="attachment.id"
                class="cli-image-chip"
                :title="attachment.path"
              >
                <img :src="attachment.previewUrl" :alt="attachment.fileName" class="cli-image-thumb" />
                <span>{{ attachment.fileName }}</span>
                <button
                  type="button"
                  class="cli-image-remove"
                  title="移除图片"
                  @click="removeImageAttachment(attachment.id)"
                >
                  <X :size="12" />
                </button>
              </div>
            </div>
            <textarea
              ref="draftInput"
              :value="activeDraft"
              class="cli-message-input"
              :placeholder="isEnded ? '会话已结束' : (activeImageAttachments.length ? '可继续输入说明，Enter 发送图片与文字' : '输入消息，Enter 发送，Shift+Enter 换行；可粘贴图片')"
              rows="1"
              :disabled="isEnded || isPastingImage"
              @input="onDraftInput"
              @keydown="onDraftKeydown"
              @paste="onDraftPaste"
            />
            <div v-if="voiceStatusMessage" class="cli-voice-status">{{ voiceStatusMessage }}</div>
            <div v-if="isPastingImage" class="cli-voice-status">正在保存粘贴图片…</div>
          </div>
          <button
            type="button"
            class="conversation-voice-button cli-phrase-toggle"
            :class="{ active: phrasePanelOpen }"
            :disabled="isEnded"
            title="快捷短语"
            data-testid="terminal-quick-phrase-toggle"
            @click="phrasePanelOpen = !phrasePanelOpen"
          >
            <MessageSquarePlus :size="14" />
          </button>
          <button
            type="button"
            class="conversation-voice-button cli-voice-button"
            :class="{ listening: isVoiceListening }"
            :disabled="isEnded || !voiceInputAvailable || voiceInputState === 'starting'"
            :title="voiceButtonTitle"
            @click="toggleVoiceInput"
          >
            <MicOff v-if="isVoiceListening" :size="14" />
            <Mic v-else :size="14" />
          </button>
          <button class="primary-button small" :disabled="!canSendDraft" @click="sendDraft">
            <Send :size="13" />
            <span>发送</span>
          </button>
        </div>
      </div>
    </div>

    <div v-else class="terminal-empty-state">
      <div class="terminal-empty-card">
        <div class="panel-title">{{ isCliMode ? '暂无 CLI 会话' : '暂无本地终端' }}</div>
        <p>
          {{ isCliMode ? '创建 Claude Code 或 Codex 会话后，上方显示原始 CLI 渲染，下方保留对话输入区。' : '启动服务链后，可在此查看并输入各服务端控制台命令。' }}
        </p>
        <div class="terminal-empty-actions">
          <template v-if="isCliMode">
            <button
              v-for="provider in CLI_PROVIDER_OPTIONS"
              :key="provider.id"
              class="ghost-button"
              :title="`左键在 SuperHigh 内启动 ${provider.name}；右键在外部 CMD 启动`"
              @click="createProviderSession(provider.id)"
              @contextmenu.prevent.stop="openExternalProviderSession(provider.id)"
            >
              <TerminalSquare v-if="provider.icon === 'terminal'" :size="13" />
              <Cpu v-else :size="13" />
              <span>{{ provider.shortName }}</span>
            </button>
          </template>
          <template v-else>
            <template v-if="hasProjectTerminalActions">
              <button
                v-for="action in projectTerminalActions"
                :key="action.id"
                class="ghost-button"
                :disabled="store.projectTerminalActionBusy[action.id]"
                :title="action.tooltip || action.label"
                @click="runProjectTerminalAction(action)"
              >
                <RotateCcw v-if="terminalActionIcon(action) === 'restart'" :size="13" />
                <Play v-else :size="13" />
                <span>{{ store.projectTerminalActionBusy[action.id] ? '执行中' : action.label }}</span>
              </button>
              <button
                v-if="store.projectServiceRun"
                class="ghost-button"
                title="关闭本轮由 SuperHigh 启动的服务终端；外部运行的服务不会被关闭"
                @click="store.closeProjectServiceSessions()"
              >
                <Square :size="13" />
                <span>关闭托管终端</span>
              </button>
            </template>
            <template v-else-if="isServiceStartupConfig">
              <button
                class="ghost-button"
                :disabled="store.projectServicesStarting || projectServiceChainActive"
                :title="`启动 ${projectStartupName}`"
                @click="startProjectServices"
              >
                <Play :size="13" />
                <span>{{ store.projectServicesStarting ? '启动中' : '启动服务链' }}</span>
              </button>
              <button
                v-if="store.projectServiceRun"
                class="ghost-button"
                title="关闭本轮由 SuperHigh 启动的服务终端；外部运行的服务不会被关闭"
                @click="store.closeProjectServiceSessions()"
              >
                <Square :size="13" />
                <span>关闭托管终端</span>
              </button>
              <div
                v-if="projectServiceSummary"
                class="project-service-summary"
                title="这些服务没有可在此切换的 SuperHigh 控制台"
              >
                <span>服务链：</span>
                <span>{{ projectServiceSummary }}</span>
              </div>
            </template>
            <button
              v-if="isSingleStartupConfig"
              class="ghost-button"
              :disabled="startingProjectStartup"
              :title="projectStartupSession ? '关闭 SuperHigh 内的服务端进程；平滑关服请先在终端输入 stop' : `在 SuperHigh 终端启动 ${projectStartupName}`"
              @click="toggleProjectStartup"
            >
              <Square v-if="projectStartupSession" :size="13" />
              <Play v-else :size="13" />
              <span>{{ projectStartupSession ? '关闭服务端' : '启动服务端' }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
