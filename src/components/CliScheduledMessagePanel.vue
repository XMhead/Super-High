<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Copy, Send, Timer, Trash2 } from 'lucide-vue-next'
import {
  formatScheduledClock,
  formatScheduledCountdown,
  scheduledDelayMinutes,
  SCHEDULED_MESSAGE_LIMIT,
  SCHEDULED_MESSAGE_MAX_MINUTES,
  type ScheduledTerminalMessage,
} from '@/lib/scheduledMessages'
import { useWorkspaceStore } from '@/stores/workspace'

const props = defineProps<{
  sessionId: string
  draft: string
}>()

const store = useWorkspaceStore()
const text = ref('')
const hours = ref(0)
const minutes = ref(1)
const editingId = ref('')
const textInput = ref<HTMLTextAreaElement | null>(null)
const sending = ref(false)
const now = ref(Date.now())
const ticker = window.setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => window.clearInterval(ticker))

const items = computed(() => store.scheduledTerminalMessages[props.sessionId] ?? [])
const delayMinutes = computed(() => scheduledDelayMinutes(hours.value, minutes.value))
const full = computed(() => items.value.length >= SCHEDULED_MESSAGE_LIMIT)
const blocked = computed(() => sending.value || (full.value && !editingId.value))
const canSchedule = computed(() => !!text.value.trim() && delayMinutes.value !== null && !blocked.value)

function resetEditor() {
  editingId.value = ''
  text.value = ''
  hours.value = 0
  minutes.value = 1
}

watch(() => props.sessionId, resetEditor)
watch(items, (queue) => {
  if (editingId.value && !sending.value && !queue.some((item) => item.id === editingId.value)) resetEditor()
})

function edit(item: ScheduledTerminalMessage) {
  if (sending.value) return
  const remaining = Math.max(1, Math.ceil((item.dueAt - Date.now()) / 60_000))
  editingId.value = item.id
  text.value = item.text
  hours.value = Math.floor(remaining / 60)
  minutes.value = remaining % 60
  void nextTick(() => textInput.value?.focus())
}

function schedule() {
  if (!canSchedule.value || delayMinutes.value === null) return
  if (store.scheduleTerminalMessage(props.sessionId, text.value, delayMinutes.value, editingId.value || undefined)) resetEditor()
}

async function sendNow() {
  if (!editingId.value || !text.value.trim() || sending.value) return
  const sessionId = props.sessionId
  const id = editingId.value
  sending.value = true
  try {
    const sent = await store.sendScheduledTerminalMessage(sessionId, id, text.value)
    if (props.sessionId !== sessionId || editingId.value !== id) return
    if (sent) resetEditor()
    else editingId.value = '' // 发送失败时保留正文，仍可复制或重新定时。
  } finally {
    sending.value = false
  }
}

async function copy(content: string) {
  if (!content.trim()) return
  try {
    await navigator.clipboard.writeText(content)
    store.showActivityMessage('已复制消息')
  } catch {
    store.showErrorMessage('复制失败，请重试。')
  }
}
</script>

<template>
  <div class="cli-phrase-panel cli-schedule-panel" aria-label="定时发送" data-testid="terminal-scheduled-panel">
    <textarea
      ref="textInput"
      v-model="text"
      class="cli-phrase-text-input"
      rows="3"
      placeholder="预存消息，到时自动发送到当前 CLI 会话"
      :disabled="blocked"
      data-testid="terminal-scheduled-text"
    />
    <div class="cli-schedule-controls">
      <button
        type="button"
        class="cli-phrase-fill-button"
        :disabled="!draft.trim() || blocked"
        @click="text = draft"
      >
        使用当前输入
      </button>
      <label class="cli-schedule-delay">
        <input
          v-model.number="hours"
          class="cli-phrase-title-input cli-schedule-number"
          type="number"
          min="0"
          :max="SCHEDULED_MESSAGE_MAX_MINUTES / 60"
          aria-label="小时"
          :disabled="sending"
          data-testid="terminal-scheduled-hours"
        />
        <span>时</span>
        <input
          v-model.number="minutes"
          class="cli-phrase-title-input cli-schedule-number"
          type="number"
          min="0"
          max="59"
          aria-label="分钟"
          :disabled="sending"
          data-testid="terminal-scheduled-minutes"
        />
        <span>分后</span>
      </label>
      <button
        type="button"
        class="cli-phrase-save-button"
        :disabled="!canSchedule"
        :title="delayMinutes === null ? '时间需在 1 分钟到 6 小时之间' : editingId ? '保存修改，从现在重新计时' : '添加定时消息'"
        data-testid="terminal-scheduled-add"
        @click="schedule"
      >
        <Timer :size="13" />
        <span>{{ editingId ? '保存并重新计时' : `定时发送 ${items.length}/${SCHEDULED_MESSAGE_LIMIT}` }}</span>
      </button>
    </div>
    <div class="cli-schedule-controls">
      <button
        v-if="editingId"
        type="button"
        class="cli-phrase-save-button"
        :disabled="!text.trim() || sending"
        data-testid="terminal-scheduled-send-now"
        @click="sendNow"
      >
        <Send :size="13" />
        <span>{{ sending ? '发送中…' : '立即发送' }}</span>
      </button>
      <button
        type="button"
        class="cli-phrase-fill-button"
        :disabled="!text.trim()"
        data-testid="terminal-scheduled-copy"
        @click="copy(text)"
      >复制</button>
      <button
        v-if="editingId"
        type="button"
        class="cli-phrase-fill-button"
        :disabled="sending"
        data-testid="terminal-scheduled-edit-cancel"
        @click="resetEditor"
      >取消编辑</button>
    </div>
    <div v-if="delayMinutes === null" class="cli-schedule-hint">时间需在 1 分钟到 6 小时之间</div>
    <div v-if="items.length" class="cli-phrase-list">
      <div v-for="item in items" :key="item.id" class="cli-phrase-row cli-schedule-row" data-testid="terminal-scheduled-item">
        <button
          type="button"
          class="cli-schedule-item"
          :class="{ active: editingId === item.id }"
          :title="`点击编辑消息与时间：${item.text}`"
          :aria-label="`编辑定时消息：${item.text}`"
          :aria-pressed="editingId === item.id"
          :disabled="sending"
          data-testid="terminal-scheduled-edit"
          @click="edit(item)"
        >
          <span>{{ formatScheduledCountdown(item.dueAt - now) }} 后 · {{ formatScheduledClock(item.dueAt) }}</span>
          <small>{{ item.text }}</small>
        </button>
        <button
          type="button"
          class="cli-phrase-delete"
          title="复制消息"
          aria-label="复制消息"
          data-testid="terminal-scheduled-item-copy"
          @click="copy(item.text)"
        >
          <Copy :size="13" />
        </button>
        <button
          type="button"
          class="cli-phrase-delete"
          title="取消定时消息"
          data-testid="terminal-scheduled-cancel"
          @click="store.cancelScheduledTerminalMessage(sessionId, item.id)"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>
