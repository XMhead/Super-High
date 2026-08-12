<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  Check,
  Edit3,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import type { TerminalSession } from '@/types'

const store = useWorkspaceStore()
const sessions = computed(() => store.cliTerminalSessions)
const editingId = ref<string | null>(null)
const editingName = ref('')
const busyId = ref<string | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const dragOverSessionId = ref<string | null>(null)

// ---- session management (unchanged) ----
function sessionTitle(session: TerminalSession, index: number): string {
  const trimmed = session.name?.trim()
  return trimmed || `对话 ${index + 1}`
}

function statusClass(session: TerminalSession): string {
  if (store.terminalExitCodes[session.id] != null) return 'error'
  return 'running'
}

function openNewConversation() {
  store.setNewConversationDialogOpen(true)
}

function startEditing(session: TerminalSession, index: number) {
  editingId.value = session.id
  editingName.value = sessionTitle(session, index)
  void nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

function cancelEditing() {
  editingId.value = null
  editingName.value = ''
}

function commitEditing() {
  const sessionId = editingId.value
  if (!sessionId) return
  const trimmed = editingName.value.trim()
  if (trimmed) store.renameTerminalSession(sessionId, trimmed)
  cancelEditing()
}

async function deleteConversation(sessionId: string) {
  busyId.value = sessionId
  try {
    await store.closeTerminalSession(sessionId)
  } finally {
    busyId.value = null
  }
}

function onConversationDragStart(event: DragEvent, sessionId: string) {
  event.dataTransfer?.setData('application/x-superhigh-session-id', sessionId)
  event.dataTransfer?.setData('text/plain', sessionId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onConversationDragOver(event: DragEvent, sessionId: string) {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverSessionId.value = sessionId
}

function onConversationDrop(event: DragEvent, sessionId: string) {
  event.preventDefault()
  const fromId = event.dataTransfer?.getData('application/x-superhigh-session-id')
    || event.dataTransfer?.getData('text/plain')
  dragOverSessionId.value = null
  if (!fromId || fromId === sessionId) return
  store.reorderCliTerminalSession(fromId, sessionId)
}

function onConversationDragEnd() {
  dragOverSessionId.value = null
}
</script>

<template>
  <aside class="conversation-sidebar">
    <div class="conversation-sidebar-header">
      <div class="conversation-sidebar-title">
        <MessageSquare :size="16" class="conversation-title-icon" />
        <strong>对话管理</strong>
      </div>
      <button class="new-conversation-button" title="新增对话" @click="openNewConversation">
        <Plus :size="16" />
        <span>新增对话</span>
      </button>
    </div>
    <div class="conversation-list">
      <div
        v-for="(session, index) in sessions"
        :key="session.id"
        class="conversation-card"
        :class="{ active: store.activeCliSessionId === session.id, 'drag-over': dragOverSessionId === session.id }"
        :title="session.cwd"
        draggable="true"
        @dragstart="onConversationDragStart($event, session.id)"
        @dragover="onConversationDragOver($event, session.id)"
        @dragleave="dragOverSessionId = null"
        @drop="onConversationDrop($event, session.id)"
        @dragend="onConversationDragEnd"
      >
        <div v-if="editingId === session.id" class="conversation-edit-row">
          <span class="conversation-dot" :class="statusClass(session)" />
          <input
            ref="inputRef"
            v-model="editingName"
            class="conversation-name-input"
            :disabled="busyId === session.id"
            @blur="commitEditing"
            @keydown.enter.prevent="commitEditing"
            @keydown.esc.prevent="cancelEditing"
          />
        </div>
        <button
          v-else
          class="conversation-card-main"
          @click="store.setActiveTerminalSession(session.id)"
        >
          <span class="conversation-dot" :class="statusClass(session)" />
          <span class="conversation-card-title">{{ sessionTitle(session, index) }}</span>
        </button>

        <div class="conversation-card-actions">
          <template v-if="editingId === session.id">
            <button
              type="button"
              class="conversation-icon-button save"
              title="保存名称"
              @mousedown.prevent
              @click="commitEditing"
            >
              <Check :size="16" />
            </button>
            <button
              type="button"
              class="conversation-icon-button"
              title="取消"
              @mousedown.prevent
              @click="cancelEditing"
            >
              <X :size="16" />
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="conversation-icon-button"
              title="编辑名称"
              @click.stop="startEditing(session, index)"
            >
              <Edit3 :size="16" />
            </button>
            <button
              type="button"
              class="conversation-icon-button danger"
              title="删除对话"
              :disabled="busyId === session.id"
              @click.stop="deleteConversation(session.id)"
            >
              <Trash2 :size="16" />
            </button>
          </template>
        </div>
      </div>
      <div v-if="!sessions.length" class="conversation-empty">
        还没有对话
      </div>
    </div>
  </aside>
</template>

<style scoped>
.conversation-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
}

/* ---- conversation list ---- */
.conversation-sidebar-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--surface-divider-muted);
}

.conversation-sidebar-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
}

.conversation-title-icon {
  flex: none;
  color: var(--color-accent-blue);
}

.new-conversation-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.new-conversation-button:hover {
  background: var(--color-bg-hover);
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
  min-height: 0;
}

.conversation-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 4px 8px;
  min-height: 32px;
  border-bottom: 1px solid transparent;
}

.conversation-card:hover {
  background: var(--color-bg-hover);
}

.conversation-card.drag-over {
  background: var(--surface-accent-blue-soft);
  border-bottom-color: var(--color-accent-blue);
}

.conversation-card.active {
  background: var(--surface-accent-blue-soft);
  border-bottom-color: var(--surface-accent-blue-border);
}

.conversation-card-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 12.5px;
  cursor: pointer;
  padding: 0;
  text-align: left;
}

.conversation-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent-green);
}

.conversation-dot.error {
  background: var(--color-accent-red);
}

.conversation-card-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-card-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.conversation-card:hover .conversation-card-actions {
  opacity: 1;
}

.conversation-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.conversation-icon-button:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.conversation-icon-button.save {
  color: var(--color-accent-green);
}

.conversation-icon-button.danger:hover {
  background: var(--surface-danger-soft);
  color: var(--color-accent-red);
}

.conversation-icon-button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.conversation-edit-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.conversation-name-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--surface-accent-blue-border);
  border-radius: 3px;
  background: var(--color-input-bg);
  color: var(--color-text-primary);
  font-size: 12.5px;
  padding: 1px 4px;
  outline: none;
}

.conversation-empty {
  padding: 12px 8px;
  font-size: 10.5px;
  color: var(--color-text-muted);
  text-align: center;
}
</style>
