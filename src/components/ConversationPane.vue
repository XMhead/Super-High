<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Mic, MicOff, RotateCcw, Send } from 'lucide-vue-next'

import { appendVoiceText, useVoiceInput } from '@/lib/voiceInput'
import { collectCliHistoryMessages, mergeHistoryMessages } from '@/lib/historyTabCompletion'
import { useHistoryTabCompletion } from '@/lib/useHistoryTabCompletion'
import HistoryCompletionPopup from '@/components/HistoryCompletionPopup.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
// Keep the completion implementation in place for a later re-enable, but do not
// let it affect the current conversation input.
const conversationInputTabCompletionEnabled = false
const draftInputRef = ref<HTMLTextAreaElement | null>(null)
const activeSession = computed(() => store.activeCliTerminalSession)
const activeMessages = computed(() => {
  const sessionId = activeSession.value?.id
  return sessionId ? (store.terminalConversation[sessionId] ?? []) : []
})
const draft = computed({
  get: () => activeSession.value ? store.terminalDrafts[activeSession.value.id] ?? '' : '',
  set: (value: string) => {
    if (activeSession.value) store.setTerminalDraft(activeSession.value.id, value)
  },
})
const isEnded = computed(() => {
  const sessionId = activeSession.value?.id
  return !!sessionId && store.terminalExitCodes[sessionId] != null
})
const inputHistory = computed(() => {
  const messages = Object.values(store.terminalConversation)
    .flat()
    .filter((message) => message.role === 'user' && !!message.content.trim())
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))

  return messages.slice(0, 50).map((message) => message.content)
})
let inputHistoryIndex: number | null = null
let draftBeforeHistory = ''
const historyMessages = computed(() => mergeHistoryMessages(
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
  history: () => historyMessages.value,
  extraPaths: () => store.cliHistoryPaths,
  getDraft: () => draft.value,
  getCursorOffset: () => draftInputRef.value?.selectionStart ?? draft.value.length,
  applyDraft: (text, cursorOffset) => {
    draft.value = text
    if (cursorOffset !== undefined) {
      void nextTick(() => {
        const el = draftInputRef.value
        if (el) {
          el.focus()
          el.setSelectionRange(cursorOffset, cursorOffset)
        }
      })
    }
  },
})
const historyNoMatchHint = ref('')
let historyNoMatchTimer: number | null = null
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
  focusInput,
  appendText: (text) => {
    draft.value = appendVoiceText(draft.value, text)
    if (conversationInputTabCompletionEnabled) refreshHistoryPopup()
    else closeHistoryPopup()
  },
})
const sessionTitle = computed(() => {
  if (!activeSession.value) return '会话'
  const latest = activeMessages.value[activeMessages.value.length - 1]
  const time = latest
    ? new Date(latest.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
    : new Date().toLocaleTimeString('zh-CN', { hour12: false })
  return `会话 ${time}`
})

function onDraftInput(event: Event) {
  draft.value = (event.target as HTMLTextAreaElement).value
  inputHistoryIndex = null
  if (conversationInputTabCompletionEnabled) refreshHistoryPopup()
  else closeHistoryPopup()
}

function browseInputHistory(direction: -1 | 1) {
  const history = inputHistory.value
  if (!history.length) return

  if (direction === -1) {
    if (inputHistoryIndex === null) {
      draftBeforeHistory = draft.value
      inputHistoryIndex = 0
    } else if (inputHistoryIndex < history.length - 1) {
      inputHistoryIndex += 1
    } else {
      return
    }
  } else {
    if (inputHistoryIndex === null) return
    if (inputHistoryIndex === 0) {
      inputHistoryIndex = null
      draft.value = draftBeforeHistory
      return
    }
    inputHistoryIndex -= 1
  }

  draft.value = history[inputHistoryIndex]
  void nextTick(() => {
    const input = draftInputRef.value
    if (input) input.setSelectionRange(input.value.length, input.value.length)
  })
}

function onDraftKeydown(event: KeyboardEvent) {
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp')
    && inputHistory.value.length
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
    event.preventDefault()
    browseInputHistory(event.key === 'ArrowUp' ? -1 : 1)
    return
  }
  if (conversationInputTabCompletionEnabled
    && historyPopupOpen.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    moveHistoryPopup(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (conversationInputTabCompletionEnabled && historyPopupOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeHistoryPopup()
    return
  }
  if (conversationInputTabCompletionEnabled && (event.key === 'Tab' || event.code === 'Tab')
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
      const hintText = refreshHistoryPopup()
      if (hintText) showHistoryNoMatchHint(hintText)
    }
    return
  }
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void sendDraft()
}

async function sendDraft() {
  if (!activeSession.value || !draft.value.trim()) return
  closeHistoryPopup()
  inputHistoryIndex = null
  await store.sendTerminalConversationMessage(activeSession.value.id, draft.value)
}

function resumeSession() {
  if (!activeSession.value) return
  store.terminalExitCodes[activeSession.value.id] = null
}

async function focusInput() {
  await nextTick()
  draftInputRef.value?.focus()
}
</script>

<template>
  <section class="conversation-pane">
    <div class="conversation-tab-strip">
      <button class="conversation-tab active">
        <span class="tab-clock">◷</span>
        <span>{{ sessionTitle }}</span>
      </button>
    </div>

    <div v-if="activeSession" class="conversation-body">
      <div v-if="activeMessages.length" class="conversation-message-list">
        <div
          v-for="message in activeMessages"
          :key="message.id"
          class="conversation-message"
          :class="message.role"
        >
          <div class="message-author">{{ message.role === 'user' ? '幸运' : '系统' }}</div>
          <div class="message-content">{{ message.content }}</div>
        </div>
      </div>
    </div>
    <div v-else class="conversation-body empty">
      <div>从左侧“新增对话”开始。</div>
    </div>

    <div v-if="activeSession && isEnded" class="conversation-ended">
      <span>会话已结束</span>
      <button class="restore-session-button" @click="resumeSession">
        <RotateCcw :size="13" />
        <span>恢复会话继续对话</span>
      </button>
    </div>
    <div v-else-if="activeSession" class="conversation-input-area">
      <div class="conversation-input-stack">
        <HistoryCompletionPopup
          v-if="conversationInputTabCompletionEnabled && historyPopupOpen"
          :candidates="historyCandidates"
          :selected-index="historySelectedIndex"
          :counts="historyCandidateCounts"
          :labels="historyCandidateLabels"
          @select="moveToHistoryPopup"
          @confirm="confirmHistoryPopup"
        />
        <textarea
          ref="draftInputRef"
          :value="draft"
          class="conversation-input"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          rows="2"
          @input="onDraftInput"
          @keydown="onDraftKeydown"
        />
        <div v-if="voiceStatusMessage" class="conversation-voice-status">{{ voiceStatusMessage }}</div>
        <div v-if="historyNoMatchHint" class="conversation-voice-status history-no-match">{{ historyNoMatchHint }}</div>
      </div>
      <div class="conversation-input-actions">
        <button
          type="button"
          class="conversation-voice-button"
          :class="{ listening: isVoiceListening }"
          :disabled="!voiceInputAvailable || voiceInputState === 'starting'"
          :title="voiceButtonTitle"
          @click="toggleVoiceInput"
        >
          <MicOff v-if="isVoiceListening" :size="14" />
          <Mic v-else :size="14" />
        </button>
        <button class="primary-button small" :disabled="!draft.trim()" @click="sendDraft">
          <Send :size="13" />
          <span>发送</span>
        </button>
      </div>
    </div>
  </section>
</template>
