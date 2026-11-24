<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Code2, Maximize2, Minus, Plus, X } from 'lucide-vue-next'
import { backend, isTauri, onGlobalPluginFilesChanged, onWorkspaceFilesChanged } from '@/lib/tauri'
import { editorPathKey, prepareEditor, rememberRecentEditor, type EditorCatalogEntry } from '@/lib/editorCatalog'
import { openExternalLinkFromClick, urlFromExternalUrlMessage } from '@/lib/externalLinks'
import { appConfirm, appDialogState } from '@/lib/appDialog'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNativeScrollSpeed } from '@/lib/scrollSpeed'
import type { EditorWindowInbox, EditorWindowPage } from '@/lib/editorWindows'
import { connectEditorWindowUi, type EditorUiSnapshot } from '@/lib/editorWindowUi'
import { isSuperhighUiPath } from '@/lib/superhighUi'
import { pluginFileChanges } from '@/lib/pluginFileChanges'
import type { EditorTab } from '@/types'
import AppDialog from './AppDialog.vue'
import EditorFileTab from './EditorFileTab.vue'
import EditorPicker from './EditorPicker.vue'
import EditorPane from './EditorPane.vue'
import ExplorerPane from './ExplorerPane.vue'
import PluginEditorPage from './PluginEditorPage.vue'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'
import SuperhighUiPreview from './SuperhighUiPreview.vue'

const props = defineProps<{ preview?: boolean; initialPages?: EditorWindowPage[] }>()
const store = useWorkspaceStore()
store.isEditorWindow = true
useNativeScrollSpeed(() => store.settings.scrollSpeedPercent)
const tabs = ref<Array<{ tab: EditorTab; parameters: Record<string, unknown>; iui?: boolean; pluginTabId?: string }>>([])
const activeId = ref('')
const active = computed(() => tabs.value.find(item => item.tab.id === activeId.value))
const picker = ref<InstanceType<typeof EditorPicker> | null>(null)
const pickerVisible = ref(false)
const pluginTabs = computed(() => new Map(store.pluginEditorTabs.map(tab => [tab.id, tab])))
const loading = ref(true)
const explorerVisible = ref(false)
const hasCode = computed(() => store.tabs.length > 0)
const unlisteners: UnlistenFn[] = []
let disposed = false
let allowClose = false
let closing = false
let inboxQueue = Promise.resolve()
let uiConnection: Awaited<ReturnType<typeof connectEditorWindowUi>> | undefined
const dismissedUiPaths = new Set<string>()
let pluginReloadTimer: ReturnType<typeof setTimeout> | undefined
const pendingPlugins = new Set<string>()

function applyUiSnapshot(snapshot: EditorUiSnapshot) {
  if (disposed) return
  const paths = new Set(snapshot.tabs.map(tab => editorPathKey(tab.path)))
  for (const path of dismissedUiPaths) if (!paths.has(path)) dismissedUiPaths.delete(path)
  for (const item of [...tabs.value]) if (item.iui && !paths.has(editorPathKey(item.tab.path))) closeTab(item.tab.id, false)
  const hadActive = !!active.value
  for (const source of snapshot.tabs) {
    const path = editorPathKey(source.path)
    const existing = tabs.value.find(item => item.iui && editorPathKey(item.tab.path) === path)
    if (existing) Object.assign(existing.tab, { ...source, id: existing.tab.id, isDirty: false })
    else if (!dismissedUiPaths.has(path)) tabs.value.push({ tab: { ...source, id: `iui:${source.id}`, isDirty: false }, parameters: {}, iui: true })
  }
  if (!hadActive) activeId.value = tabs.value.find(item => editorPathKey(item.tab.path) === editorPathKey(snapshot.activePath ?? ''))?.tab.id ?? tabs.value[0]?.tab.id ?? ''
  if (tabs.value.length) picker.value?.close()
}
async function submitUi(path: string, text: string) {
  return uiConnection ? uiConnection.submit(path, text) : store.insertUiDraft(path, text)
}
async function saveUiSource(tab: EditorTab, content: string, previous: string) {
  if (!uiConnection) throw new Error('主窗口连接尚未就绪。')
  await uiConnection.saveSource(tab.path, content, previous)
  if (!disposed && tab.content === previous) tab.content = content
}

function report(error: unknown) { if (!disposed) store.showErrorMessage(String(error)) }
async function openPage(page: EditorWindowPage) {
  picker.value?.close()
  const existing = tabs.value.find(item => editorPathKey(item.tab.path) === editorPathKey(page.path))
  if (existing) {
    existing.parameters = page.parameters
    activeId.value = existing.tab.id
    return
  }
  const content = await backend.readFile(page.path)
  if (disposed) return
  const concurrent = tabs.value.find(item => editorPathKey(item.tab.path) === editorPathKey(page.path))
  if (concurrent) { concurrent.parameters = page.parameters; activeId.value = concurrent.tab.id; return }
  const tab: EditorTab = { id: crypto.randomUUID(), path: page.path, name: page.title, content, contentType: 'text', language: 'html', isDirty: false }
  tabs.value.push({ tab, parameters: page.parameters })
  activeId.value = tab.id
  rememberRecentEditor(page.path)
}
async function choose(editor: EditorCatalogEntry) {
  try { await prepareEditor(editor); await openPage({ path: editor.path, title: editor.id, parameters: {} }) }
  catch (error) { report(error) }
}
function choosePlugin(id: string) {
  const plugin = pluginTabs.value.get(id)
  if (!plugin) return
  const path = `plugin:${plugin.id}`
  if (!tabs.value.some(item => item.tab.id === path)) {
    tabs.value.push({
      tab: { id: path, path, name: plugin.title, content: '', contentType: 'text', language: 'plaintext', isDirty: false },
      parameters: {}, pluginTabId: id,
    })
  }
  activeId.value = path
  rememberRecentEditor(path)
}
function schedulePluginReload(paths: string[], root: string) {
  const change = pluginFileChanges(paths, root, store.pluginStatuses)
  if (!change.relevant) return
  for (const id of change.ids) pendingPlugins.add(id)
  clearTimeout(pluginReloadTimer)
  pluginReloadTimer = setTimeout(() => {
    const ids = new Set(pendingPlugins)
    pendingPlugins.clear()
    void store.refreshPlugins(ids)
  }, 300)
}
function closeTab(id: string, dismiss = true) {
  const index = tabs.value.findIndex(item => item.tab.id === id)
  if (index < 0) return
  if (dismiss && tabs.value[index].iui) dismissedUiPaths.add(editorPathKey(tabs.value[index].tab.path))
  tabs.value.splice(index, 1)
  if (activeId.value === id) activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.tab.id ?? ''
}
async function applyInbox(inbox: EditorWindowInbox) {
  if (!store.workspace) {
    store.workspace = inbox.workspace
    store.openWorkspacePaths = [inbox.workspace.rootPath]
    await store.loadSettings()
    await store.syncWorkspaceWatchTargetsNow(true)
    await store.refreshPlugins()
  }
  for (const page of inbox.pages) {
    try { await openPage(page) } catch (error) { report(error) }
  }
}
function receive() {
  inboxQueue = inboxQueue.catch(report).then(async () => {
    const inbox = await backend.takeEditorWindowInbox()
    if (!disposed) await applyInbox(inbox)
    if (!disposed && uiConnection) { dismissedUiPaths.clear(); await uiConnection.refresh() }
  })
  return inboxQueue
}
async function toggleExplorer() {
  explorerVisible.value = !explorerVisible.value
  if (explorerVisible.value && store.workspace) await store.loadDirectory(store.workspace.rootPath)
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'F1' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault(); event.stopImmediatePropagation()
    if (!event.repeat) void toggleExplorer().catch(report)
  }
  if ((event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) && !event.altKey) event.preventDefault()
}
function onClick(event: MouseEvent) { openExternalLinkFromClick(event, url => backend.openUrl(url).catch(report)) }
function onMessage(event: MessageEvent) {
  const url = urlFromExternalUrlMessage(event.data)
  if (url) void backend.openUrl(url).catch(report)
}
async function keep(promise: Promise<UnlistenFn>) {
  const unlisten = await promise
  if (disposed) unlisten()
  else unlisteners.push(unlisten)
}
async function closeWindow() { if (isTauri()) await getCurrentWindow().close() }

watch(() => active.value?.tab.name, name => {
  if (isTauri()) void getCurrentWindow().setTitle(`${name ? `${name} · ` : ''}Super High 编辑器`).catch(report)
})
watch(() => store.projectEditorBindings[editorPathKey(active.value?.tab.path ?? '')]?.path, path => {
  const tab = path && store.tabs.find(item => editorPathKey(item.path) === editorPathKey(path))
  if (tab) store.activeTabId = tab.id
})
onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('click', onClick)
  window.addEventListener('message', onMessage)
  window.addEventListener('superhigh:toggle-explorer', toggleExplorer)
  try {
    if (isTauri() && !props.preview) {
      // Subscribe before draining so opens during window startup are retained.
      await keep(listen('editor-window-open', () => { void receive().catch(report) }))
      await keep(listen<string>('editor-window-shortcut', ({ payload }) => {
        if (payload === 'F4') picker.value?.toggle()
        if (payload === 'F1') void toggleExplorer().catch(report)
      }))
      await receive()
      const connection = await connectEditorWindowUi(store.workspace!.rootPath, applyUiSnapshot)
      if (disposed) connection.destroy()
      else uiConnection = connection
      await keep(listen('app-settings-updated', async () => {
        const disabled = store.settings.disabledPluginIds.join('\0')
        await store.loadSettings()
        if (!disposed && disabled !== store.settings.disabledPluginIds.join('\0')) await store.refreshPlugins()
      }))
      await keep(onGlobalPluginFilesChanged(paths => schedulePluginReload(paths, store.pluginEnvironment?.pluginRoot ?? '')))
      await keep(getCurrentWindow().onCloseRequested(async event => {
        if (allowClose || !store.hasDirtyTextTabs) return
        event.preventDefault()
        if (closing) return
        closing = true
        try {
          if (await appConfirm('还有未保存的文件，保存后关闭编辑器窗口？') && await store.saveAllTabs()) {
            allowClose = true
            await closeWindow()
          }
        } finally { closing = false }
      }))
      await keep(onWorkspaceFilesChanged(async event => {
        if (editorPathKey(event.rootPath) !== editorPathKey(store.workspace?.rootPath ?? '')) return
        schedulePluginReload(event.kind === 'rescan' ? [] : event.changedPaths, `${event.rootPath}/.superhigh/plugins`)
        const changed = new Set(event.changedPaths.map(editorPathKey))
        await store.reloadOpenTabsForChangedPaths(store.tabs, changed)
        for (const item of tabs.value) {
          if (item.iui || item.pluginTabId) continue
          if (event.kind !== 'rescan' && !changed.has(editorPathKey(item.tab.path))) continue
          try {
            const content = await backend.readFile(item.tab.path)
            if (!disposed && content !== item.tab.content) item.tab.content = content
          } catch (error) { report(error) }
        }
      }))
    } else {
      for (const page of props.initialPages ?? []) await openPage(page)
    }
    await nextTick()
    if (!tabs.value.length && !disposed) await picker.value?.show()
  } catch (error) { report(error) }
  finally { loading.value = false }
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(pluginReloadTimer)
  store.resetPluginRuntimeState()
  uiConnection?.destroy()
  for (const unlisten of unlisteners) unlisten()
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('click', onClick)
  window.removeEventListener('message', onMessage)
  window.removeEventListener('superhigh:toggle-explorer', toggleExplorer)
  store.cancelAutoSave()
})
defineExpose({ openPage, applyUiSnapshot })
</script>

<template>
  <div class="editor-window-app">
    <header class="editor-window-titlebar" data-tauri-drag-region>
      <Code2 :size="14" /><span data-tauri-drag-region>{{ active?.tab.name ?? 'Super High 编辑器' }}</span>
      <span class="editor-window-workspace" data-tauri-drag-region>{{ store.workspace?.displayName }}</span>
      <div class="window-controls">
        <button class="window-control-button" aria-label="最小化" @click="isTauri() && getCurrentWindow().minimize()"><Minus :size="14" /></button>
        <button class="window-control-button" aria-label="最大化或还原" @click="isTauri() && getCurrentWindow().toggleMaximize()"><Maximize2 :size="13" /></button>
        <button class="window-control-button" aria-label="关闭编辑器窗口" @click="closeWindow"><X :size="14" /></button>
      </div>
    </header>
    <div class="editor-window-tabs" role="tablist" aria-label="编辑器标签">
      <EditorFileTab v-for="item in tabs" :key="item.tab.id" :tab="item.tab" :class="{ active: item.tab.id === activeId }" @select="activeId = item.tab.id" @close="closeTab(item.tab.id)" />
      <button class="ghost-button small editor-window-add" aria-label="选择编辑器" title="选择编辑器（F4）" @click="picker?.show()"><Plus :size="14" /></button>
    </div>
    <div class="editor-window-content" :class="{ 'with-code': hasCode, 'with-explorer': explorerVisible }">
      <main class="editor-window-pages">
        <div v-for="item in tabs" v-show="item.tab.id === activeId" :key="item.tab.id" class="editor-window-page">
          <PluginEditorPage v-if="item.pluginTabId" :plugin="pluginTabs.get(item.pluginTabId)" :visible="item.tab.id === activeId && !pickerVisible && !appDialogState.request" />
          <SuperhighUiPreview v-else-if="item.iui || isSuperhighUiPath(item.tab.path)" :tab="item.tab" :submit-draft="submitUi" :save-source="(content, previous) => saveUiSource(item.tab, content, previous)" />
          <SuperhighHtmlPreview v-else :tab="item.tab" :parameters="item.parameters" />
        </div>
        <div v-if="!tabs.length" class="editor-window-empty"><Code2 :size="28" /><button class="ghost-button" :disabled="loading" @click="picker?.show()">{{ loading ? '正在加载' : '选择编辑器' }}</button></div>
      </main>
      <section v-if="hasCode" class="panel editor-window-code"><EditorPane /></section>
      <ExplorerPane v-if="explorerVisible" />
    </div>
    <EditorPicker ref="picker" select-only :plugin-tabs="store.pluginEditorTabs" @select="choose" @select-plugin="choosePlugin" @visibility="pickerVisible = $event" />
    <AppDialog />
    <div v-if="store.activityMessage" class="toast-message" @click="store.dismissActivityMessage()">{{ store.activityMessage }}</div>
    <div v-if="store.errorMessage" class="toast-message error" @click="store.dismissErrorMessage()">{{ store.errorMessage }}</div>
  </div>
</template>

<style scoped>
.editor-window-app { height: 100dvh; display: grid; grid-template-rows: 34px 34px minmax(0, 1fr); min-width: 0; overflow: hidden; background: var(--color-bg-primary); color: var(--color-text-primary); font: var(--font-ui-weight) 13px var(--font-ui); }
.editor-window-titlebar { display: flex; align-items: center; gap: 8px; padding-left: 12px; min-width: 0; border-bottom: 1px solid var(--color-border); background: var(--surface-panel-strong); user-select: none; }
.editor-window-titlebar > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.editor-window-workspace { flex: 1; color: var(--color-text-secondary); }
.editor-window-tabs { display: flex; align-items: stretch; min-width: 0; overflow-x: auto; border-bottom: 1px solid var(--color-border); }
.editor-window-add { align-self: center; flex-shrink: 0; margin: 0 4px; }
.editor-window-content { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; min-width: 0; overflow: hidden; }
.editor-window-content.with-code { grid-template-columns: minmax(0, 1fr) minmax(280px, 1fr); }
.editor-window-content.with-explorer { grid-template-columns: minmax(0, 1fr) 220px; }
.editor-window-content.with-code.with-explorer { grid-template-columns: minmax(0, 1fr) minmax(280px, 1fr) 220px; }
.editor-window-pages,.editor-window-page { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; overflow: hidden; }
.editor-window-code { min-height: 0; min-width: 0; border-left: 1px solid var(--color-border); overflow: hidden; }
.editor-window-empty { flex: 1; display: flex; align-items: center; justify-content: center; gap: 12px; }
@media (max-width: 700px) {
  .editor-window-content.with-code { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(160px, 1fr); }
  .editor-window-content.with-code.with-explorer { grid-template-columns: minmax(0, 1fr) 160px; grid-template-rows: minmax(0, 1fr) minmax(160px, 1fr); }
  .editor-window-content.with-code.with-explorer > :deep(.explorer-panel) { grid-column: 2; grid-row: 1 / -1; }
  .editor-window-content.with-explorer { grid-template-columns: minmax(0, 1fr) 160px; }
}
</style>
