<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Copy, Send, Timer, Trash2, X } from 'lucide-vue-next'
import SkillCompletionPopup from './SkillCompletionPopup.vue'
import { addSkillInvocation, formatSkillMessage, matchSkillCandidates, skillInvocationFromCandidate, skillKind, skillQueryFromDraft, SKILL_CATEGORIES, type SkillCategory, type SkillInvocationState } from '@/lib/skillsCompletion'
import type { SkillCompletionItem } from '@/types'
import { memoTitleColor } from '@/lib/theme'
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
  skills?: SkillCompletionItem[]
  skillStatus?: string
}>()
const emit = defineEmits<{ 'load-skills': [] }>()

const store = useWorkspaceStore()
const text = ref('')
const invocations = ref<SkillInvocationState[]>([])
const completionOpen = ref(false)
const selectedIndex = ref(0)
const category = ref<SkillCategory>('all')
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
const message = computed(() => formatSkillMessage(invocations.value, text.value))
const canSchedule = computed(() => !!message.value && delayMinutes.value !== null && !blocked.value)
const candidates = computed(() => {
  const query = skillQueryFromDraft(text.value)
  if (query === null) return []
  const selected = new Set(invocations.value.map((skill) => skill.path))
  return matchSkillCandidates(props.skills ?? [], query, store.settings.skillScopeOrder)
    .filter((skill) => !selected.has(skill.path) && (category.value === 'all' || skillKind(skill) === category.value))
})
watch(candidates, () => { selectedIndex.value = 0 })

function refreshCompletion() {
  const wasOpen = completionOpen.value
  completionOpen.value = !blocked.value && skillQueryFromDraft(text.value, textInput.value?.selectionStart ?? text.value.length) !== null
  if (completionOpen.value && !wasOpen) emit('load-skills')
}

function confirmCompletion(index = selectedIndex.value) {
  const candidate = candidates.value[index]
  if (!candidate || blocked.value) return
  if (candidate.path.startsWith('cli:')) text.value = `/${candidate.name}`
  else if (candidate.commandId) text.value = candidate.content ?? ''
  else {
    invocations.value = addSkillInvocation(invocations.value, skillInvocationFromCandidate(candidate))
    text.value = ''
  }
  completionOpen.value = false
  void nextTick(() => textInput.value?.focus())
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || !completionOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    completionOpen.value = false
  } else if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter' || event.key === 'Tab') confirmCompletion()
    else if (candidates.value.length) selectedIndex.value = (selectedIndex.value + (event.key === 'ArrowDown' ? 1 : candidates.value.length - 1)) % candidates.value.length
  } else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault()
    event.stopPropagation()
    const index = SKILL_CATEGORIES.findIndex((item) => item.id === category.value)
    category.value = SKILL_CATEGORIES[(index + (event.key === 'ArrowRight' ? 1 : SKILL_CATEGORIES.length - 1)) % SKILL_CATEGORIES.length].id
  }
}

function useDraft() {
  invocations.value = []
  text.value = props.draft
  refreshCompletion()
}

function resetEditor() {
  editingId.value = ''
  text.value = ''
  invocations.value = []
  completionOpen.value = false
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
  invocations.value = []
  completionOpen.value = false
  hours.value = Math.floor(remaining / 60)
  minutes.value = remaining % 60
  void nextTick(() => textInput.value?.focus())
}

function schedule() {
  if (!canSchedule.value || delayMinutes.value === null) return
  if (store.scheduleTerminalMessage(props.sessionId, message.value, delayMinutes.value, editingId.value || undefined)) resetEditor()
}

async function sendNow() {
  if (!editingId.value || !message.value || sending.value) return
  const sessionId = props.sessionId
  const id = editingId.value
  sending.value = true
  try {
    const sent = await store.sendScheduledTerminalMessage(sessionId, id, message.value)
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
    <div class="cli-schedule-editor">
    <SkillCompletionPopup
      v-if="completionOpen && !blocked"
      :candidates="candidates"
      :selected-index="selectedIndex"
      :category="category"
      :status="skillStatus"
      @select="selectedIndex = $event"
      @confirm="confirmCompletion"
      @category="category = $event"
      @preview="store.openTerminalFileLink(candidates[$event].path)"
    />
    <div v-if="invocations.length" class="skill-invocation-list">
      <span v-for="(skill, index) in invocations" :key="skill.path" class="skill-invocation-chip" :title="skill.path" :style="{ color: memoTitleColor(skill.path), borderColor: memoTitleColor(skill.path) }">
        <span class="skill-invocation-command">/{{ skill.name }}</span>
        <button type="button" class="skill-invocation-remove" :aria-label="`移除 ${skill.name}`" :disabled="blocked" @click="invocations.splice(index, 1)"><X :size="12" /></button>
      </span>
    </div>
    <textarea
      ref="textInput"
      v-model="text"
      class="cli-phrase-text-input"
      rows="3"
      placeholder="预存消息，到时自动发送到当前 CLI 会话"
      :disabled="blocked"
      data-testid="terminal-scheduled-text"
      @input="refreshCompletion"
      @click="refreshCompletion"
      @keydown="onKeydown"
    />
    </div>
    <div class="cli-schedule-controls">
      <button
        type="button"
        class="cli-phrase-fill-button"
        :disabled="!draft.trim() || blocked"
        @click="useDraft"
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
        :disabled="!message || sending"
        data-testid="terminal-scheduled-send-now"
        @click="sendNow"
      >
        <Send :size="13" />
        <span>{{ sending ? '发送中…' : '立即发送' }}</span>
      </button>
      <button
        type="button"
        class="cli-phrase-fill-button"
        :disabled="!message"
        data-testid="terminal-scheduled-copy"
        @click="copy(message)"
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

<style scoped>
.cli-schedule-editor { position: relative; min-width: 0; }
.cli-schedule-editor > textarea { width: 100%; box-sizing: border-box; }
.cli-schedule-editor > :deep(.skill-completion-popup) { width: 100%; box-shadow: none; }
</style>
