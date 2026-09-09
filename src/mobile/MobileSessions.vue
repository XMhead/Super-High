<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import { buildTerminalTheme } from '@/lib/theme'
import { CLI_PROVIDER_OPTIONS, cliProviderLabel } from '@/lib/cliProviders'
import type { CliNativeConversationDetail, CliNativeConversationSummary, CliProviderEnvironment, TerminalProviderKind, TerminalSession } from '@/types'

const props = defineProps<{ api: MobileHostApi; root: string; mode: 'terminal' | 'ai' }>()
const sessions = ref<TerminalSession[]>([])
const providers = ref<CliProviderEnvironment[]>([])
const provider = ref<TerminalProviderKind>('codex')
const selectedId = ref('')
const busy = ref(false)
const sending = ref(false)
const error = ref('')
const streamError = ref('')
const running = ref(false)
const draft = ref('')
const closePending = ref(false)
const showHistory = ref(false)
const history = ref<CliNativeConversationSummary[]>([])
const conversation = ref<CliNativeConversationDetail | null>(null)
const terminalHost = ref<HTMLDivElement | null>(null)
const isAiProvider = (kind: string) => CLI_PROVIDER_OPTIONS.some((entry) => entry.id === kind)
const availableProviders = computed(() => providers.value.filter((entry) => entry.available && isAiProvider(entry.providerKind)))
const visibleSessions = computed(() => sessions.value.filter((session) => inProject(session.cwd, props.root)
  && (props.mode === 'terminal' ? session.providerKind === 'local' : isAiProvider(session.providerKind))))
const activeSession = computed(() => visibleSessions.value.find((session) => session.id === selectedId.value))
let terminal: Terminal | undefined
let fit: FitAddon | undefined
let observer: ResizeObserver | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let cursor = 0
let disposed = false

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
  await act(async () => {
    sessions.value = await props.api.listTerminals()
    if (!activeSession.value) selectedId.value = visibleSessions.value[0]?.id ?? ''
  })
}

async function create() {
  await act(async () => {
    const session = await props.api.createTerminal(props.root, props.mode === 'terminal' ? 'local' : provider.value)
    sessions.value = [...sessions.value.filter((entry) => entry.id !== session.id), session]
    selectedId.value = session.id
    showHistory.value = false
  })
}

async function write(input: string, submit = false) {
  if (!activeSession.value || !running.value || sending.value) return false
  const id = selectedId.value
  sending.value = true
  error.value = ''
  try {
    await props.api.writeTerminal(id, input)
    if (submit) {
      // Interactive CLIs debounce fast paste; a separate Enter commits the prompt.
      await new Promise((resolve) => setTimeout(resolve, 250))
      await props.api.writeTerminal(id, '\r')
    }
    return true
  } catch (cause) {
    error.value = `发送失败，请检查输出；若文本已在输入框中，点击 Enter 提交：${formatError(cause)}`
    return false
  } finally { sending.value = false }
}

async function sendDraft() {
  if (!draft.value.trim()) return
  const value = draft.value
  // CLI prompts use bracketed paste for multiline text and a delayed Enter.
  const input = props.mode === 'ai' && /[\r\n]/.test(value)
    ? `\u001b[200~${value.replace(/\r\n/g, '\n')}\u001b[201~`
    : props.mode === 'ai' ? value : `${value.replace(/\r?\n/g, '\r')}\r`
  if (await write(input, props.mode === 'ai')) {
    if (draft.value === value) draft.value = ''
  }
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
  if (!entry.nativeSessionId) return
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
    if (snapshot.reset) terminal?.reset()
    if (snapshot.buffer && terminal) {
      await new Promise<void>((resolve) => terminal!.write(snapshot.buffer, resolve))
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

watch(selectedId, async () => {
  generation += 1
  const epoch = generation
  const id = selectedId.value
  clearTimeout(pollTimer)
  cursor = 0
  running.value = false
  closePending.value = false
  draft.value = ''
  streamError.value = ''
  terminal?.reset()
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
    fontSize: 12, fontFamily: '"Cascadia Code", Consolas, monospace',
    theme: buildTerminalTheme('dark'), scrollback: 4000, cursorBlink: false,
    disableStdin: true, convertEol: false,
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(terminalHost.value!)
  observer = new ResizeObserver(scheduleFit)
  observer.observe(terminalHost.value!)
  scheduleFit()
  await refresh()
  try {
    providers.value = await props.api.listProviders()
    if (!availableProviders.value.some((entry) => entry.providerKind === provider.value)) {
      provider.value = availableProviders.value[0]?.providerKind ?? 'codex'
    }
  } catch (cause) { error.value = formatError(cause) }
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
    <div class="mobile-session-toolbar">
      <select v-if="mode === 'ai'" v-model="provider" aria-label="AI 工具" :disabled="busy">
        <option v-for="entry in availableProviders" :key="entry.providerKind" :value="entry.providerKind">{{ entry.name }}</option>
        <option v-if="!availableProviders.length" value="codex" disabled>电脑未检测到 AI 工具</option>
      </select>
      <button class="mobile-text-button" :disabled="busy || (mode === 'ai' && !availableProviders.length)" @click="create">新建{{ mode === 'ai' ? '对话' : '终端' }}</button>
      <button class="mobile-text-button" :disabled="busy" @click="refresh">刷新</button>
      <button v-if="mode === 'ai'" class="mobile-text-button" :disabled="busy" :aria-pressed="showHistory" @click="loadHistory">{{ showHistory ? '返回会话' : '历史对话' }}</button>
    </div>
    <div v-if="error || streamError" class="mobile-error" role="alert">{{ error || streamError }}</div>
    <div v-show="!showHistory" class="mobile-session-toolbar">
      <select v-model="selectedId" class="mobile-session-select" aria-label="当前会话" :disabled="busy">
        <option value="" disabled>选择或新建{{ mode === 'ai' ? '对话' : '终端' }}</option>
        <option v-for="session in visibleSessions" :key="session.id" :value="session.id">{{ cliProviderLabel(session.providerKind) }} · {{ session.title }}</option>
      </select>
      <span v-if="activeSession" class="mobile-session-state">{{ running ? (streamError ? '重连中' : '运行中') : '已结束' }}</span>
      <button v-if="activeSession" class="mobile-text-button" :disabled="busy" @click="closePending = !closePending">关闭</button>
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
          <button class="mobile-text-button" :disabled="busy || !conversation.resumeSupported || !conversation.nativeSessionId" @click="resume(conversation)">继续对话</button>
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
      <div v-if="!activeSession" class="mobile-terminal-empty">{{ mode === 'ai' ? '选择电脑上的 AI 会话，或新建对话。' : '新建 PowerShell，或选择电脑上的终端。' }}</div>
      <div ref="terminalHost" class="mobile-terminal" :class="{ 'is-empty': !activeSession }" aria-label="会话输出" />
    </div>
    <form v-if="!showHistory" class="mobile-session-input" @submit.prevent="sendDraft">
      <div class="mobile-session-toolbar mobile-terminal-keys">
        <button v-for="key in [{ label: 'Enter', value: '\r' }, { label: 'Ctrl+C', value: '\u0003' }, { label: 'Esc', value: '\u001b' }, { label: 'Tab', value: '\t' }, { label: '↑', value: '\u001b[A' }, { label: '↓', value: '\u001b[B' }]" :key="key.label" type="button" class="mobile-text-button" :disabled="!running || sending" @click="write(key.value)">{{ key.label }}</button>
      </div>
      <div class="mobile-compose-row">
        <textarea v-model="draft" :aria-label="mode === 'ai' ? '消息' : '命令'" :placeholder="mode === 'ai' ? '输入消息，点击发送' : '输入 PowerShell 命令'" rows="2" :disabled="!activeSession || !running" />
        <button class="mobile-text-button" type="submit" :disabled="!running || sending || !draft.trim()">{{ sending ? '发送中' : '发送' }}</button>
      </div>
    </form>
  </section>
</template>
