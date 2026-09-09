<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Cpu, LoaderCircle, MessageSquarePlus, Mic, MicOff, Play, Plus, Save, Send, Sparkles, Square, TerminalSquare, Trash2, X } from 'lucide-vue-next'

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
import { collectCliHistoryMessages, mergeHistoryMessages } from '@/lib/historyTabCompletion'
import { useHistoryTabCompletion } from '@/lib/useHistoryTabCompletion'
import { promptHistoryCache } from '@/lib/promptHistoryCache'
import HistoryCompletionPopup from '@/components/HistoryCompletionPopup.vue'
import SkillCompletionPopup from '@/components/SkillCompletionPopup.vue'
import { formatSkillMessage, matchSkillCandidates, skillInvocationFromCandidate, skillQueryFromDraft, type SkillInvocationState } from '@/lib/skillsCompletion'
import { backend, isTauri, onTerminalOutput, type TerminalOutputPayload } from '@/lib/tauri'
import { CLI_PROVIDER_OPTIONS, cliProviderLabel } from '@/lib/cliProviders'
import { CodexTerminalRenderer } from '@/lib/codexTerminalRenderer'
import { registerTerminalFileLinks } from '@/lib/terminalFileLinks'
import { createLeftAltVoiceShortcutTracker } from '@/lib/leftAltVoiceShortcut'
import { appendVoiceText, useVoiceInput } from '@/lib/voiceInput'
import { useWorkspaceStore } from '@/stores/workspace'
import type { CliConversationMessage, PlanProposal, ProjectTerminalAction, SkillCompletionItem, TerminalProviderKind, TerminalSession } from '@/types'

const props = withDefaults(defineProps<{
  mode?: 'cli' | 'local'
  scope?: 'project' | 'dragon'
  cwd?: string
  initialPrompt?: string
  sessionIds?: string[]
  activeSessionId?: string | null
  compactTeam?: boolean
}>(), {
  mode: 'cli',
  scope: 'project',
  cwd: '',
  initialPrompt: '',
  sessionIds: () => [],
  activeSessionId: null,
  compactTeam: false,
})

const store = useWorkspaceStore()
const visibleProviders = computed(() => CLI_PROVIDER_OPTIONS.filter((provider) => store.isCliProviderVisible(provider.id)))
// Keep the completion implementation in place for a later re-enable, but do not
// let it affect the current conversation input.
const cliInputTabCompletionEnabled = false
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
const isOpeningExternalConversation = ref(false)
const availableSkills = ref<SkillCompletionItem[]>([])
const skillSelectedIndex = ref(0)
const skillPopupOpen = ref(false)
const skillLoading = ref(false)
const promptHistoryOpen = ref(false)
const promptHistorySearch = ref('')
const promptHistoryEntries = ref<CliConversationMessage[]>([])
const promptHistoryStatus = ref('')
const promptHistorySelectedIndex = ref(0)
let promptHistoryLoadToken = 0
const promptCommand: SkillCompletionItem = { name: 'prompt', description: '搜索并复用当前工作区的提示词', scope: 'project', path: 'superhigh:prompt' }
const filteredPromptHistory = computed(() => {
  const query = promptHistorySearch.value.trim().toLocaleLowerCase()
  return promptHistoryEntries.value.filter((entry) => !query || entry.content.toLocaleLowerCase().includes(query))
})
const promptHistoryWorkspacePath = computed(() => store.workspace?.rootPath?.trim() || activeSession.value?.cwd?.trim() || props.cwd?.trim())
const skillInvocationBySession = ref<Record<string, SkillInvocationState | null>>({})
const promptEnhancementSessionId = ref<string | null>(null)
const promptEnhancementUndoBySession = ref<Record<string, string | undefined>>({})
const promptEnhancementStatusBySession = ref<Record<string, string | undefined>>({})
const promptEnhancementElapsedMs = ref(0)
let promptEnhancementStartedAt: number | null = null
let promptEnhancementTimer: number | null = null
let skillLoadToken = 0
const currentThemeId = computed(() => store.currentThemeId)
const isCliMode = computed(() => props.mode === 'cli')
const isDragonScope = computed(() => isCliMode.value && props.scope === 'dragon')
const isCodexTerminal = computed(() => isCliMode.value && activeSession.value?.providerKind === 'codex')
// dsh-tui 是整帧差分绘制的全屏 TUI：用 WebGL 渲染器在高速整帧重绘下容易出
// 撕裂/重叠伪影，DOM/canvas 渲染器对同步帧更稳（参考 codex-rs TUI 的整帧 flush 思路）。
const isDshTerminal = computed(() => isCliMode.value && activeSession.value?.providerKind === 'dsh')
const isFrameRenderedTerminal = computed(() => (
  isCliMode.value
  && (activeSession.value?.providerKind === 'codex' || activeSession.value?.providerKind === 'dsh')
))
const showCliConversation = computed(() => isCliMode.value && !props.compactTeam)
const sessions = computed(() => {
  const raw = !isCliMode.value
    ? store.localTerminalSessions
    : isDragonScope.value
      ? store.dragonCliTerminalSessions
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
  const active = isDragonScope.value ? store.activeDragonCliTerminalSession : store.activeCliTerminalSession
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
const visibleProjectTerminalActions = computed(() => projectTerminalActions.value.filter((action) => (
  action.kind === 'start-project'
  || (action.kind === 'minecraft-client' && (action.operation ?? 'start') === 'start')
)))
const hasProjectTerminalActions = computed(() => visibleProjectTerminalActions.value.length > 0)
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
const activeSkillInvocation = computed(() => {
  const sessionId = activeSession.value?.id
  return sessionId ? skillInvocationBySession.value[sessionId] ?? null : null
})
const skillCandidates = computed(() => {
  const query = skillQueryFromDraft(activeDraft.value, draftInput.value?.selectionStart ?? activeDraft.value.length)
  if (query === null) return []
  const skills = activeSkillInvocation.value ? [] : matchSkillCandidates(availableSkills.value, query).filter((skill) => skill.name.toLowerCase() !== 'prompt')
  return 'prompt'.includes(query.toLowerCase()) ? [promptCommand, ...skills] : skills
})
const canSendDraft = computed(() => (
  !isEnded.value
  && !isPastingImage.value
  && !isEnhancingPrompt.value
  && (!!activeDraft.value.trim() || activeImageAttachments.value.length > 0 || !!activeSkillInvocation.value)
))
const isEnhancingPrompt = computed(() => (
  !!activeSession.value && promptEnhancementSessionId.value === activeSession.value.id
))
const canEnhancePrompt = computed(() => (
  !isEnded.value
  && !isPastingImage.value
  && !promptEnhancementSessionId.value
  && !!activeDraft.value.trim()
))
const canUndoPromptEnhancement = computed(() => {
  const sessionId = activeSession.value?.id
  return !!sessionId
    && !isEnhancingPrompt.value
    && Object.prototype.hasOwnProperty.call(promptEnhancementUndoBySession.value, sessionId)
})
const externalHandoffBlockReason = computed(() => {
  const sessionId = activeSession.value?.id
  if (!sessionId || !isCodexTerminal.value) return ''
  if (store.terminalConversationReplyPending[sessionId]) {
    return '当前 Codex 仍在生成，请等待回复完成或先手动停止'
  }
  if (activeDraft.value.trim() || activeImageAttachments.value.length > 0) {
    return '输入框还有未发送内容，请先发送或清空后再移到外部'
  }
  return ''
})
const externalConversationButtonTitle = computed(() => (
  externalHandoffBlockReason.value
  || (isCodexTerminal.value
    ? '结束内嵌 Codex，并在外部 CMD 中继续同一会话'
    : '在外部 CMD 中使用原生会话 ID 继续当前对话')
))
const externalConversationButtonLabel = computed(() => {
  if (isOpeningExternalConversation.value) {
    return isCodexTerminal.value ? '正在移到外部...' : '正在外部启动...'
  }
  return isCodexTerminal.value ? '移到外部继续' : '外部启动当前对话'
})
const promptEnhancementStatus = computed(() => {
  const sessionId = activeSession.value?.id
  if (sessionId && promptEnhancementSessionId.value === sessionId) {
    return `Codex 正在增强提示词 · 已用时 ${formatPromptEnhancementDuration(promptEnhancementElapsedMs.value)}`
  }
  return sessionId ? promptEnhancementStatusBySession.value[sessionId] ?? '' : ''
})
const quickPhrases = computed(() => store.settings.quickPhrases ?? [])
const canSaveQuickPhrase = computed(() => (
  isCliMode.value
  && !!activeSession.value
  && !isEnded.value
  && !isSavingPhrase.value
  && !!phraseText.value.trim()
))
const cliHistoryMessages = computed(() => mergeHistoryMessages(
  collectCliHistoryMessages(
    store.terminalConversation,
    [...store.cliTerminalSessions, ...store.dragonCliTerminalSessions].map((session) => session.id),
  ),
  store.cliHistoryMessages,
))
const {
  candidates: historyCandidates,
  candidateCounts: historyCandidateCounts,
  candidateLabels: historyCandidateLabels,
  selectedIndex: historySelectedIndex,
  popupOpen: historyPopupOpen,
  refresh: refreshHistoryPopup,
  confirm: confirmHistoryPopup,
  move: moveHistoryPopup,
  moveTo: moveToHistoryPopup,
  close: closeHistoryPopup,
} = useHistoryTabCompletion({
  history: () => cliHistoryMessages.value,
  extraPaths: () => store.cliHistoryPaths,
  getDraft: () => activeDraft.value,
  getCursorOffset: () => draftInput.value?.selectionStart ?? activeDraft.value.length,
  applyDraft: (text, cursorOffset) => {
    activeDraft.value = text
    void nextTick(() => {
      syncDraftHeight(draftInput.value, true)
      if (cursorOffset !== undefined && draftInput.value) {
        draftInput.value.focus()
        draftInput.value.setSelectionRange(cursorOffset, cursorOffset)
      }
    })
  },
})

function refreshCliHistoryPopup(): string {
  if (!cliInputTabCompletionEnabled) {
    closeHistoryPopup()
    return ''
  }
  return refreshHistoryPopup()
}

function closeSkillPopup() {
  skillPopupOpen.value = false
}

function closePromptHistory() {
  promptHistoryOpen.value = false
  promptHistoryLoadToken += 1
}

async function openPromptHistory() {
  closeSkillPopup()
  closeHistoryPopup()
  promptHistoryOpen.value = true
  promptHistorySearch.value = ''
  promptHistorySelectedIndex.value = 0
  const projectPath = promptHistoryWorkspacePath.value
  const cached = projectPath ? promptHistoryCache.peek(projectPath) : undefined
  promptHistoryEntries.value = cached ?? []
  promptHistoryStatus.value = cached ? '' : '正在读取提示词…'
  const token = ++promptHistoryLoadToken
  try {
    if (!projectPath) throw new Error('没有当前工作区')
    const entries = await promptHistoryCache.refresh(projectPath)
    if (token !== promptHistoryLoadToken) return
    const selectedId = filteredPromptHistory.value[promptHistorySelectedIndex.value]?.id
    promptHistoryEntries.value = entries
    promptHistorySelectedIndex.value = Math.max(0, filteredPromptHistory.value.findIndex((entry) => entry.id === selectedId))
    promptHistoryStatus.value = ''
  } catch (error) {
    if (token === promptHistoryLoadToken) promptHistoryStatus.value = `读取失败：${String(error)}`
  }
}

function confirmPromptHistory(index: number) {
  const entry = filteredPromptHistory.value[index]
  if (!entry) return
  activeDraft.value = entry.content
  if (activeSession.value) skillInvocationBySession.value[activeSession.value.id] = null
  closePromptHistory()
  void nextTick(() => {
    syncDraftHeight(draftInput.value, true)
    draftInput.value?.focus()
    draftInput.value?.setSelectionRange(entry.content.length, entry.content.length)
  })
}

function dismissPromptHistory() {
  closePromptHistory()
  void nextTick(() => draftInput.value?.focus())
}

watch(promptHistorySearch, () => { promptHistorySelectedIndex.value = 0 })

watch(promptHistoryWorkspacePath, (path) => {
  if (isTauri() && isCliMode.value && !props.compactTeam && path && promptHistoryCache.peek(path) === undefined) {
    void promptHistoryCache.refresh(path).catch(() => undefined)
  }
}, { immediate: true })

function refreshSkillPopup() {
  if (promptHistoryOpen.value) {
    closeSkillPopup()
    return
  }
  const candidates = skillCandidates.value
  skillSelectedIndex.value = 0
  skillPopupOpen.value = candidates.length > 0
  if (skillPopupOpen.value) closeHistoryPopup()
}

function moveSkillPopup(delta: number) {
  if (!skillPopupOpen.value || !skillCandidates.value.length) return
  skillSelectedIndex.value = (skillSelectedIndex.value + delta + skillCandidates.value.length) % skillCandidates.value.length
}

function moveToSkillPopup(index: number) {
  if (!skillPopupOpen.value || index < 0 || index >= skillCandidates.value.length) return
  skillSelectedIndex.value = index
}

function confirmSkillPopup(index?: number) {
  if (!skillPopupOpen.value) return false
  if (index !== undefined) moveToSkillPopup(index)
  const candidate = skillCandidates.value[skillSelectedIndex.value]
  if (!candidate || !activeSession.value) return false
  if (candidate.path === promptCommand.path) {
    void openPromptHistory()
    return true
  }
  skillInvocationBySession.value = {
    ...skillInvocationBySession.value,
    [activeSession.value.id]: skillInvocationFromCandidate(candidate),
  }
  activeDraft.value = ''
  closeSkillPopup()
  refreshCliHistoryPopup()
  void nextTick(() => {
    syncDraftHeight(draftInput.value, true)
    draftInput.value?.focus()
  })
  return true
}

function clearActiveSkill() {
  const sessionId = activeSession.value?.id
  if (!sessionId) return
  skillInvocationBySession.value = {
    ...skillInvocationBySession.value,
    [sessionId]: null,
  }
  closeSkillPopup()
  void nextTick(() => draftInput.value?.focus())
}

async function loadSkills() {
  if (!isTauri()) return
  const loadToken = ++skillLoadToken
  skillLoading.value = true
  try {
    const projectPath = store.workspace?.rootPath?.trim() || activeSession.value?.cwd?.trim() || props.cwd?.trim() || null
    const skills = await backend.listSkills(projectPath)
    if (loadToken !== skillLoadToken) return
    availableSkills.value = skills
    refreshSkillPopup()
  } catch {
    if (loadToken !== skillLoadToken) return
    availableSkills.value = []
    closeSkillPopup()
  } finally {
    if (loadToken === skillLoadToken) skillLoading.value = false
  }
}
const historyNoMatchHint = ref('')
let historyNoMatchTimer: number | null = null
let dshHistorySessionId: string | null = null
let dshHistoryIndex: number | null = null
let dshHistoryDraft = ''

function resetDshInputHistory() {
  dshHistorySessionId = null
  dshHistoryIndex = null
  dshHistoryDraft = ''
}

function dshInputHistory(): string[] {
  const sessionId = activeSession.value?.id
  if (!sessionId) return []
  return (store.terminalConversation[sessionId] ?? [])
    .filter((message) => message.role === 'user' && !!message.content.trim())
    .map((message) => message.content)
    .reverse()
}

function canNavigateDshInputHistory(event: KeyboardEvent): boolean {
  if (!isDshTerminal.value || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return false
  const input = event.currentTarget as HTMLTextAreaElement
  if (!input.value.includes('\n')) return true
  const cursor = input.selectionStart ?? 0
  const selectionEnd = input.selectionEnd ?? cursor
  return event.key === 'ArrowUp'
    ? cursor === 0 && selectionEnd === 0
    : cursor === input.value.length && selectionEnd === input.value.length
}

function recallDshInputHistory(direction: 1 | -1): boolean {
  const sessionId = activeSession.value?.id
  if (!sessionId) return false
  const history = dshInputHistory()
  if (!history.length) return false

  if (dshHistorySessionId !== sessionId || dshHistoryIndex === null) {
    if (direction > 0) return false
    dshHistorySessionId = sessionId
    dshHistoryIndex = 0
    dshHistoryDraft = activeDraft.value
  } else if (direction < 0) {
    dshHistoryIndex = Math.min(dshHistoryIndex + 1, history.length - 1)
  } else if (dshHistoryIndex === 0) {
    activeDraft.value = dshHistoryDraft
    resetDshInputHistory()
    void nextTick(() => {
      syncDraftHeight(draftInput.value, true)
      draftInput.value?.setSelectionRange(activeDraft.value.length, activeDraft.value.length)
    })
    return true
  } else {
    dshHistoryIndex -= 1
  }

  activeDraft.value = history[dshHistoryIndex]
  void nextTick(() => {
    syncDraftHeight(draftInput.value, true)
    draftInput.value?.setSelectionRange(activeDraft.value.length, activeDraft.value.length)
  })
  return true
}

function showHistoryNoMatchHint(hint: string) {
  historyNoMatchHint.value = hint
  if (historyNoMatchTimer !== null) window.clearTimeout(historyNoMatchTimer)
  historyNoMatchTimer = window.setTimeout(() => {
    historyNoMatchHint.value = ''
    historyNoMatchTimer = null
  }, 3000)
}

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
    refreshCliHistoryPopup()
    void nextTick(() => syncDraftHeight(draftInput.value, true))
  },
})
const leftAltVoiceShortcut = createLeftAltVoiceShortcutTracker()
let terminal: Terminal | null = null
let terminalFileLinkRegistration: { dispose(): void } | null = null
let codexTerminalRenderer: CodexTerminalRenderer | null = null
let fitAddon: FitAddon | null = null
let webglAddon: WebglAddon | null = null
let resizeObserver: ResizeObserver | null = null
let visibilityObserver: IntersectionObserver | null = null
let terminalVisible = true
const restoringTerminal = ref(false)
let resizeTimer: number | null = null
let terminalRenderFrame: number | null = null
let lastFitTime = 0
let lastKnownHostWidth = 0
let lastKnownHostHeight = 0
let lastResizedSessionId: string | null = null
let lastResizedCols = 0
let lastResizedRows = 0
let draftHeightFitSuppressedUntil = 0
interface BufferedTerminalOutput {
  data: string
  synchronizedFrame: boolean
}

let bufferedOutputChunks: BufferedTerminalOutput[] = []
let bufferedOutputChars = 0
let renderedOutputEndByte = 0
let outputListenerCleanup: (() => void) | null = null
let activeSessionIdSnapshot: string | null = null
let bufferRefreshInFlightForSession: string | null = null
let deferredOutputEvents: TerminalOutputPayload[] = []
let terminalPrimeRetryTimers: number[] = []
let terminalPaneMounted = false
let terminalActivationToken = 0
let writeInFlight = false
let terminalOutputGeneration = 0
const terminalBufferFailedSessionIds = new Set<string>()
const terminalDefaultWriteCharsPerFrame = 32 * 1024
const terminalFrameWriteCharsPerFrame = 128 * 1024
const terminalMaxBufferedBytes = 2 * 1024 * 1024
const syncOutputSet = '\u001b[?2026h'
const syncOutputReset = '\u001b[?2026l'
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
  if (!store.isCliProviderVisible(provider)) return
  void (async () => {
    const scope = isDragonScope.value ? 'dragon' : 'project'
    await store.createTerminalSession(provider, {
      cwd: props.cwd,
      initialPrompt: props.initialPrompt,
      name: isDragonScope.value ? `画布 ${providerLabel({
        id: '',
        title: '',
        providerKind: provider,
        cwd: props.cwd,
      })}` : undefined,
      scope,
    })
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
  if (!store.isCliProviderVisible(provider)) return
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

async function openActiveConversationExternally() {
  const session = activeSession.value
  if (!session || isOpeningExternalConversation.value) return
  if (!['claude', 'codex', 'dsh'].includes(session.providerKind)) {
    store.showErrorMessage('当前 CLI 暂不支持从外部窗口继续会话')
    return
  }
  if (session.providerKind === 'codex' && externalHandoffBlockReason.value) {
    store.showErrorMessage(externalHandoffBlockReason.value)
    return
  }
  isOpeningExternalConversation.value = true
  try {
    await backend.openExternalCliSession(session.id)
    if (session.providerKind === 'codex') {
      await store.closeTerminalSession(session.id)
      store.showActivityMessage('已将当前 Codex 对话移到外部 CMD 继续')
    } else {
      store.showActivityMessage(`已在外部 CMD 继续当前 ${providerLabel(session)} 对话`)
    }
  } catch (error) {
    store.showErrorMessage(`外部启动当前对话失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    isOpeningExternalConversation.value = false
  }
}

function openNewConversation() {
  if (isDragonScope.value) {
    createProviderSession('claude')
    return
  }
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
  resetBufferedOutput()
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
  terminalFileLinkRegistration?.dispose()
  terminalFileLinkRegistration = null
  codexTerminalRenderer?.dispose()
  codexTerminalRenderer = null
  terminal?.dispose()
  terminal = null
  fitAddon = null
  lastKnownHostWidth = 0
  lastKnownHostHeight = 0
  lastResizedSessionId = null
  lastResizedCols = 0
  lastResizedRows = 0
  draftHeightFitSuppressedUntil = 0
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
    const sessionId = activeSession.value.id
    if (
      lastResizedSessionId !== sessionId
      || lastResizedCols !== terminal.cols
      || lastResizedRows !== terminal.rows
    ) {
      lastResizedSessionId = sessionId
      lastResizedCols = terminal.cols
      lastResizedRows = terminal.rows
      void store.resizeTerminalSession(sessionId, terminal.cols, terminal.rows)
    }
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
  return isFrameRenderedTerminal.value ? 10_000 : isCliMode.value ? 5_000 : 1_000
}

function terminalScrollSensitivity(): number {
  return isFrameRenderedTerminal.value ? 1.25 : 1
}

function terminalWriteCharsPerFrame(): number {
  return isFrameRenderedTerminal.value ? terminalFrameWriteCharsPerFrame : terminalDefaultWriteCharsPerFrame
}

/** 按当前会话切换渲染器：dsh 全屏 TUI 用 DOM/canvas，其余再用 WebGL。 */
function syncTerminalRenderer() {
  if (!terminal) return
  const wantWebgl = !props.compactTeam && !isDshTerminal.value
  if (wantWebgl && !webglAddon) {
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
  } else if (!wantWebgl && webglAddon) {
    webglAddon.dispose()
    webglAddon = null
  }
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
    linkHandler: {
      activate: (_event, url) => {
        void backend.openUrl(url).catch((error) => {
          store.showErrorMessage(`打开网页失败：${error instanceof Error ? error.message : String(error)}`)
        })
      },
      allowNonHttpProtocols: false,
    },
  })
  terminal.loadAddon(fitAddon)
  terminal.open(host.value)
  if (isCliMode.value) {
    terminalFileLinkRegistration = registerTerminalFileLinks(terminal, {
      workspaceRoot: resolveTerminalFileLinkWorkspaceRoot,
      resolvePath: (path) => backend.resolveTerminalPath(path),
      openFile: openTerminalFileLink,
      openFolder: (path) => store.openPath(path),
    })
  }
  syncTerminalRenderer()
  terminal.onData((data) => {
    // Historical device queries must not be sent back to the running CLI.
    if (restoringTerminal.value) return
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
      if (!terminalVisible && terminalRenderFrame !== null) {
        window.cancelAnimationFrame(terminalRenderFrame)
        terminalRenderFrame = null
      }
      if ((!terminalVisible || wasHidden) && bufferedOutputChunks.length) {
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
  // Parse hidden output too: pausing here turns tab activation into a replay.
  if (!terminalVisible || restoringTerminal.value) {
    applyBufferedOutput()
    return
  }
  terminalRenderFrame = window.requestAnimationFrame(() => {
    terminalRenderFrame = null
    applyBufferedOutput()
  })
}

function applyBufferedOutput() {
  if (!terminal || writeInFlight) return
  if (!bufferedOutputChunks.length) return

  const data = takeBufferedOutput(terminalWriteCharsPerFrame())

  if (!data) return
  const renderedData = codexTerminalRenderer?.render(data) ?? data
  if (!renderedData) {
    if (bufferedOutputChunks.length) renderBuffer()
    else restoringTerminal.value = false
    return
  }
  const writeTerminal = terminal
  const outputGeneration = terminalOutputGeneration
  writeInFlight = true
  try {
    writeTerminal.write(renderedData, () => {
      if (outputGeneration !== terminalOutputGeneration || terminal !== writeTerminal) return
      writeInFlight = false
      if (bufferedOutputChunks.length) renderBuffer()
      else restoringTerminal.value = false
    })
  } catch {
    if (outputGeneration !== terminalOutputGeneration || terminal !== writeTerminal) return
    writeInFlight = false
    if (bufferedOutputChunks.length) renderBuffer()
    else restoringTerminal.value = false
  }
}

function queueOutput(chunk: string) {
  if (!chunk) return
  const parts = isFrameRenderedTerminal.value
    ? splitSynchronizedOutputFrames(chunk)
    : [{ data: chunk, synchronizedFrame: false }]
  for (const part of parts) {
    appendBufferedOutput(part)
  }
  trimBufferedOutput()
  renderBuffer()
}

/**
 * 把一次后端事件拆为普通片段与完整 DEC 2026 帧。后端只会在闭合帧边界发事件；
 * 这里仍按帧拆队列，以便不能因为多帧合批就把整段积压同步交给 xterm。
 */
function splitSynchronizedOutputFrames(chunk: string): BufferedTerminalOutput[] {
  const parts: BufferedTerminalOutput[] = []
  let cursor = 0
  let frameStart = -1
  let depth = 0
  let scanFrom = 0

  while (scanFrom < chunk.length) {
    const setIndex = chunk.indexOf(syncOutputSet, scanFrom)
    const resetIndex = chunk.indexOf(syncOutputReset, scanFrom)
    if (setIndex < 0 && resetIndex < 0) break
    const isSet = setIndex >= 0 && (resetIndex < 0 || setIndex < resetIndex)
    const markerIndex = isSet ? setIndex : resetIndex
    const markerLength = isSet ? syncOutputSet.length : syncOutputReset.length
    scanFrom = markerIndex + markerLength

    if (isSet) {
      if (depth === 0) {
        if (markerIndex > cursor) parts.push({
          data: chunk.slice(cursor, markerIndex),
          synchronizedFrame: false,
        })
        frameStart = markerIndex
      }
      depth += 1
      continue
    }

    if (depth === 0) continue
    depth -= 1
    if (depth === 0 && frameStart >= 0) {
      parts.push({
        data: chunk.slice(frameStart, scanFrom),
        synchronizedFrame: true,
      })
      cursor = scanFrom
      frameStart = -1
    }
  }

  if (depth > 0 && frameStart >= 0) {
    // 后端的强制兜底可能交付异常的未闭合帧；不能在前端切开它，避免把差分
    // patch 写到错误的前序状态。正常路径不会进入这里。
    parts.push({ data: chunk.slice(frameStart), synchronizedFrame: true })
  } else if (cursor < chunk.length) {
    parts.push({ data: chunk.slice(cursor), synchronizedFrame: false })
  }
  return parts
}

function appendBufferedOutput(part: BufferedTerminalOutput) {
  if (!part.data) return
  const last = bufferedOutputChunks[bufferedOutputChunks.length - 1]
  const writeLimit = terminalWriteCharsPerFrame()
  if (
    last
    && !last.synchronizedFrame
    && !part.synchronizedFrame
    && last.data.length + part.data.length <= writeLimit
  ) {
    last.data += part.data
    bufferedOutputChars += part.data.length
    return
  }
  bufferedOutputChunks.push(part)
  bufferedOutputChars += part.data.length
}

function takeBufferedOutput(writeLimit: number): string {
  let data = ''
  while (bufferedOutputChunks.length && data.length < writeLimit) {
    const chunk = bufferedOutputChunks[0]
    if (!chunk?.data) {
      bufferedOutputChunks.shift()
      continue
    }
    // 一个完整同步帧永远只会进入同一次 xterm.write。它可能刚好超过普通预算，
    // 但不能切开；后端已把正常帧限制在单个闭合边界内。
    if (chunk.synchronizedFrame) {
      if (data) break
      bufferedOutputChunks.shift()
      bufferedOutputChars -= chunk.data.length
      return chunk.data
    }
    const remaining = writeLimit - data.length
    if (chunk.data.length <= remaining) {
      bufferedOutputChunks.shift()
      bufferedOutputChars -= chunk.data.length
      data += chunk.data
      continue
    }
    let splitAt = remaining
    // 不在 Unicode surrogate pair 中间切字符串。
    if (splitAt > 0 && /[\uD800-\uDBFF]/.test(chunk.data.charAt(splitAt - 1))) splitAt -= 1
    if (splitAt <= 0) break
    const head = chunk.data.slice(0, splitAt)
    chunk.data = chunk.data.slice(splitAt)
    bufferedOutputChars -= head.length
    data += head
    break
  }
  return data
}

function trimBufferedOutput() {
  while (bufferedOutputChars > terminalMaxBufferedBytes && bufferedOutputChunks.length > 1) {
    const removed = bufferedOutputChunks.shift()!
    bufferedOutputChars -= removed.data.length
  }
}

function resetBufferedOutput() {
  terminalOutputGeneration += 1
  if (terminalRenderFrame !== null) {
    window.cancelAnimationFrame(terminalRenderFrame)
    terminalRenderFrame = null
  }
  bufferedOutputChunks = []
  bufferedOutputChars = 0
  writeInFlight = false
  restoringTerminal.value = false
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
  restoringTerminal.value = true
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
    syncTerminalRenderer()
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
  const activationToken = terminalActivationToken
  bufferRefreshInFlightForSession = sessionId
  restoringTerminal.value = true
  let refreshed = false
  try {
    const snapshot = await backend.getTerminalBuffer(sessionId)
    if (sessionId !== activeSessionIdSnapshot || activationToken !== terminalActivationToken) return
    terminal?.reset()
    resetBufferedOutput()
    renderedOutputEndByte = snapshot.endByte
    // Restore the entire history in one write, hidden until xterm has parsed it.
    // RIS is queued with the history so an earlier pending write cannot undo reset.
    if (snapshot.buffer) {
      restoringTerminal.value = true
      appendBufferedOutput({ data: '\x1bc' + snapshot.buffer, synchronizedFrame: true })
      renderBuffer()
    }
    refreshed = true
    terminalBufferFailedSessionIds.delete(sessionId)
  } catch {
    if (sessionId === activeSessionIdSnapshot && activationToken === terminalActivationToken) {
      terminalBufferFailedSessionIds.add(sessionId)
      resetBufferedOutput()
      renderedOutputEndByte = 0
      queueOutput('\r\n[Super High] 这个终端会话已经失效。请关闭这个标签后新建会话。\r\n')
    }
  } finally {
    if (activationToken !== terminalActivationToken) return
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
  if (activeDraft.value.trim().toLowerCase() === '/prompt') {
    void openPromptHistory()
    return
  }
  if (!activeSession.value || isEnded.value || isPastingImage.value || isEnhancingPrompt.value) return
  const sessionId = activeSession.value.id
  const draft = activeDraft.value
  const attachments = imageAttachmentsBySession.value[sessionId] ?? []
  const message = buildCliMessageWithImages(
    formatSkillMessage(activeSkillInvocation.value, draft),
    attachments.map((item) => item.path),
    activeSession.value.providerKind,
  )
  if (!message.trim()) return
  closeHistoryPopup()
  closeSkillPopup()
  const sent = await store.sendTerminalConversationMessage(sessionId, message)
  if (sent === false) return
  skillInvocationBySession.value = {
    ...skillInvocationBySession.value,
    [sessionId]: null,
  }
  imageAttachmentsBySession.value = {
    ...imageAttachmentsBySession.value,
    [sessionId]: [],
  }
  promptEnhancementUndoBySession.value = {
    ...promptEnhancementUndoBySession.value,
    [sessionId]: undefined,
  }
  promptEnhancementStatusBySession.value = {
    ...promptEnhancementStatusBySession.value,
    [sessionId]: undefined,
  }
  syncDraftHeight(draftInput.value, true)
  requestAnimationFrame(() => terminal?.focus())
}

async function enhanceDraftPrompt() {
  const session = activeSession.value
  const original = activeDraft.value
  if (!session || !original.trim() || isEnded.value || isPastingImage.value || promptEnhancementSessionId.value) return

  const sessionId = session.id
  promptEnhancementSessionId.value = sessionId
  startPromptEnhancementTimer()
  promptEnhancementStatusBySession.value = {
    ...promptEnhancementStatusBySession.value,
    [sessionId]: undefined,
  }
  phrasePanelOpen.value = false
  closeHistoryPopup()
  closeSkillPopup()
  try {
    const enhanced = (await backend.enhancePromptWithCodex(session.cwd, original)).trim()
    if (!enhanced) throw new Error('Codex CLI 返回了空提示词')
    promptEnhancementUndoBySession.value = {
      ...promptEnhancementUndoBySession.value,
      [sessionId]: original,
    }
    store.setTerminalDraft(sessionId, enhanced)
    const elapsed = stopPromptEnhancementTimer()
    promptEnhancementStatusBySession.value = {
      ...promptEnhancementStatusBySession.value,
      [sessionId]: `已增强（用时 ${formatPromptEnhancementDuration(elapsed)}），可撤回本次更改。`,
    }
    if (activeSession.value?.id === sessionId) {
      await nextTick()
      syncDraftHeight(draftInput.value, true)
      draftInput.value?.focus()
    }
  } catch (error) {
    const elapsed = stopPromptEnhancementTimer()
    promptEnhancementStatusBySession.value = {
      ...promptEnhancementStatusBySession.value,
      [sessionId]: `增强失败（用时 ${formatPromptEnhancementDuration(elapsed)}）。`,
    }
    store.showErrorMessage(error instanceof Error ? error.message : String(error))
  } finally {
    stopPromptEnhancementTimer()
    if (promptEnhancementSessionId.value === sessionId) promptEnhancementSessionId.value = null
  }
}

function formatPromptEnhancementDuration(elapsedMs: number) {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  if (totalSeconds < 1) return '不足 1 秒'
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`
}

function startPromptEnhancementTimer() {
  stopPromptEnhancementTimer()
  promptEnhancementStartedAt = Date.now()
  promptEnhancementElapsedMs.value = 0
  promptEnhancementTimer = window.setInterval(() => {
    if (promptEnhancementStartedAt !== null) {
      promptEnhancementElapsedMs.value = Date.now() - promptEnhancementStartedAt
    }
  }, 1000)
}

function stopPromptEnhancementTimer() {
  if (promptEnhancementStartedAt !== null) {
    promptEnhancementElapsedMs.value = Date.now() - promptEnhancementStartedAt
    promptEnhancementStartedAt = null
  }
  if (promptEnhancementTimer !== null) {
    window.clearInterval(promptEnhancementTimer)
    promptEnhancementTimer = null
  }
  return promptEnhancementElapsedMs.value
}

function undoPromptEnhancement() {
  const sessionId = activeSession.value?.id
  if (!sessionId || !Object.prototype.hasOwnProperty.call(promptEnhancementUndoBySession.value, sessionId)) return
  store.setTerminalDraft(sessionId, promptEnhancementUndoBySession.value[sessionId] ?? '')
  promptEnhancementUndoBySession.value = {
    ...promptEnhancementUndoBySession.value,
    [sessionId]: undefined,
  }
  promptEnhancementStatusBySession.value = {
    ...promptEnhancementStatusBySession.value,
    [sessionId]: undefined,
  }
  void nextTick(() => {
    syncDraftHeight(draftInput.value, true)
    draftInput.value?.focus()
  })
}

function onDraftKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (promptHistoryOpen.value && event.key === 'Escape') {
    event.preventDefault()
    dismissPromptHistory()
    return
  }
  if (skillPopupOpen.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    moveSkillPopup(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (skillPopupOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeSkillPopup()
    return
  }
  if (skillPopupOpen.value && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    confirmSkillPopup()
    return
  }
  if (activeSkillInvocation.value && event.key === 'Backspace'
    && draftInput.value?.selectionStart === 0
    && draftInput.value?.selectionEnd === 0) {
    event.preventDefault()
    clearActiveSkill()
    return
  }
  if (canNavigateDshInputHistory(event)
    && recallDshInputHistory(event.key === 'ArrowDown' ? 1 : -1)) {
    event.preventDefault()
    return
  }
  if (historyPopupOpen.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    moveHistoryPopup(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (historyPopupOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeHistoryPopup()
    return
  }
  if (cliInputTabCompletionEnabled && (event.key === 'Tab' || event.code === 'Tab')
    && !event.altKey && !event.ctrlKey && !event.metaKey
    && !event.isComposing) {
    event.preventDefault()
    if (historyPopupOpen.value) {
      if (event.shiftKey) {
        moveHistoryPopup(-1)
      } else {
        confirmHistoryPopup()
      }
    } else {
      const hintText = refreshCliHistoryPopup()
      if (hintText) showHistoryNoMatchHint(hintText)
    }
    return
  }
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void sendDraft()
}

function onDraftInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  resetDshInputHistory()
  activeDraft.value = target.value
  closePromptHistory()
  const isSkillQuery = !activeSkillInvocation.value
    && skillQueryFromDraft(target.value, target.selectionStart) !== null
  refreshSkillPopup()
  if (isSkillQuery) {
    closeHistoryPopup()
    if (target.value === '/') void loadSkills()
  } else if (cliInputTabCompletionEnabled) {
    refreshCliHistoryPopup()
  } else {
    closeHistoryPopup()
  }
  syncDraftHeight(target, true)
}

function resolveTerminalFileLinkWorkspaceRoot(): string | null {
  const sessionCwd = activeSession.value?.cwd?.trim()
  if (sessionCwd) return sessionCwd
  return props.cwd?.trim() || store.workspace?.rootPath?.trim() || null
}

async function openTerminalFileLink(path: string) {
  store.setWorkspaceSurface('project')
  if (store.settings.activePreviewMode !== 'code') store.setPreviewMode('code')
  await store.openFile(path, {
    createUnsupportedTabOnError: false,
    verifyExistingFile: true,
  })
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
  refreshCliHistoryPopup()
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
  if (store.settingsOpen) return
  if (props.compactTeam || !isCliMode.value) return
  leftAltVoiceShortcut.keydown(event)
}

function onWindowKeyup(event: KeyboardEvent) {
  if (store.settingsOpen) {
    leftAltVoiceShortcut.reset()
    return
  }
  if (props.compactTeam || !isCliMode.value) return
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
  if (props.compactTeam || !isCliMode.value || !activeSession.value) return
  const detail = (event as CustomEvent<{ insertMode?: 'plain'; source?: string; text?: string }>).detail
  const text = detail?.text?.trim()
  if (!text) return
  closeHistoryPopup()
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
  if (!props.compactTeam) {
    void loadSkills()
    window.addEventListener('superhigh:add-selection-to-chat', handleExternalInsert)
    window.addEventListener('keydown', onWindowKeydown)
    window.addEventListener('keyup', onWindowKeyup)
    window.addEventListener('blur', onWindowBlur)
  }
})

watch(() => store.workspace?.rootPath, (rootPath) => {
  closePromptHistory()
  if (!isCliMode.value && rootPath) void store.refreshProjectStartupConfig()
  if (isCliMode.value && !props.compactTeam) void loadSkills()
})

watch(() => activeSession.value?.cwd ?? '', () => {
  closePromptHistory()
  if (isCliMode.value && !props.compactTeam) void loadSkills()
})

watch(() => activeSession.value?.id ?? null, () => {
  closePromptHistory()
  resetDshInputHistory()
  closeHistoryPopup()
  closeSkillPopup()
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
  skillLoadToken += 1
  closePromptHistory()
  window.removeEventListener('resize', scheduleFit)
  window.removeEventListener('superhigh:add-selection-to-chat', handleExternalInsert)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keyup', onWindowKeyup)
  window.removeEventListener('blur', onWindowBlur)
  leftAltVoiceShortcut.reset()
  stopPromptEnhancementTimer()
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
          <button v-if="isDragonScope" class="ghost-button" @click="openNewConversation">
            <Plus :size="13" />
            <span>画布对话</span>
          </button>
          <button
            v-for="provider in visibleProviders"
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
              v-for="action in visibleProjectTerminalActions"
              :key="action.id"
              class="ghost-button"
              :disabled="store.projectTerminalActionBusy[action.id] || (action.kind === 'minecraft-client' && store.minecraftClientBusy)"
              :title="action.tooltip || action.label"
              @click="runProjectTerminalAction(action)"
            >
              <Play :size="13" />
              <span>{{ store.projectTerminalActionBusy[action.id] ? '执行中' : action.label }}</span>
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
              title="关闭本轮由 SuperHigh 启动的服务终端；Minecraft 服务请先在对应终端输入 stop，外部运行服务不会被关闭"
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
        <div
          ref="host"
          class="terminal-host"
          :style="{ visibility: restoringTerminal ? 'hidden' : undefined }"
          :class="{
            'codex-terminal-host': isCodexTerminal,
            'framed-terminal-host': isFrameRenderedTerminal,
          }"
        />
        <button
          v-if="!compactTeam && isCliMode && activeSession && !isDragonScope && ['claude', 'codex', 'dsh'].includes(activeSession.providerKind)"
          type="button"
          class="cli-external-resume-button"
          :disabled="isOpeningExternalConversation || isEnded || !!externalHandoffBlockReason"
          :title="externalConversationButtonTitle"
          @click.stop="openActiveConversationExternally"
        >
          <TerminalSquare :size="13" />
          <span>{{ externalConversationButtonLabel }}</span>
        </button>
        <button
          v-if="!compactTeam && selectedText.trim()"
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
            <div v-if="activeSkillInvocation" class="skill-invocation-chip" data-testid="skill-invocation-chip">
              <span class="skill-invocation-command">/{{ activeSkillInvocation.name }}</span>
              <button
                type="button"
                class="skill-invocation-remove"
                title="移除已选择的 Skill"
                aria-label="移除已选择的 Skill"
                @click="clearActiveSkill"
              >
                <X :size="12" />
              </button>
            </div>
            <SkillCompletionPopup
              v-if="promptHistoryOpen"
              :candidates="[]"
              :prompts="filteredPromptHistory"
              :search="promptHistorySearch"
              :status="promptHistoryStatus"
              :selected-index="promptHistorySelectedIndex"
              @update:search="promptHistorySearch = $event"
              @select="promptHistorySelectedIndex = $event"
              @confirm="confirmPromptHistory"
              @close="dismissPromptHistory"
            />
            <SkillCompletionPopup
              v-if="skillPopupOpen"
              :candidates="skillCandidates"
              :selected-index="skillSelectedIndex"
              @select="moveToSkillPopup"
              @confirm="confirmSkillPopup"
            />
            <HistoryCompletionPopup
              v-if="cliInputTabCompletionEnabled && historyPopupOpen"
              :candidates="historyCandidates"
              :selected-index="historySelectedIndex"
              :counts="historyCandidateCounts"
              :labels="historyCandidateLabels"
              @select="moveToHistoryPopup"
              @confirm="confirmHistoryPopup"
            />
            <textarea
              ref="draftInput"
              :value="activeDraft"
              class="cli-message-input"
              :placeholder="isEnded ? '会话已结束' : (isEnhancingPrompt ? 'Codex 正在增强提示词…' : (activeImageAttachments.length ? '可继续输入说明，Enter 发送图片与文字' : '输入消息，Enter 发送，Shift+Enter 换行；可粘贴图片'))"
              rows="1"
              :disabled="isEnded || isPastingImage || isEnhancingPrompt"
              @input="onDraftInput"
              @keydown="onDraftKeydown"
              @paste="onDraftPaste"
            />
            <div v-if="historyNoMatchHint" class="cli-voice-status history-no-match">{{ historyNoMatchHint }}</div>
            <div v-if="voiceStatusMessage" class="cli-voice-status">{{ voiceStatusMessage }}</div>
            <div v-if="isPastingImage" class="cli-voice-status">正在保存粘贴图片…</div>
            <div v-if="promptEnhancementStatus" class="cli-voice-status prompt-enhancement-status">{{ promptEnhancementStatus }}</div>
          </div>
          <button
            type="button"
            class="conversation-voice-button prompt-enhance-button"
            :disabled="!canEnhancePrompt"
            :title="isEnhancingPrompt ? 'Codex 正在增强提示词' : '用 Codex 基于当前项目增强提示词'"
            aria-label="用 Codex 基于当前项目增强提示词"
            data-testid="terminal-enhance-prompt"
            @click="enhanceDraftPrompt"
          >
            <LoaderCircle v-if="isEnhancingPrompt" :size="14" class="prompt-enhance-spinner" />
            <Sparkles v-else :size="14" />
          </button>
          <button
            v-if="canUndoPromptEnhancement"
            type="button"
            class="conversation-voice-button prompt-enhance-button prompt-enhance-undo"
            title="撤回本次提示词增强"
            aria-label="撤回本次提示词增强"
            data-testid="terminal-undo-prompt-enhancement"
            @click="undoPromptEnhancement"
          >
            <RotateCcw :size="14" />
          </button>
          <button
            type="button"
            class="conversation-voice-button cli-phrase-toggle"
            :class="{ active: phrasePanelOpen }"
            :disabled="isEnded || isEnhancingPrompt"
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
            :disabled="isEnded || isEnhancingPrompt || !voiceInputAvailable || voiceInputState === 'starting'"
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
        <div class="panel-title">{{ isDragonScope ? '暂无画布 CLI' : (isCliMode ? '暂无 CLI 会话' : '暂无本地终端') }}</div>
        <p>
          {{ isDragonScope ? '创建会话后让 AI 修改固定像素配置，应用会读取配置并渲染画布。' : (isCliMode ? '创建 Claude Code 或 Codex 会话后，上方显示原始 CLI 渲染，下方保留对话输入区。' : '启动服务链后，可在此查看并输入各服务端控制台命令。') }}
        </p>
        <div class="terminal-empty-actions">
          <template v-if="isCliMode">
            <button v-if="isDragonScope" class="primary-button small" @click="openNewConversation">
              <Plus :size="13" />
              <span>画布对话</span>
            </button>
            <button
              v-for="provider in visibleProviders"
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
                v-for="action in visibleProjectTerminalActions"
                :key="action.id"
                class="ghost-button"
                :disabled="store.projectTerminalActionBusy[action.id] || (action.kind === 'minecraft-client' && store.minecraftClientBusy)"
                :title="action.tooltip || action.label"
                @click="runProjectTerminalAction(action)"
              >
                <Play :size="13" />
                <span>{{ store.projectTerminalActionBusy[action.id] ? '执行中' : action.label }}</span>
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
                title="关闭本轮由 SuperHigh 启动的服务终端；Minecraft 服务请先在对应终端输入 stop，外部运行服务不会被关闭"
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
