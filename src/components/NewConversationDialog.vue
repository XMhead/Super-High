<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Cpu, FolderOpen, Plus, Save, Terminal, Trash2, X } from 'lucide-vue-next'

import { CLI_PROVIDER_OPTIONS, cliProviderLaunchEnabled } from '@/lib/cliProviders'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const nameInputRef = ref<HTMLInputElement | null>(null)
const promptInputRef = ref<HTMLTextAreaElement | null>(null)
const sessionName = ref('')
const sessionPrompt = ref('')
const sessionCwd = ref('')
const phraseTitle = ref('')
const selectedProviderId = ref(CLI_PROVIDER_OPTIONS[0].id)
const isCreating = ref(false)
const isSavingPhrase = ref(false)
const error = ref<string | null>(null)

const show = computed(() => store.newConversationDialogOpen)
const canCreate = computed(() => !isCreating.value && !!sessionCwd.value.trim())
const canSavePhrase = computed(() => !isCreating.value && !isSavingPhrase.value && !!sessionPrompt.value.trim())
const quickPhrases = computed(() => store.settings.quickPhrases ?? [])

watch(show, (open) => {
  if (!open) return
  const activeProvider = store.activeCliTerminalSession?.providerKind
  const preferredProvider = CLI_PROVIDER_OPTIONS.find((provider) => provider.id === activeProvider && cliProviderLaunchEnabled(provider.id))?.id
  sessionName.value = `会话 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  sessionPrompt.value = ''
  phraseTitle.value = ''
  sessionCwd.value = store.workspace?.rootPath ?? ''
  selectedProviderId.value = preferredProvider ?? 'claude'
  error.value = null
  void nextTick(() => {
    nameInputRef.value?.focus()
    nameInputRef.value?.select()
  })
})

function closeDialog() {
  if (isCreating.value) return
  store.setNewConversationDialogOpen(false)
}

async function browseDirectory() {
  const selected = await store.selectDirectory(sessionCwd.value || store.workspace?.rootPath)
  if (selected) sessionCwd.value = selected
}

function insertQuickPhrase(text: string) {
  const cleanText = text.trim()
  if (!cleanText) return
  sessionPrompt.value = sessionPrompt.value.trim()
    ? `${sessionPrompt.value.trimEnd()}\n\n${cleanText}`
    : cleanText
  void nextTick(() => promptInputRef.value?.focus())
}

async function saveQuickPhrase() {
  if (!canSavePhrase.value) return
  isSavingPhrase.value = true
  error.value = null
  try {
    await store.addQuickPhrase(phraseTitle.value, sessionPrompt.value)
    phraseTitle.value = ''
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    isSavingPhrase.value = false
  }
}

async function deleteQuickPhrase(id: string) {
  if (isCreating.value || isSavingPhrase.value) return
  error.value = null
  try {
    await store.deleteQuickPhrase(id)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function createConversation() {
  if (!canCreate.value) return
  isCreating.value = true
  error.value = null
  try {
    await store.createTerminalSession(selectedProviderId.value, {
      name: sessionName.value,
      cwd: sessionCwd.value,
      initialPrompt: sessionPrompt.value,
    })
    store.setNewConversationDialogOpen(false)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    isCreating.value = false
  }
}
</script>

<template>
  <div v-if="show" class="new-session-backdrop">
    <form class="new-session-dialog" @submit.prevent="createConversation">
      <div class="new-session-header">
        <h2>新建对话</h2>
        <button type="button" class="new-session-close" title="关闭" @click="closeDialog">
          <X :size="20" />
        </button>
      </div>

      <div class="new-session-body">
        <label class="new-session-field">
          <span>名称（可选）</span>
          <input
            ref="nameInputRef"
            v-model="sessionName"
            class="new-session-input"
            placeholder="对话名称"
            :disabled="isCreating"
          />
        </label>

        <label class="new-session-field">
          <span>工作目录 <b>*</b></span>
          <div class="new-session-directory">
            <input
              v-model="sessionCwd"
              class="new-session-input"
              placeholder="选择工作目录"
              :disabled="isCreating"
            />
            <button
              type="button"
              class="new-session-browse"
              title="浏览"
              :disabled="isCreating"
              @click="browseDirectory"
            >
              <FolderOpen :size="16" />
            </button>
          </div>
        </label>

        <label class="new-session-field">
          <span>初始指令（可选）</span>
          <textarea
            ref="promptInputRef"
            v-model="sessionPrompt"
            class="new-session-textarea"
            rows="3"
            placeholder="留空则进入交互对话模式"
            :disabled="isCreating"
            data-testid="new-session-prompt"
          />
        </label>

        <div class="new-session-field new-session-phrases">
          <span>快捷短语</span>
          <div class="new-session-phrase-save">
            <input
              v-model="phraseTitle"
              class="new-session-input"
              placeholder="标题（可选）"
              :disabled="isCreating || isSavingPhrase"
              data-testid="quick-phrase-title"
            />
            <button
              type="button"
              class="new-session-phrase-save-button"
              title="保存当前初始指令为快捷短语"
              :disabled="!canSavePhrase"
              data-testid="save-quick-phrase"
              @click="saveQuickPhrase"
            >
              <Save :size="14" />
              <span>{{ isSavingPhrase ? '保存中...' : '保存当前' }}</span>
            </button>
          </div>
          <div v-if="quickPhrases.length" class="new-session-phrase-list">
            <div v-for="phrase in quickPhrases" :key="phrase.id" class="new-session-phrase-row">
              <button
                type="button"
                class="new-session-phrase-main"
                :title="phrase.text"
                :disabled="isCreating"
                data-testid="quick-phrase-insert"
                @click="insertQuickPhrase(phrase.text)"
              >
                <span>{{ phrase.title }}</span>
                <small>{{ phrase.text }}</small>
              </button>
              <button
                type="button"
                class="new-session-phrase-delete"
                title="删除快捷短语"
                :disabled="isCreating || isSavingPhrase"
                data-testid="quick-phrase-delete"
                @click="deleteQuickPhrase(phrase.id)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>

        <div class="new-session-field">
          <span>CLI</span>
          <div class="new-session-provider-list">
            <button
              v-for="provider in CLI_PROVIDER_OPTIONS"
              :key="provider.id"
              type="button"
              class="new-session-provider"
              :class="{ active: selectedProviderId === provider.id }"
              :title="provider.command"
              :disabled="isCreating || !cliProviderLaunchEnabled(provider.id)"
              @click="selectedProviderId = provider.id"
            >
              <Terminal v-if="provider.icon === 'terminal'" :size="14" />
              <Cpu v-else :size="14" />
              <span>{{ provider.name }}</span>
            </button>
          </div>
        </div>

        <div v-if="error" class="new-session-error">{{ error }}</div>

        <div class="new-session-actions">
          <button type="submit" class="new-session-create" :disabled="!canCreate">
            <Plus v-if="!isCreating" :size="14" />
            <span>{{ isCreating ? '创建中...' : '创建' }}</span>
          </button>
          <button type="button" class="new-session-cancel" :disabled="isCreating" @click="closeDialog">
            <X :size="14" />
            <span>取消</span>
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
