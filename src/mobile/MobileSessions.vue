<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Cpu, TerminalSquare, Plus, Mic, Send, Camera, ImageIcon, File, X, RefreshCw, MoreHorizontal, Slash } from 'lucide-vue-next'
import { appendVoiceText } from '@/lib/voiceInput'
import { useMobileVoiceInput } from '@/lib/mobileVoiceInput'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import { buildTerminalTheme } from '@/lib/theme'
import { TerminalColorAdapter } from '@/lib/terminalColors'
import { CLI_PROVIDER_OPTIONS, cliProviderLabel, cliProviderVisible } from '@/lib/cliProviders'
import type { CliNativeConversationDetail, CliNativeConversationSummary, CliProviderEnvironment, TerminalProviderKind, TerminalSession } from '@/types'

const props = withDefaults(defineProps<{ api: MobileHostApi; root: string; mode: 'terminal' | 'ai'; connected?: boolean; fontSize?: number; theme?: string; hiddenCliProviderIds?: string[]; initialDraft?: string }>(), { connected: true, fontSize: 14, theme: 'dark', hiddenCliProviderIds: () => [], initialDraft: '' })
const emit = defineEmits<{ connect: []; draftChange: [value: string] }>()
const sessions = ref<TerminalSession[]>([])
const providers = ref<CliProviderEnvironment[]>([])
const provider = ref<TerminalProviderKind>('codex')
const selectedId = ref('')
const busy = ref(false)
const sending = ref(false)
const commandControlsOpen = ref(false)
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

const closePending = ref(false)
const showHistory = ref(false)
const moreMenuOpen = ref(false)
const history = ref<CliNativeConversationSummary[]>([])
const conversation = ref<CliNativeConversationDetail | null>(null)
const terminalHost = ref<HTMLDivElement | null>(null)
const draftInput = ref<HTMLTextAreaElement | null>(null)
const inputFocused = ref(false)
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
const terminalColors = new TerminalColorAdapter()
let fit: FitAddon | undefined
let observer: ResizeObserver | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let cursor = 0
let disposed = false
let inputQueue: Promise<unknown> = Promise.resolve()
let pendingInputs = 0

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
  await act(async () => {
    sessions.value = await props.api.listTerminals()
    if (!activeSession.value) selectedId.value = visibleSessions.value[0]?.id ?? ''
  })
}

async function create() {
  if (!props.connected || !props.root || !cliProviderVisible(provider.value, props.hiddenCliProviderIds)) return
  await act(async () => {
    const session = await props.api.createTerminal(props.root, props.mode === 'terminal' ? 'local' : provider.value)
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

async function commandKey(input: string) {
  terminal?.focus()
  if (await write(input)) {
    if (input === '\u001b') commandControlsOpen.value = false
  }
}

function clickTerminal(event: MouseEvent) {
  if (!terminal || !running.value || terminal.hasSelection()) return
  const screen = terminalHost.value?.querySelector('.xterm-screen')?.getBoundingClientRect()
  if (!screen || screen.height <= 0) return
  const row = Math.floor((event.clientY - screen.top) * terminal.rows / screen.height)
  if (row < 0 || row >= terminal.rows) return
  const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? ''
  const command = line.match(/^\s*(\/[a-zA-Z][\w:-]*)(?:\s|$)/)?.[1]
  if (!command) return
  commandControlsOpen.value = true
  // Complete the tapped menu entry without executing it; keep the CLI editor focused.
  terminal.focus()
  void write(`\u001b[F\u0015${command} `)
}

async function closeSession() {
  await act(async () => {
    const id = selectedId.value
    await props.api.closeTerminal(id)
    sessions.value = sessions.value.filter((session) => session.id !== id)
    selectedId.value = visibleSessions.value[0]?.id ?? ''
    closePending.value = false
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
    const session = await props.api.resumeConversation(props.root, entry.providerKind, entry.nativeSessionId!)
    sessions.value = [...sessions.value.filter((item) => item.id !== session.id), session]
    selectedId.value = session.id
    showHistory.value = false
    conversation.value = null
  })
}

function scheduleFit() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!terminalHost.value?.clientHeight || showHistory.value) return
    fit?.fit()
    if (activeSession.value && running.value && terminal) {
      const id = selectedId.value
      void props.api.resizeTerminal(id, terminal.cols, terminal.rows).catch((cause) => {
        if (id === selectedId.value) streamError.value = formatError(cause)
      })
    }
  }, 150)
}

async function poll(id: string, epoch: number) {
  if (disposed || epoch !== generation) return
  try {
    const snapshot = await props.api.terminalBuffer(id, cursor)
    if (disposed || epoch !== generation) return
    streamError.value = ''
    const wasRunning = running.value
    running.value = snapshot.running
    if (snapshot.reset) { terminal?.reset(); terminalColors.reset() }
    if (snapshot.buffer && terminal) {
      await new Promise<void>((resolve) => terminal!.write(terminalColors.transform(snapshot.buffer, props.theme), resolve))
    }
    if (disposed || epoch !== generation) return
    cursor = snapshot.endByte
    if (!wasRunning && snapshot.running) scheduleFit()
    if (!snapshot.running) return
  } catch (cause) {
    if (disposed || epoch !== generation) return
    if (cause instanceof MobileHostError && cause.status === 404) {
      running.value = false
      streamError.value = '会话已结束或不可访问，已有输出保留在此处。'
      return
    }
    streamError.value = `连接中断，正在重试：${formatError(cause)}`
  }
  pollTimer = setTimeout(() => void poll(id, epoch), streamError.value ? 2500 : 350)
}

watch([selectedId, () => props.theme], async () => {
  generation += 1
  const epoch = generation
  const id = selectedId.value
  clearTimeout(pollTimer)
  cursor = 0
  running.value = false
  closePending.value = false
  commandControlsOpen.value = false
  streamError.value = ''
  terminal?.reset()
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

onMounted(async () => {
  terminal = new Terminal({
    fontSize: props.fontSize, fontFamily: '"Cascadia Code", Consolas, monospace',
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
  disposed = true
  generation += 1
  clearTimeout(pollTimer)
  clearTimeout(resizeTimer)
  observer?.disconnect()
  terminal?.dispose()
})
</script>

<template>
  <section class="mobile-sessions">
    <div class="mobile-session-toolbar mobile-cli-launchers" aria-label="CLI 工具">
      <button v-for="entry in visibleCliProviders" :key="entry.id" class="mobile-text-button" type="button"
        :disabled="busy || !cliProviderVisible(entry.id, hiddenCliProviderIds) || (connected && (!root || !availableProviders.some(p => p.providerKind === entry.id)))"
        :title="entry.name" @click="launch(entry.id)">
        <Cpu v-if="entry.icon === 'cpu'" :size="15" /><TerminalSquare v-else :size="15" />{{ entry.shortName }}
      </button>
      <button v-if="connected && root" class="mobile-icon-button" type="button" aria-label="更多选项" @click="moreMenuOpen = !moreMenuOpen"><MoreHorizontal :size="18" /></button>
    </div>
    <div v-if="moreMenuOpen" class="mobile-more-menu">
      <button class="mobile-text-button" :disabled="busy" @click="refresh(); moreMenuOpen = false"><RefreshCw :size="15" />刷新</button>
      <button class="mobile-text-button" :disabled="busy" @click="loadHistory(); moreMenuOpen = false">{{ showHistory ? '返回会话' : '历史对话' }}</button>
    </div>
    <div v-if="error || streamError" class="mobile-error" role="alert">{{ error || streamError }}</div>
    <div v-if="!showHistory && connected && root && visibleSessions.length" class="mobile-session-tabs" role="tablist" aria-label="会话列表">
      <div
        v-for="session in visibleSessions"
        :key="session.id"
        class="mobile-session-tab"
        :class="{ active: session.id === selectedId }"
      >
        <button type="button" role="tab" class="mobile-session-tab-select" :aria-selected="session.id === selectedId" :aria-label="session.id" :title="session.id" @click="selectedId = session.id">
        <Cpu v-if="session.providerKind !== 'local'" :size="14" />
        <TerminalSquare v-else :size="14" />
        <span class="mobile-session-tab-label">{{ session.id.slice(0, 8) }}</span>
        </button>
        <button
          type="button"
          class="mobile-session-tab-close"
          :aria-label="`关闭 ${session.id}`"
          @click.stop="selectedId = session.id; closePending = true"
        >
          <X :size="13" />
        </button>
      </div>
    </div>
    <div v-if="closePending" class="mobile-close-confirm">
      <span>关闭会终止电脑上的此会话。</span>
      <button class="mobile-text-button" :disabled="busy" @click="closeSession">确认关闭</button>
      <button class="mobile-text-button" @click="closePending = false">取消</button>
    </div>
    <div v-if="showHistory" class="mobile-history">
      <template v-if="conversation">
        <div class="mobile-session-toolbar">
          <button class="mobile-text-button" @click="conversation = null">返回列表</button>
          <button class="mobile-text-button" :disabled="busy || !conversation.resumeSupported || !conversation.nativeSessionId || !cliProviderVisible(conversation.providerKind, hiddenCliProviderIds)" @click="resume(conversation)">继续对话</button>
        </div>
        <article v-for="message in conversation.messages" :key="message.id" class="mobile-chat-message">
          <strong>{{ message.role === 'user' ? '你' : cliProviderLabel(conversation.providerKind) }}</strong>
          <pre>{{ message.content }}</pre>
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
    <div v-show="!showHistory" class="mobile-terminal-area">
      <div v-if="!activeSession" class="mobile-terminal-empty">{{ !connected ? 'Super High · 工作区终端' : !root ? '从资源管理器选择工作区' : '选择已有会话，或点击上方 CLI 开始' }}</div>
      <div ref="terminalHost" class="mobile-terminal" :class="{ 'is-empty': !activeSession }" aria-label="会话输出" @click="clickTerminal" />
    </div>
    <form v-if="!showHistory" class="mobile-session-input" :class="{ 'is-focused': inputFocused }" @submit.prevent="sendDraft">
      <div class="mobile-compose-row">
        <textarea ref="draftInput" v-model="draft" aria-label="消息" placeholder="输入消息或使用语音输入" :rows="inputFocused ? 4 : 2" @focus="focusDraft" @blur="inputFocused = false; scheduleFit()" />
        <div class="mobile-compose-actions">
          <button class="mobile-icon-button" type="button" aria-label="添加附件" title="添加附件" :aria-expanded="attachmentPanelOpen" :disabled="sending" @click="toggleAttachments"><Plus :size="20" /></button>
          <button class="mobile-icon-button" type="button" aria-label="唤起指令" title="打开 CLI 指令菜单" :aria-expanded="commandControlsOpen" :disabled="!running || sending || commandControlsOpen" @click="openCommands"><Slash :size="19" /></button>
          <button class="mobile-icon-button" type="button" :aria-label="voiceButtonTitle" :title="voiceButtonTitle" :aria-pressed="isVoiceListening" :disabled="!voiceInputAvailable" @click="toggleVoiceInput"><Mic :size="19" /></button>
          <button class="mobile-icon-button mobile-send-button" type="submit" aria-label="发送" :disabled="!running || sending || !attachmentsReady || (!draft.trim() && !attachments.length)"><Send :size="18" /></button>
        </div>
      </div>
      <div v-if="commandControlsOpen" class="mobile-command-controls" aria-label="CLI 指令操作">
        <button class="mobile-text-button" type="button" :disabled="sending" aria-label="上一条指令" @click="commandKey('\u001b[A')">↑</button>
        <button class="mobile-text-button" type="button" :disabled="sending" aria-label="下一条指令" @click="commandKey('\u001b[B')">↓</button>
        <button class="mobile-text-button" type="button" :disabled="sending" @click="commandKey('\r')">确认指令</button>
        <button class="mobile-text-button" type="button" :disabled="sending" @click="commandKey('\u001b')">退出指令</button>
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
