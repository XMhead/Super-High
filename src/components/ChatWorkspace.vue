<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, Code2, Folder, FolderOpen, LoaderCircle, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Search, SquareTerminal, X } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/stores/workspace'
import { backend } from '@/lib/tauri'
import { cliProviderLabel } from '@/lib/cliProviders'
import { chatHistoryAge, chatWorkspaceKey, groupChatHistory } from '@/lib/chatHistory'
import { terminalSessionTitle } from '@/lib/terminalTitle'
import { readTerminalDraft, saveTerminalDraft } from '@/lib/terminalDraftStorage'
import { buildCliMessageWithImages, clipboardEventHasImages, extractPastedImagesFromClipboardEvent } from '@/lib/cliImagePaste'
import { appPrompt } from '@/lib/appDialog'
import type { CliNativeConversationSummary } from '@/types'
import CliChatView from './CliChatView.vue'
import CliProviderIcon from './icons/CliProviderIcon.vue'
import TerminalPane from './TerminalPane.vue'
import EditorPane from './EditorPane.vue'
import ExplorerPane from './ExplorerPane.vue'

const store = useWorkspaceStore()
const emit = defineEmits<{ layout: [layout: { gridTemplateColumns: string; previewColumns: string; cliColumns: string; previewOnRight: boolean } | undefined] }>()
const root = ref<HTMLElement | null>(null)
const mainPanel = ref<HTMLElement | null>(null)
const previewPanel = ref<HTMLElement | null>(null)
const historyWidth = ref(258)
const panelStyle = computed(() => ({
  '--chat-history-width': `${historyWidth.value}px`,
  '--chat-preview-width': `${store.settings.panelLayout.previewWidth}px`,
  '--chat-explorer-width': `${store.settings.panelLayout.explorerWidth}px`,
}))
type ResizeTarget = 'history' | 'preview' | 'explorer'
let activeResize: { target: ResizeTarget; element: HTMLElement; pointerId: number; startX: number; width: number; max: number } | null = null

function startResize(target: ResizeTarget, event: PointerEvent) {
  if (event.button !== 0 || !root.value || !mainPanel.value) return
  stopResize()
  event.preventDefault()
  const element = event.currentTarget as HTMLElement
  const total = root.value.getBoundingClientRect().width
  const sidebar = root.value.querySelector<HTMLElement>('.chat-history-sidebar')
  const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0
  const previewWidth = previewPanel.value?.getBoundingClientRect().width ?? 0
  const explorerWidth = previewPanel.value?.querySelector<HTMLElement>('.explorer-panel')?.getBoundingClientRect().width ?? 0
  const width = target === 'history' ? sidebarWidth : target === 'preview' ? previewWidth : explorerWidth
  const max = target === 'history' ? Math.min(520, total * (previewVisible.value ? .25 : .4), total - previewWidth - 282)
    : target === 'preview' ? Math.min(1040, total * .6, total - sidebarWidth - 282)
    : Math.min(520, previewWidth * .5, previewWidth - 181)
  activeResize = { target, element, pointerId: event.pointerId, startX: event.clientX, width, max }
  document.documentElement.classList.add('is-resizing-panels')
  element.addEventListener('lostpointercapture', endResize)
  try { element.setPointerCapture?.(event.pointerId) } catch { /* Window listeners cover unavailable capture. */ }
  window.addEventListener('pointermove', moveResize, true)
  window.addEventListener('pointerup', endResize, true)
  window.addEventListener('pointercancel', endResize, true)
  window.addEventListener('blur', stopResize)
  document.addEventListener('visibilitychange', resizeVisibilityChanged)
}

function moveResize(event: PointerEvent) {
  const drag = activeResize
  if (!drag || event.pointerId !== drag.pointerId) return
  if (!(event.buttons & 1)) { stopResize(); return }
  const delta = (event.clientX - drag.startX) * (drag.target === 'history' ? 1 : -1)
  const min = drag.target === 'history' ? 180 : drag.target === 'preview' ? 340 : 160
  const width = Math.round(Math.min(Math.max(min, drag.max), Math.max(min, drag.width + delta)))
  if (drag.target === 'history') historyWidth.value = width
  else store.setPanelLayoutSize(drag.target === 'preview' ? 'previewWidth' : 'explorerWidth', width)
}

function endResize(event: PointerEvent) { if (event.pointerId === activeResize?.pointerId) stopResize() }
function resizeVisibilityChanged() { if (document.hidden) stopResize() }
function stopResize() {
  const drag = activeResize
  if (!drag) return
  activeResize = null
  document.documentElement.classList.remove('is-resizing-panels')
  window.removeEventListener('pointermove', moveResize, true)
  window.removeEventListener('pointerup', endResize, true)
  window.removeEventListener('pointercancel', endResize, true)
  window.removeEventListener('blur', stopResize)
  document.removeEventListener('visibilitychange', resizeVisibilityChanged)
  drag.element.removeEventListener('lostpointercapture', endResize)
  if (drag.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
  if (drag.target !== 'history') void store.saveSettings()
}
const livePane = ref<{ waitForSessionReady: (id: string) => Promise<boolean> } | null>(null)
let layoutObserver: ResizeObserver | undefined
const history = ref<CliNativeConversationSummary[]>([])
const selected = ref<CliNativeConversationSummary | null>(null)
const historyDrafts = ref<Record<string, string>>({})
const readHistoryDraft = (id: string) => historyDrafts.value[id] ?? readTerminalDraft(`history:${id}`).text
function writeHistoryDraft(id: string, text: string) {
  historyDrafts.value[id] = text
  try { saveTerminalDraft(`history:${id}`, { text }) }
  catch (caught) { store.showErrorMessage(`草稿保存失败：${String(caught)}`) }
}
const historyDraft = computed({
  get: () => selected.value ? readHistoryDraft(selected.value.id) : '',
  set: value => {
    if (selected.value) {
      store.invalidateTerminalSelection()
      writeHistoryDraft(selected.value.id, value)
    }
  },
})
const search = ref('')
const provider = ref('')
const collapsed = ref(new Set<string>())
const rowLimits = ref<Record<string, number>>({})
const groupLimit = ref(40)
const sidebarVisible = computed({ get: () => store.settings.conversationSidebarVisible, set: value => store.setConversationSidebarVisible(value) })
const previewVisible = ref(false)
const loading = ref(false)
const error = ref('')
const opening = ref(false)
const connecting = ref(false)
const now = ref(Date.now())
const closing = ref(false)
let refreshRequest = 0
let selectionRequest = 0
let disposed = false
let clockTimer: number | undefined
const pendingReadySessions = new Set<string>()
const groups = computed(() => groupChatHistory(history.value, store.cliTerminalSessions,
  [...store.openWorkspacePaths, ...store.recentProjects.map(project => project.path)], search.value, provider.value))
const providerIds = computed(() => [...new Set(['claude', 'codex', 'dsh', 'opencode', ...history.value.map(item => item.providerKind), ...store.cliTerminalSessions.map(item => item.providerKind)])])
const active = computed(() => store.activeCliTerminalSession)
const title = computed(() => selected.value?.title || (active.value ? terminalSessionTitle(active.value) : '新对话'))
const currentPath = computed(() => selected.value?.cwd || store.workspace?.rootPath || '')
const historySession = computed(() => selected.value ? { id: selected.value.id, title: selected.value.title, cwd: selected.value.cwd, providerKind: selected.value.providerKind } : null)

async function refresh(force = false) {
  const request = ++refreshRequest
  loading.value = true
  error.value = ''
  try {
    const result = await backend.listCliConversations(force)
    if (!disposed && request === refreshRequest) history.value = result
  } catch (caught) {
    if (!disposed && request === refreshRequest) error.value = `读取会话失败：${String(caught)}`
  } finally {
    if (!disposed && request === refreshRequest) loading.value = false
  }
}

function toggleGroup(key: string) {
  if (collapsed.value.has(key)) collapsed.value.delete(key)
  else collapsed.value.add(key)
}

function selectHistory(item: CliNativeConversationSummary) {
  selectionRequest++
  store.invalidateTerminalSelection()
  selected.value = item
}

function selectLive(id: string) {
  selectionRequest++
  selected.value = null
  store.setActiveTerminalSession(id)
}

async function openWorkspace(path: string) {
  if (opening.value || !path) return
  const request = ++selectionRequest
  opening.value = true
  try {
    if (await store.switchWorkspace(path) && request === selectionRequest) selected.value = null
  } finally { opening.value = false }
}

async function sendHistory(text: string): Promise<boolean> {
  const item = selected.value
  if (!item?.resumeSupported || opening.value || !text.trim()) return false
  const request = ++selectionRequest
  opening.value = true
  connecting.value = true
  try {
    if (chatWorkspaceKey(store.workspace?.rootPath ?? '') !== chatWorkspaceKey(item.cwd) && !await store.switchWorkspace(item.cwd, { preserveProjectSurface: true })) return false
    if (disposed || request !== selectionRequest) return false
    const previousIds = new Set(store.cliTerminalSessions.map(session => session.id))
    const session = await store.resumeNativeCliConversation(item)
    if (!session || disposed || request !== selectionRequest) return false
    if (!previousIds.has(session.id)) pendingReadySessions.add(session.id)
    if (pendingReadySessions.has(session.id) && !await livePane.value?.waitForSessionReady(session.id)) {
      if (!disposed && request === selectionRequest) store.showErrorMessage('CLI 尚未准备好，请确认终端状态后重试。')
      return false
    }
    pendingReadySessions.delete(session.id)
    if (disposed || request !== selectionRequest) return false
    if (!await store.sendTerminalConversationMessage(session.id, text)) return false
    if (readHistoryDraft(item.id) === text) writeHistoryDraft(item.id, '')
    if (!disposed && request === selectionRequest) selected.value = null
    return true
  } finally { opening.value = false; connecting.value = false }
}

async function pasteHistoryImage(event: ClipboardEvent) {
  const item = selected.value
  if (!item || !clipboardEventHasImages(event)) return
  event.preventDefault()
  try {
    const candidates = await extractPastedImagesFromClipboardEvent(event)
    const paths: string[] = []
    const errors: string[] = []
    for (const candidate of candidates) {
      try { paths.push(await backend.savePastedImage(item.cwd, candidate.dataUrl, candidate.preferredName)) }
      catch (caught) { errors.push(String(caught)) }
    }
    if (paths.length) {
      const imageText = buildCliMessageWithImages('', paths)
      const draft = readHistoryDraft(item.id)
      writeHistoryDraft(item.id, draft ? `${draft}\n${imageText}` : imageText)
    }
    if (errors.length) store.showErrorMessage(`有 ${errors.length} 张图片粘贴失败：${errors[0]}`)
  } catch (caught) {
    store.showErrorMessage(`保存粘贴图片失败：${String(caught)}`)
  }
}

async function switchToWork() {
  const item = selected.value
  if (!item) { store.setCliViewMode('work'); return }
  if (!item.resumeSupported || opening.value) return
  const request = ++selectionRequest
  opening.value = true
  connecting.value = true
  try {
    if (chatWorkspaceKey(store.workspace?.rootPath ?? '') !== chatWorkspaceKey(item.cwd) && !await store.switchWorkspace(item.cwd, { preserveProjectSurface: true })) return
    if (disposed || request !== selectionRequest) return
    const previousIds = new Set(store.cliTerminalSessions.map(session => session.id))
    const session = await store.resumeNativeCliConversation(item)
    if (!session || disposed || request !== selectionRequest) return
    if (!previousIds.has(session.id)) pendingReadySessions.add(session.id)
    if (pendingReadySessions.has(session.id) && !await livePane.value?.waitForSessionReady(session.id)) {
      if (!disposed && request === selectionRequest) store.showErrorMessage('CLI 尚未准备好，请确认终端状态后重试。')
      return
    }
    pendingReadySessions.delete(session.id)
    if (disposed || request !== selectionRequest) return
    selected.value = null
    store.setCliViewMode('work')
  } finally { opening.value = false; connecting.value = false }
}

async function renameActive() {
  const session = active.value
  if (!session) return
  const name = await appPrompt('对话名称', terminalSessionTitle(session), '重命名对话')
  if (name?.trim()) store.renameTerminalSession(session.id, name.trim())
}

async function closeActive() {
  if (!active.value || closing.value) return
  closing.value = true
  try { await store.closeTerminalSession(active.value.id, true) } finally { closing.value = false }
}

function openPreview() { previewVisible.value = true }
function updateCommandLayout() {
  const workspace = root.value?.closest('.workspace-main')
  if (!previewVisible.value || !workspace || !mainPanel.value) { emit('layout', undefined); return }
  const boundary = mainPanel.value.getBoundingClientRect().right - workspace.getBoundingClientRect().left
  emit('layout', { gridTemplateColumns: `${boundary}px 1px minmax(0, 1fr)`, previewColumns: '3 / -1', cliColumns: '1 / 2', previewOnRight: true })
}
function togglePreview() {
  if (!previewVisible.value) store.setPreviewMode('code')
  previewVisible.value = !previewVisible.value
}
function toggleSidebar() {
  if (previewVisible.value && window.innerWidth <= 850) { previewVisible.value = false; sidebarVisible.value = true }
  else sidebarVisible.value = !sidebarVisible.value
}

// Passive host restoration can update active IDs without a navigation request.
watch(() => store.activeCliSelectionRevision, () => { if (!opening.value) { selectionRequest++; selected.value = null } })
watch([search, provider], () => { groupLimit.value = 40 })
// Native file links continue to use the shared editor and file tree.
watch(() => store.activeTab?.id, () => { if (store.activeTab) previewVisible.value = true })
watch(() => store.settings.explorerVisible, visible => { if (visible) previewVisible.value = true })
watch([previewVisible, sidebarVisible, () => store.settings.explorerVisible], () => { stopResize(); void nextTick(updateCommandLayout) })
onMounted(() => {
  void refresh()
  window.addEventListener('superhigh:chat-preview', openPreview)
  if (typeof ResizeObserver !== 'undefined') {
    layoutObserver = new ResizeObserver(updateCommandLayout)
    if (root.value) layoutObserver.observe(root.value)
    if (mainPanel.value) layoutObserver.observe(mainPanel.value)
  }
  clockTimer = window.setInterval(() => { now.value = Date.now() }, 60_000)
})
onBeforeUnmount(() => { stopResize(); disposed = true; refreshRequest++; selectionRequest++; window.clearInterval(clockTimer); layoutObserver?.disconnect(); window.removeEventListener('superhigh:chat-preview', openPreview); emit('layout', undefined) })
</script>

<template>
  <section ref="root" class="chat-workspace" :style="panelStyle" :class="{ 'chat-workspace--sidebar-hidden': !sidebarVisible, 'chat-workspace--preview': previewVisible }" aria-label="聊天工作区">
    <aside v-show="sidebarVisible" class="chat-history-sidebar" aria-label="会话和工作区">
      <div class="chat-history-actions">
        <button type="button" class="chat-new-button" @click="store.setNewConversationDialogOpen(true)"><Plus :size="15" />新对话</button>
        <button type="button" class="chat-icon" title="打开项目" @click="store.openProject()"><FolderOpen :size="15" /></button>
      </div>
      <label class="chat-history-search"><Search :size="14" /><input v-model="search" placeholder="搜索会话或工作区" aria-label="搜索会话或工作区" /><button v-if="search" type="button" class="chat-icon" title="清空搜索" @click="search = ''"><X :size="12" /></button></label>
      <div class="chat-history-filter">
        <span>智能体</span>
        <select v-model="provider" aria-label="筛选智能体"><option value="">全部</option><option v-for="id in providerIds" :key="id" :value="id">{{ cliProviderLabel(id) }}</option></select>
        <button type="button" class="chat-icon" :disabled="loading" title="刷新本机会话" @click="refresh(true)"><LoaderCircle v-if="loading" :size="13" class="chat-spin" /><RefreshCw v-else :size="13" /></button>
      </div>
      <p v-if="error" class="chat-history-error" role="alert">{{ error }}</p>
      <div class="chat-history-list">
        <section v-for="group in groups.slice(0, groupLimit)" :key="group.key" class="chat-history-group">
          <div class="chat-project-row" :class="{ current: group.key === chatWorkspaceKey(store.workspace?.rootPath ?? '') }">
            <button type="button" class="chat-project-toggle" :title="group.path" :aria-expanded="!collapsed.has(group.key)" @click="toggleGroup(group.key)"><component :is="collapsed.has(group.key) ? ChevronRight : ChevronDown" :size="12" /><Folder :size="14" /><strong>{{ group.name }}</strong><span>{{ group.sessions.length + group.conversations.length }}</span></button>
            <button type="button" class="chat-icon chat-open-project" :disabled="opening || !group.path" :title="`打开工作区：${group.path}`" @click="openWorkspace(group.path)"><FolderOpen :size="13" /></button>
          </div>
          <div v-if="!collapsed.has(group.key)" class="chat-project-sessions">
            <button v-for="session in group.sessions" :key="session.id" type="button" class="chat-history-row" :class="{ active: !selected && store.activeCliSessionId === session.id }" :title="`${cliProviderLabel(session.providerKind)} · ${terminalSessionTitle(session)}\n${session.cwd}`" @click="selectLive(session.id)"><CliProviderIcon :provider="session.providerKind" :size="13" /><span>{{ terminalSessionTitle(session) }}</span><small>已打开</small></button>
            <button v-for="item in group.conversations.slice(0, rowLimits[group.key] || 40)" :key="item.id" type="button" class="chat-history-row" :class="{ active: selected?.id === item.id }" :title="`${cliProviderLabel(item.providerKind)} · ${item.title}\n${item.cwd}\n${item.updatedAt}`" @click="selectHistory(item)"><CliProviderIcon :provider="item.providerKind" :size="13" /><span>{{ item.title }}</span><time :datetime="item.updatedAt">{{ chatHistoryAge(item.updatedAt, now) }}</time></button>
            <button v-if="group.conversations.length > (rowLimits[group.key] || 40)" type="button" class="chat-history-more" @click="rowLimits[group.key] = (rowLimits[group.key] || 40) + 40">显示更多会话（{{ group.conversations.length }}）</button>
            <p v-if="!group.sessions.length && !group.conversations.length" class="chat-history-empty">还没有会话</p>
          </div>
        </section>
        <button v-if="groups.length > groupLimit" type="button" class="chat-history-more" @click="groupLimit += 40">显示更多工作区（{{ groups.length }}）</button>
        <p v-if="!groups.length" class="chat-history-empty">{{ loading ? '正在读取本机会话…' : search || provider ? '没有匹配的会话' : '还没有本机会话' }}</p>
      </div>
      <div class="chat-history-footer"><Folder :size="12" /><span :title="store.workspace?.rootPath">{{ store.workspace?.name }}</span><small>{{ history.length }} 条记录</small></div>
    </aside>
    <div v-if="sidebarVisible" class="workspace-resizer chat-history-resizer" role="separator" aria-orientation="vertical" aria-label="调整会话侧栏和聊天区域宽度" @pointerdown="startResize('history', $event)" />
    <main ref="mainPanel" class="chat-workspace-main">
      <header class="chat-workspace-header">
        <button type="button" class="chat-icon" :title="sidebarVisible ? '隐藏会话侧栏' : '显示会话侧栏'" @click="toggleSidebar"><PanelLeftClose v-if="sidebarVisible" :size="15" /><PanelLeftOpen v-else :size="15" /></button>
        <div class="chat-workspace-heading"><strong>{{ title }}</strong><span :title="currentPath">{{ currentPath }}</span></div>
        <span v-if="selected" class="chat-history-label">历史记录</span>
        <button v-if="!selected && active" type="button" class="chat-icon" title="重命名对话" @click="renameActive"><Pencil :size="14" /></button>
        <button v-if="!selected && active" type="button" class="chat-icon" :disabled="closing" title="关闭对话并结束进程" @click="closeActive"><X :size="14" /></button>
        <button type="button" class="chat-icon" :class="{ active: previewVisible }" title="代码与文件" :aria-pressed="previewVisible" @click="togglePreview"><Code2 :size="15" /></button>
        <button type="button" class="chat-icon" title="切换到工作模式"  :disabled="opening || (!!selected && !selected.resumeSupported)" @click="switchToWork"><SquareTerminal :size="15" /></button>
      </header>
      <div v-if="connecting" class="chat-connection-status" role="status">正在连接 CLI，保留当前对话…</div>
      <div class="chat-workspace-content">
        <TerminalPane ref="livePane" v-show="!selected" mode="cli" :visible="!selected" />
        <CliChatView v-if="selected && historySession" :key="selected.id" v-model:draft="historyDraft" :session="historySession" :history="selected" :submit-history="sendHistory" :screen-lines="() => []" :screen-revision="0" @draft-paste="pasteHistoryImage">
          <template #history-actions>
            <span>{{ cliProviderLabel(selected.providerKind) }} · 原生会话</span>
            <span v-if="!selected.resumeSupported">请在 {{ cliProviderLabel(selected.providerKind) }} 中继续</span>
          </template>
        </CliChatView>
      </div>
    </main>
    <div v-if="previewVisible" class="workspace-resizer" role="separator" aria-orientation="vertical" aria-label="调整聊天区域和代码预览宽度" @pointerdown="startResize('preview', $event)" />
    <aside v-if="previewVisible" ref="previewPanel" class="chat-workspace-preview" :class="{ 'chat-workspace-preview--explorer': store.settings.explorerVisible }" aria-label="代码与文件">
      <EditorPane v-if="store.settings.activePreviewMode === 'code'" /><TerminalPane v-else mode="local" />
      <div v-if="store.settings.explorerVisible" class="workspace-resizer chat-explorer-resizer" role="separator" aria-orientation="vertical" aria-label="调整代码预览和文件资源管理器宽度" @pointerdown="startResize('explorer', $event)" />
      <ExplorerPane v-if="store.settings.explorerVisible" />
    </aside>
  </section>
</template>

<style scoped>
.chat-workspace { grid-column: 2 / -1; display: grid; grid-template-columns: minmax(0, min(var(--chat-history-width), 40%)) 1px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; background: var(--color-bg-primary); color: var(--color-text-primary); font-family: var(--font-ui); }
.chat-workspace--sidebar-hidden { grid-template-columns: minmax(0, 1fr); }
.chat-workspace--preview { grid-template-columns: minmax(0, min(var(--chat-history-width), 25%)) 1px minmax(0, 1fr) 1px minmax(0, min(var(--chat-preview-width), 60%, max(0px, calc(100% - min(var(--chat-history-width), 25%) - 282px)))); }
.chat-workspace--preview.chat-workspace--sidebar-hidden { grid-template-columns: minmax(0, 1fr) 1px minmax(0, min(var(--chat-preview-width), 60%, max(0px, calc(100% - 281px)))); }
.chat-history-sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--color-bg-secondary); }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .55; }
.chat-history-actions { display: flex; gap: 4px; padding: 10px 10px 6px; }
.chat-new-button { display: flex; align-items: center; gap: 8px; flex: 1; height: 30px; padding: 0 8px; text-align: left; border: 1px solid var(--color-border); border-radius: 4px; background: transparent; color: var(--color-text-primary); font-size: 12px; }
.chat-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 3px; color: var(--color-text-secondary); background: transparent; }
.chat-icon:hover, .chat-new-button:hover, .chat-icon.active { color: var(--color-text-primary); background: var(--color-bg-hover); }
.chat-history-search { display: flex; align-items: center; gap: 7px; min-height: 28px; margin: 0 10px 6px; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-muted); }
.chat-history-search input { width: 0; min-width: 0; flex: 1; padding: 4px 0; border: 0; background: transparent; color: var(--color-text-primary); font-size: 12px; }
.chat-history-filter { display: flex; align-items: center; gap: 6px; padding: 2px 10px 5px; color: var(--color-text-muted); font-size: 11px; }
.chat-history-filter select { flex: 1; min-width: 0; height: 26px; padding: 0 4px; border: 0; color: var(--color-text-secondary); background: var(--color-bg-secondary-solid); font-size: 11px; }
.chat-history-list { min-height: 0; flex: 1; overflow: auto; padding: 0 5px 12px; }
.chat-history-group { margin-top: 5px; }
.chat-project-row { display: flex; align-items: center; min-width: 0; height: 29px; }
.chat-project-row.current { color: var(--color-text-primary); }
.chat-project-toggle { flex: 1; min-width: 0; height: 100%; display: flex; align-items: center; gap: 6px; padding: 0 4px; border: 0; background: transparent; color: var(--color-text-secondary); text-align: left; font-size: 12px; }
.chat-project-toggle svg { flex: none; }
.chat-project-toggle strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--sh-weight-emphasis); }
.chat-project-toggle > span { margin-left: auto; font-size: 10px; color: var(--color-text-muted); }
.chat-open-project { width: 22px; height: 23px; }
.chat-history-row { display: flex; align-items: center; gap: 7px; width: 100%; height: 27px; padding: 0 5px 0 20px; border: 0; border-radius: 3px; text-align: left; color: var(--color-text-secondary); background: transparent; font-size: 12px; }
.chat-history-row > svg { flex: none; }
.chat-history-row > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-history-row > time, .chat-history-row > small { flex: none; font-size: 10px; color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.chat-history-row:hover, .chat-project-toggle:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.chat-history-row.active { background: var(--surface-accent-blue-soft); color: var(--color-text-primary); box-shadow: inset 2px 0 var(--color-accent-blue); }
.chat-history-empty, .chat-history-error { margin: 6px 12px; color: var(--color-text-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.chat-history-error { color: var(--color-accent-red); }
.chat-history-more { padding: 5px 12px 5px 20px; border: 0; background: transparent; color: var(--color-text-secondary); font-size: 11px; text-align: left; }
.chat-history-more:hover { color: var(--color-accent-blue); }
.chat-history-footer { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--color-border); color: var(--color-text-muted); font-size: 10px; }
.chat-history-footer span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-history-footer small { flex: none; font-size: inherit; }
.chat-workspace-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.chat-workspace-header { display: flex; align-items: center; gap: 8px; min-height: 45px; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
.chat-workspace-heading { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.chat-workspace-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: var(--sh-weight-emphasis); }
.chat-workspace-heading > span { font-size: 10px; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-history-label { flex: none; color: var(--color-text-muted); font-size: 11px; }
.chat-connection-status { padding: 4px 10px; color: var(--color-text-muted); font-size: 11px; }
.chat-workspace-content { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
.chat-workspace-content > :deep(.terminal-panel) { flex: 1; border-right: 0; }
.chat-workspace-content :deep(.terminal-tabs-bar) { display: none; }
.chat-workspace-preview { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
.chat-workspace-preview--explorer { grid-template-columns: minmax(0, 1fr) 1px minmax(0, min(var(--chat-explorer-width), 50%)); }
.chat-workspace-preview > :deep(.editor-panel) { flex: 1; min-width: 0; }
.chat-workspace-preview > :deep(.terminal-panel) { flex: 1; min-width: 0; }
.chat-workspace-preview > :deep(.explorer-panel) { width: auto; min-width: 0; border-left: 0; }
.chat-spin { animation: chat-spin 1s linear infinite; }
@keyframes chat-spin { to { transform: rotate(360deg); } }
@media (max-width: 1100px) { .chat-workspace-preview--explorer { grid-template-columns: minmax(0, 1fr); } .chat-workspace-preview > :deep(.explorer-panel), .chat-explorer-resizer { display: none; } }
@media (max-width: 850px) { .chat-workspace--preview { grid-template-columns: minmax(0, 1fr) 1px minmax(0, min(var(--chat-preview-width), 60%, max(0px, calc(100% - 281px)))); } .chat-workspace--preview .chat-history-sidebar, .chat-workspace--preview .chat-history-resizer { display: none; } }
@media (prefers-reduced-motion: reduce) { .chat-spin { animation: none; } }
</style>
