<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Mic, MicOff, RotateCcw, Send } from 'lucide-vue-next'

import { appendVoiceText, useVoiceInput } from '@/lib/voiceInput'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
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
}

function onDraftKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void sendDraft()
}

async function sendDraft() {
  if (!activeSession.value || !draft.value.trim()) return
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
