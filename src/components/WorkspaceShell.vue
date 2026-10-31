<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

import AppTopBar from './AppTopBar.vue'
import AppDialog from './AppDialog.vue'
import ActivityBar from './ActivityBar.vue'
import EditorPicker from './EditorPicker.vue'
import ExplorerPane from './ExplorerPane.vue'
import FileManagerPanel from './FileManagerPanel.vue'

import MinecraftPanel from './MinecraftPanel.vue'
import MemoWindow from './MemoWindow.vue'
import NewConversationDialog from './NewConversationDialog.vue'
import TerminalPane from './TerminalPane.vue'
import ChatWorkspace from './ChatWorkspace.vue'

const ConversationMapPanel = defineAsyncComponent(() => import('./ConversationMapPanel.vue'))
const GitPanel = defineAsyncComponent(() => import('./GitPanel.vue'))
const ScriptToolsPanel = defineAsyncComponent(() => import('./ScriptToolsPanel.vue'))
const SettingsDrawer = defineAsyncComponent(() => import('./SettingsDrawer.vue'))

const store = useWorkspaceStore()
const PreviewPane = defineAsyncComponent(() => import('./PreviewPane.vue'))
const isProjectLayoutSwapped = computed(() => store.settings.projectLayoutMode === 'swapped')
const isMultiTerminalMode = computed(() => store.settings.multiTerminalMode)
const isChatProject = computed(() => store.settings.cliViewMode === 'chat' && store.activeWorkspaceSurface === 'project')
const chatCommandLayout = shallowRef<{ gridTemplateColumns: string; previewColumns: string; cliColumns: string; previewOnRight: boolean }>()
const isDialogueMapProject = computed(() => (
  store.settings.dialogueMapMode && store.activeWorkspaceSurface === 'project'
))
const isMultiTerminalProject = computed(() => (
  isMultiTerminalMode.value && store.activeWorkspaceSurface === 'project'
))

type ResizeTarget = 'conversation-preview' | 'preview-explorer'

let activeResize: {
  pointerId: number
  captureTarget: HTMLElement | null
  target: ResizeTarget
  startX: number
  conversationWidth: number
  explorerWidth: number
} | null = null

const mainGridStyle = computed(() => {
  const layout = store.settings.panelLayout
  if (isChatProject.value) return { gridTemplateColumns: store.settings.activityBarVisible ? '44px minmax(0, 1fr)' : 'minmax(0, 1fr)' }
  if (isDialogueMapProject.value) {
    return {
      gridTemplateColumns: '44px minmax(0, 1fr)',
    }
  }
  const columns = [isMultiTerminalProject.value ? 'minmax(480px, 1fr)' : 'minmax(280px, 1fr)']
  if (!isMultiTerminalProject.value) {
    columns.unshift(`minmax(300px, ${layout.conversationWidth}px)`, '1px')
  }
  if (store.settings.explorerVisible) {
    columns.push('1px', `minmax(160px, ${layout.explorerWidth}px)`)
  }
  if (isProjectLayoutSwapped.value) columns.reverse()
  return { gridTemplateColumns: (store.settings.activityBarVisible ? ['44px', ...columns] : columns).join(' ') }
})

const commandLayout = computed(() => {
  if (store.settingsOpen || store.activeWorkspaceSurface !== 'project') return undefined
  if (isChatProject.value) return chatCommandLayout.value
  if (isDialogueMapProject.value || isMultiTerminalProject.value) return undefined
  const explorerColumns = store.settings.explorerVisible ? 2 : 0
  const activityOffset = store.settings.activityBarVisible ? 1 : 0
  const separatorColumn = isProjectLayoutSwapped.value
    ? activityOffset + 2 + explorerColumns
    : activityOffset + 2
  const previewColumns = isProjectLayoutSwapped.value ? `1 / ${separatorColumn}` : `${separatorColumn + 1} / -1`
  const cliColumns = isProjectLayoutSwapped.value ? `${separatorColumn + 1} / -1` : `1 / ${separatorColumn}`
  return { ...mainGridStyle.value, previewColumns, cliColumns, previewOnRight: !isProjectLayoutSwapped.value }
})

function startResize(target: ResizeTarget, event: PointerEvent) {
  if (event.button !== 0) return
  stopResize()
  event.preventDefault()
  const captureTarget = event.currentTarget as HTMLElement | null
  activeResize = {
    pointerId: event.pointerId,
    captureTarget,
    target,
    startX: event.clientX,
    conversationWidth: store.settings.panelLayout.conversationWidth,
    explorerWidth: store.settings.panelLayout.explorerWidth,
  }
  document.documentElement.classList.add('is-resizing-panels')
  // Capture keeps releases over editor/HTML frames in this gesture.
  captureTarget?.addEventListener('lostpointercapture', onResizeEnd)
  try { captureTarget?.setPointerCapture?.(event.pointerId) } catch { /* Window-level fallbacks remain active. */ }
  window.addEventListener('pointermove', onResizeMove, true)
  window.addEventListener('pointerup', onResizeEnd, true)
  window.addEventListener('pointercancel', onResizeEnd, true)
  window.addEventListener('blur', stopResize)
  document.addEventListener('visibilitychange', onResizeVisibilityChange)
}

function onResizeMove(event: PointerEvent) {
  if (!activeResize || event.pointerId !== activeResize.pointerId) return
  // A release outside the WebView can arrive without pointerup.
  if ((event.buttons & 1) === 0) { stopResize(); return }
  const delta = event.clientX - activeResize.startX
  if (activeResize.target === 'conversation-preview') {
    store.setPanelLayoutSize('conversationWidth', activeResize.conversationWidth + (isProjectLayoutSwapped.value ? -delta : delta))
    return
  }

  store.setPanelLayoutSize('explorerWidth', activeResize.explorerWidth + (isProjectLayoutSwapped.value ? delta : -delta))
}

function onResizeEnd(event: PointerEvent) {
  if (event.pointerId === activeResize?.pointerId) stopResize()
}

function onResizeVisibilityChange() {
  if (document.hidden) stopResize()
}

function stopResize() {
  if (!activeResize) return
  const { captureTarget, pointerId } = activeResize
  activeResize = null
  document.documentElement.classList.remove('is-resizing-panels')
  window.removeEventListener('pointermove', onResizeMove, true)
  window.removeEventListener('pointerup', onResizeEnd, true)
  window.removeEventListener('pointercancel', onResizeEnd, true)
  window.removeEventListener('blur', stopResize)
  document.removeEventListener('visibilitychange', onResizeVisibilityChange)
  captureTarget?.removeEventListener('lostpointercapture', onResizeEnd)
  if (captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId)
  void store.saveSettings()
}

function handleWorkspaceKeydown(event: KeyboardEvent) {
  if (event.key !== 'F1' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
  if (store.settingsOpen || store.activeWorkspaceSurface !== 'project' || isDialogueMapProject.value) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (!event.repeat) store.toggleExplorerVisible()
}

function handleExplorerToggle() {
  if (store.settingsOpen || store.activeWorkspaceSurface !== 'project' || isDialogueMapProject.value) return
  store.toggleExplorerVisible()
}

onMounted(() => {
  window.addEventListener('keydown', handleWorkspaceKeydown, true)
  window.addEventListener('superhigh:toggle-explorer', handleExplorerToggle)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWorkspaceKeydown, true)
  window.removeEventListener('superhigh:toggle-explorer', handleExplorerToggle)
  stopResize()
})
</script>

<template>
  <div class="workspace-shell">
    <AppTopBar :command-layout="commandLayout" />
    <div class="workspace-main" :class="{ 'project-layout-swapped': isProjectLayoutSwapped, 'activity-bar-hidden': !store.settings.activityBarVisible }" :style="mainGridStyle">
      <ActivityBar v-if="store.settings.activityBarVisible" />
      <SettingsDrawer v-if="store.settingsOpen" />
      <div v-show="!store.settingsOpen" class="workspace-surface">
      <FileManagerPanel v-if="store.activeWorkspaceSurface === 'files'" />
      <!-- Git 面板在下方 KeepAlive 中渲染，这里只占住分支，避免回落到项目布局。 -->
      <template v-else-if="store.activeWorkspaceSurface === 'git'" />
      <ChatWorkspace v-else-if="isChatProject" @layout="chatCommandLayout = $event" />
      <ConversationMapPanel v-else-if="isDialogueMapProject" />
      <template v-else-if="isMultiTerminalProject && isProjectLayoutSwapped">
        <ExplorerPane v-show="store.settings.explorerVisible" />
        <div
          v-if="store.settings.explorerVisible"
          class="workspace-resizer"
          role="separator"
          aria-label="调整多终端区域和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <PreviewPane />
      </template>
      <template v-else-if="isMultiTerminalProject">
        <PreviewPane />
        <div
          v-if="store.settings.explorerVisible"
          class="workspace-resizer"
          role="separator"
          aria-label="调整多终端区域和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <ExplorerPane v-show="store.settings.explorerVisible" />
      </template>
      <template v-else-if="store.activeWorkspaceSurface === 'project' && isProjectLayoutSwapped">
        <ExplorerPane v-show="store.settings.explorerVisible" />
        <div
          v-if="store.settings.explorerVisible"
          class="workspace-resizer"
          role="separator"
          aria-label="调整代码预览和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <PreviewPane />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整 CLI 终端和代码预览宽度"
          @pointerdown="startResize('conversation-preview', $event)"
        />
        <TerminalPane mode="cli" />
      </template>
      <template v-else-if="store.activeWorkspaceSurface === 'project'">
        <TerminalPane mode="cli" />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整 CLI 终端和代码预览宽度"
          @pointerdown="startResize('conversation-preview', $event)"
        />
        <PreviewPane />
        <div
          v-if="store.settings.explorerVisible"
          class="workspace-resizer"
          role="separator"
          aria-label="调整代码预览和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <ExplorerPane v-show="store.settings.explorerVisible" />
      </template>
      <KeepAlive>
        <MinecraftPanel v-if="store.activeWorkspaceSurface === 'minecraft'" />
        <GitPanel v-else-if="store.activeWorkspaceSurface === 'git'" />
      </KeepAlive>
      </div>
    </div>
    <ScriptToolsPanel v-if="store.scriptToolsOpen" />
    <MemoWindow v-show="store.memoWindowOpen" />
    <NewConversationDialog />
    <EditorPicker />
    <AppDialog />
  </div>
</template>
