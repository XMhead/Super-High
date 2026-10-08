<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  X,
} from 'lucide-vue-next'

import ClaudeIcon from './icons/ClaudeIcon.vue'
import CodexIcon from './icons/CodexIcon.vue'
import GeminiIcon from './icons/GeminiIcon.vue'
import GrokIcon from './icons/GrokIcon.vue'
import KimiIcon from './icons/KimiIcon.vue'
import OpenCodeIcon from './icons/OpenCodeIcon.vue'
import TerminalPane from '@/components/TerminalPane.vue'
import { CLI_PROVIDER_OPTIONS, cliProviderLabel } from '@/lib/cliProviders'
import { useWorkspaceStore } from '@/stores/workspace'
import type {
  CliNativeConversationDetail,
  CliNativeConversationSummary,
  TerminalProviderKind,
} from '@/types'

const store = useWorkspaceStore()
const selectedConversation = ref<CliNativeConversationSummary | null>(null)
const selectedDetail = ref<CliNativeConversationDetail | null>(null)
const detailLoading = ref(false)
const resumeLoading = ref(false)
const liveSessionId = ref<string | null>(null)
const page = ref(0)

const PRIMARY_PROVIDERS = ['claude', 'codex'] as const
const OTHER_PAGE_SIZE = 3

const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
const conversations = computed(() => (
  store.nativeCliConversationsRootPath === workspaceRoot.value
    ? store.nativeCliConversations
    : []
))
const recentConversations = computed(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  return conversations.value.filter((conversation) => {
    const updatedAt = new Date(conversation.updatedAt).getTime()
    return !Number.isNaN(updatedAt) && updatedAt >= cutoff
  })
})
const visibleConversations = computed(() => recentConversations.value.filter((conversation) => !isProbeConversation(conversation)))
const providerOrder = CLI_PROVIDER_OPTIONS.map((provider) => provider.id)
const otherProviders = computed(() => providerOrder.filter((provider) => !PRIMARY_PROVIDERS.includes(provider as typeof PRIMARY_PROVIDERS[number])))
const providerPages = computed(() => [...PRIMARY_PROVIDERS, ...otherProviders.value].filter((provider) => store.isCliProviderVisible(provider)))
const pageCount = computed(() => Math.max(1, Math.ceil(providerPages.value.length / OTHER_PAGE_SIZE)))
const currentProviders = computed(() => {
  const start = page.value * OTHER_PAGE_SIZE
  return providerPages.value.slice(start, start + OTHER_PAGE_SIZE)
})
const liveConversationIds = computed(() => new Set(
  store.terminalSessions
    .filter((session) => !session.restoredFromDisk && session.nativeConversationId)
    .map((session) => session.nativeConversationId as string),
))
const liveSession = computed(() => (
  liveSessionId.value
    ? store.terminalSessions.find((session) => session.id === liveSessionId.value) ?? null
    : null
))
const selectedProviderLabel = computed(() => (
  selectedConversation.value ? cliProviderLabel(selectedConversation.value.providerKind) : ''
))

function isProbeConversation(conversation: CliNativeConversationSummary): boolean {
  return conversation.messageCount <= 2 && conversation.title.trim().toLowerCase() === 'hi'
}

function conversationsFor(providerKind: string): CliNativeConversationSummary[] {
  return visibleConversations.value.filter((conversation) => conversation.providerKind === providerKind)
}

function providerLabel(providerKind: string): string {
  return CLI_PROVIDER_OPTIONS.find((provider) => provider.id === providerKind)?.name ?? providerKind
}

function providerClass(providerKind: string): string {
  return `provider-${providerKind}`
}

function refreshConversations() {
  void store.refreshNativeCliConversations()
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]')
}

function onWindowKeydown(event: KeyboardEvent) {
  if (isEditableTarget(event.target) || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  if (event.key === 'ArrowLeft' && page.value > 0) {
    event.preventDefault()
    page.value -= 1
  }
  if (event.key === 'ArrowRight' && page.value < pageCount.value - 1) {
    event.preventDefault()
    page.value += 1
  }
}

async function openConversation(conversation: CliNativeConversationSummary) {
  selectedConversation.value = conversation
  selectedDetail.value = null
  liveSessionId.value = null
  detailLoading.value = true
  try {
    selectedDetail.value = await store.readNativeCliConversation(conversation)
  } finally {
    detailLoading.value = false
  }
}

async function resumeConversation(conversation = selectedConversation.value) {
  if (!conversation || resumeLoading.value) return
  const openedFromInspector = selectedConversation.value?.id === conversation.id
  resumeLoading.value = true
  try {
    const session = await store.resumeNativeCliConversation(conversation)
    if (session) {
      liveSessionId.value = session.id
      if (!openedFromInspector) {
        selectedConversation.value = null
        selectedDetail.value = null
      }
    }
  } finally {
    resumeLoading.value = false
  }
}

function closeInspector() {
  selectedConversation.value = null
  selectedDetail.value = null
  liveSessionId.value = null
}

function closeLiveTerminal() {
  liveSessionId.value = null
}

function formatDate(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return ''
  return time.toLocaleString('zh-CN', { hour12: false })
}

watch(workspaceRoot, () => {
  closeInspector()
  refreshConversations()
})

watch(pageCount, (count) => {
  page.value = Math.min(page.value, count - 1)
})

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  refreshConversations()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <section class="conversation-management-panel" aria-label="对话管理">
    <header class="conversation-management-toolbar">
      <div class="conversation-management-title">
        <TerminalSquare :size="15" />
        <span>对话管理</span>
      </div>
      <div class="conversation-management-toolbar-actions">
        <button
          type="button"
          class="conversation-management-tool-button"
          title="刷新本机对话"
          :disabled="store.nativeCliConversationsLoading"
          @click="refreshConversations"
        >
          <LoaderCircle v-if="store.nativeCliConversationsLoading" class="conversation-management-spinning" :size="15" />
          <RefreshCw v-else :size="15" />
        </button>
      </div>
    </header>

    <div class="conversation-management-body">
      <div v-if="visibleConversations.length || currentProviders.length" class="conversation-provider-grid">
        <section
          v-for="providerKind in currentProviders"
          :key="providerKind"
          class="conversation-provider-column"
          :class="providerClass(providerKind)"
        >
          <header class="conversation-provider-header">
            <ClaudeIcon v-if="providerKind === 'claude'" :size="16" />
            <CodexIcon v-else-if="providerKind === 'codex'" :size="16" />
            <KimiIcon v-else-if="providerKind === 'kimi'" :size="16" />
            <GrokIcon v-else-if="providerKind === 'grok'" :size="16" />
            <GeminiIcon v-else-if="providerKind === 'gemini'" :size="16" />
            <OpenCodeIcon v-else-if="providerKind === 'opencode'" :size="16" />
            <TerminalSquare v-else :size="16" />
            <strong>{{ providerLabel(providerKind) }}</strong>
            <span>{{ conversationsFor(providerKind).length }}</span>
          </header>
          <div v-if="conversationsFor(providerKind).length" class="conversation-provider-list">
            <article
              v-for="conversation in conversationsFor(providerKind)"
              :key="conversation.id"
              class="conversation-map-card"
              :class="[providerClass(conversation.providerKind), { live: liveConversationIds.has(conversation.id) }]"
            >
              <button
                type="button"
                class="conversation-map-card-content"
                :title="`恢复 ${conversation.title}`"
                @click="resumeConversation(conversation)"
              >
                <div class="conversation-map-card-title-line">
                  <strong>{{ conversation.title }}</strong>
                  <span v-if="liveConversationIds.has(conversation.id)" class="conversation-map-live-state">运行中</span>
                </div>
                <span>{{ conversation.summary }}</span>
              </button>
              <footer class="conversation-map-card-footer">
                <span>{{ formatDate(conversation.updatedAt) }}</span>
                <div class="conversation-map-card-actions">
                  <button type="button" class="conversation-map-action-button" title="查看完整记录" @click="openConversation(conversation)">
                    <Info :size="14" />
                  </button>
                  <button
                    type="button"
                    class="conversation-map-action-button"
                    :disabled="!conversation.resumeSupported || !store.isCliProviderVisible(conversation.providerKind)"
                    :title="conversation.resumeSupported ? '恢复此对话' : '缺少可恢复的会话标识'"
                    @click="resumeConversation(conversation)"
                  >
                    <RotateCcw :size="14" />
                  </button>
                </div>
              </footer>
            </article>
          </div>
          <div v-else class="conversation-provider-empty">没有最近对话</div>
        </section>
      </div>
      <div v-else-if="!store.nativeCliConversationsLoading" class="conversation-management-empty">
        当前工作区没有可显示的原生 CLI 对话
      </div>
    </div>

    <aside v-if="selectedConversation && !liveSessionId" class="conversation-management-inspector">
      <header class="conversation-management-inspector-header">
        <div>
          <span class="conversation-management-provider-label">{{ selectedProviderLabel }}</span>
          <strong>{{ selectedConversation.title }}</strong>
        </div>
        <button type="button" class="conversation-management-tool-button" title="关闭详情" @click="closeInspector">
          <X :size="15" />
        </button>
      </header>
      <div v-if="detailLoading" class="conversation-management-detail-state">
        <LoaderCircle class="conversation-management-spinning" :size="18" />
      </div>
      <template v-else>
        <div class="conversation-management-detail-actions">
          <button
            v-if="store.isCliProviderVisible(selectedConversation.providerKind)"
            class="primary-button small"
            :disabled="resumeLoading || !selectedConversation.resumeSupported"
            @click="resumeConversation()"
          >
            <LoaderCircle v-if="resumeLoading" class="conversation-management-spinning" :size="13" />
            <RotateCcw v-else :size="13" />
            <span>{{ resumeLoading ? '恢复中' : '恢复对话' }}</span>
          </button>
        </div>
        <div v-if="selectedDetail?.messages.length" class="conversation-management-message-list">
          <article v-for="message in selectedDetail.messages" :key="message.id" class="conversation-management-message" :class="message.role">
            <header>
              <span>{{ message.role === 'user' ? '你' : selectedProviderLabel }}</span>
              <time>{{ formatDate(message.timestamp) }}</time>
            </header>
            <div>{{ message.content }}</div>
          </article>
        </div>
        <div v-else class="conversation-management-detail-state">没有可显示的对话文本</div>
      </template>
    </aside>

    <section v-if="liveSession" class="conversation-management-live" aria-label="已恢复的 CLI 对话">
      <header class="conversation-management-live-header">
        <div>
          <span>{{ cliProviderLabel(liveSession.providerKind as TerminalProviderKind) }}</span>
          <strong>{{ liveSession.name || liveSession.title }}</strong>
        </div>
        <button type="button" class="conversation-management-tool-button" title="收起终端" @click="closeLiveTerminal">
          <X :size="15" />
        </button>
      </header>
      <TerminalPane class="conversation-management-live-terminal" mode="cli" :session-ids="[liveSession.id]" :active-session-id="liveSession.id" />
    </section>
  </section>
</template>

<style scoped>
.conversation-management-panel {
  grid-column: 2 / -1;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.conversation-management-toolbar,
.conversation-management-title,
.conversation-management-toolbar-actions,
.conversation-provider-header,
.conversation-map-card-footer,
.conversation-map-card-title-line,
.conversation-management-inspector-header,
.conversation-management-live-header,
.conversation-management-detail-actions,
.conversation-management-message header {
  display: flex;
  align-items: center;
}

.conversation-management-toolbar {
  height: 42px;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.conversation-management-title {
  min-width: 0;
  gap: 6px;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
}

.conversation-management-title > svg { color: var(--color-accent-blue); }

.conversation-map-live-state {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.conversation-management-tool-button,
.conversation-map-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.conversation-management-tool-button:hover,
.conversation-map-action-button:hover:not(:disabled) {
  border-color: var(--color-border);
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.conversation-management-tool-button:disabled,
.conversation-map-action-button:disabled {
  cursor: not-allowed;
  opacity: .45;
}

.conversation-management-body {
  height: calc(100% - 42px);
  overflow: auto;
  padding: 14px;
}

.conversation-management-body,
.conversation-provider-list,
.conversation-management-message-list {
  scrollbar-width: thin;
  scrollbar-color: var(--color-text-muted) var(--color-bg-primary);
}

.conversation-management-body::-webkit-scrollbar,
.conversation-provider-list::-webkit-scrollbar,
.conversation-management-message-list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.conversation-management-body::-webkit-scrollbar-track,
.conversation-provider-list::-webkit-scrollbar-track,
.conversation-management-message-list::-webkit-scrollbar-track {
  background: var(--color-bg-primary);
}

.conversation-management-body::-webkit-scrollbar-thumb,
.conversation-provider-list::-webkit-scrollbar-thumb,
.conversation-management-message-list::-webkit-scrollbar-thumb {
  border: 2px solid var(--color-bg-primary);
  border-radius: 6px;
  background: var(--color-text-muted);
}

.conversation-management-body::-webkit-scrollbar-thumb:hover,
.conversation-provider-list::-webkit-scrollbar-thumb:hover,
.conversation-management-message-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-accent-blue);
}

.conversation-provider-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(220px, 1fr));
  align-items: start;
  gap: 12px;
}

.conversation-provider-column {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--surface-card-border);
  border-top: 3px solid var(--color-accent-blue);
  border-radius: 6px;
  background: var(--color-bg-secondary);
}

.conversation-provider-column.provider-claude { border-top-color: var(--color-accent-purple); }
.conversation-provider-column.provider-codex { border-top-color: var(--color-accent-blue); }
.conversation-provider-column.provider-kimi { border-top-color: var(--color-accent-yellow); }
.conversation-provider-column.provider-grok { border-top-color: var(--color-accent-red); }
.conversation-provider-column.provider-gemini { border-top-color: var(--color-accent-purple); }
.conversation-provider-column.provider-opencode { border-top-color: var(--color-accent-green); }

.conversation-provider-header {
  min-height: 40px;
  gap: 7px;
  padding: 0 10px;
  border-bottom: 1px solid var(--surface-divider-muted);
  color: var(--color-text-primary);
  font-size: 12px;
}

.conversation-provider-header strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-provider-header > span {
  margin-left: auto;
  color: var(--color-text-secondary);
  font-size: 11px;
}

.conversation-provider-list {
  display: grid;
  gap: 1px;
  max-height: calc(100vh - 160px);
  overflow: auto;
}

.conversation-map-card {
  display: grid;
  grid-template-rows: minmax(149px, auto) 31px;
  min-height: 180px;
  border-bottom: 1px solid var(--surface-divider-muted);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

.conversation-map-card:last-child { border-bottom: 0; }
.conversation-map-card.live { box-shadow: inset 3px 0 var(--color-accent-green); }

.conversation-map-card-content {
  display: grid;
  align-content: start;
  gap: 7px;
  min-width: 0;
  padding: 10px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.conversation-map-card-content:hover { background: var(--color-bg-hover); }

.conversation-map-card-title-line {
  justify-content: space-between;
  gap: 8px;
}

.conversation-map-card-title-line strong {
  display: -webkit-box;
  min-width: 0;
  padding: 3px 6px;
  overflow: hidden;
  border: 1px solid var(--surface-accent-blue-border);
  border-radius: 3px;
  background: var(--surface-accent-blue-bg);
  color: var(--color-accent-blue);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.42;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.conversation-map-card.provider-claude .conversation-map-card-title-line strong,
.conversation-map-card.provider-gemini .conversation-map-card-title-line strong {
  color: var(--color-accent-purple);
}

.conversation-map-card.provider-opencode .conversation-map-card-title-line strong {
  color: var(--color-accent-green);
}

.conversation-map-card.provider-kimi .conversation-map-card-title-line strong {
  color: var(--color-accent-yellow);
}

.conversation-map-card.provider-grok .conversation-map-card-title-line strong {
  color: var(--color-accent-red);
}

.conversation-map-card-content > span {
  display: -webkit-box;
  overflow: hidden;
  text-align: left;
  color: var(--color-text-secondary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  font-size: 11px;
  line-height: 1.42;
}

.conversation-map-live-state {
  flex: none;
  color: var(--color-accent-green);
}

.conversation-map-card-footer {
  justify-content: space-between;
  gap: 6px;
  padding: 0 7px 0 10px;
  border-top: 1px solid var(--surface-divider-muted);
  color: var(--color-text-muted);
  font-size: 10px;
}

.conversation-map-card-footer > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-map-card-actions { display: inline-flex; gap: 2px; }
.conversation-map-action-button { width: 25px; height: 25px; }

.conversation-provider-empty,
.conversation-management-empty,
.conversation-management-detail-state {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.conversation-provider-empty { padding: 18px 10px; color: var(--color-text-muted); }

.conversation-management-empty {
  display: grid;
  min-height: 180px;
  place-items: center;
}

.conversation-management-inspector,
.conversation-management-live {
  position: absolute;
  z-index: 5;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
}

.conversation-management-inspector {
  top: 54px;
  right: 14px;
  bottom: 14px;
  width: min(430px, calc(100% - 28px));
  display: grid;
  grid-template-rows: 52px auto minmax(0, 1fr);
}

.conversation-management-inspector-header,
.conversation-management-live-header {
  justify-content: space-between;
  gap: 10px;
  padding: 0 10px;
  border-bottom: 1px solid var(--surface-divider-muted);
}

.conversation-management-inspector-header > div,
.conversation-management-live-header > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.conversation-management-inspector-header strong,
.conversation-management-live-header strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-management-provider-label,
.conversation-management-live-header span {
  color: var(--color-text-secondary);
  font-size: 10px;
}

.conversation-management-detail-actions {
  justify-content: flex-end;
  padding: 8px 10px;
  border-bottom: 1px solid var(--surface-divider-muted);
}

.conversation-management-message-list {
  min-height: 0;
  overflow: auto;
  padding: 10px;
}

.conversation-management-message {
  padding: 9px 0;
  border-bottom: 1px solid var(--surface-divider-muted);
}

.conversation-management-message:last-child { border-bottom: 0; }

.conversation-management-message header {
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
  color: var(--color-text-secondary);
  font-size: 10px;
}

.conversation-management-message.assistant header > span { color: var(--color-accent-blue); }

.conversation-management-message div {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 1.5;
}

.conversation-management-detail-state {
  display: grid;
  min-height: 100px;
  place-items: center;
}

.conversation-management-live {
  inset: 54px 28px 24px;
  display: grid;
  grid-template-rows: 42px minmax(0, 1fr);
}

.conversation-management-live-terminal { min-height: 0; border: 0; }
.conversation-management-spinning { animation: conversation-management-spin .8s linear infinite; }

@keyframes conversation-management-spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .conversation-provider-grid { grid-template-columns: 1fr; }
  .conversation-provider-list { max-height: none; }
}
</style>
