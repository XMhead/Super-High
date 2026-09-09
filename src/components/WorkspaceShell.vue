<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

import AppTopBar from './AppTopBar.vue'
import ActivityBar from './ActivityBar.vue'
import ConversationSidebar from './ConversationSidebar.vue'
import DragonCoreToolsWindowManager from './DragonCoreToolsWindowManager.vue'
import ExplorerPane from './ExplorerPane.vue'
import FileManagerPanel from './FileManagerPanel.vue'

import ItemLibrarySearchDialog from './ItemLibrarySearchDialog.vue'
import MinecraftPanel from './MinecraftPanel.vue'
import MemoWindow from './MemoWindow.vue'
import NewConversationDialog from './NewConversationDialog.vue'
import TerminalPane from './TerminalPane.vue'

const ChannelProbePanel = defineAsyncComponent(() => import('./ChannelProbePanel.vue'))
const ConversationMapPanel = defineAsyncComponent(() => import('./ConversationMapPanel.vue'))
const DocsWorkspacePanel = defineAsyncComponent(() => import('./DocsWorkspacePanel.vue'))
const ProjectEditorPanel = defineAsyncComponent(() => import('./ProjectEditorPanel.vue'))
const ScriptToolsPanel = defineAsyncComponent(() => import('./ScriptToolsPanel.vue'))
const DragonImagePanel = defineAsyncComponent(() => import('./DragonImagePanel.vue'))
const SettingsDrawer = defineAsyncComponent(() => import('./SettingsDrawer.vue'))

const store = useWorkspaceStore()
const PreviewPane = defineAsyncComponent(() => import('./PreviewPane.vue'))
const isProjectLayoutSwapped = computed(() => store.settings.projectLayoutMode === 'swapped')
const isMultiTerminalMode = computed(() => store.settings.multiTerminalMode)
const isDialogueMapProject = computed(() => (
  store.settings.dialogueMapMode && store.activeWorkspaceSurface === 'project'
))
const isMultiTerminalProject = computed(() => (
  isMultiTerminalMode.value && store.activeWorkspaceSurface === 'project'
))
const hasEmbeddedProjectEditor = computed(() => (
  !isMultiTerminalProject.value
  &&
  store.activeWorkspaceSurface === 'project'
  && store.settings.activePreviewMode === 'code'
  && store.codePreviewProjectEditorOpen
))

type ResizeTarget = 'conversation-preview' | 'preview-explorer'

let activeResize: {
  target: ResizeTarget
  startX: number
  conversationWidth: number
  explorerWidth: number
} | null = null

const mainGridStyle = computed(() => {
  const layout = store.settings.panelLayout
  if (isDialogueMapProject.value) {
    return {
      gridTemplateColumns: '44px minmax(0, 1fr)',
    }
  }
  if (isMultiTerminalProject.value && isProjectLayoutSwapped.value) {
    return {
      gridTemplateColumns: `44px minmax(160px, ${layout.explorerWidth}px) 1px minmax(480px, 1fr) 130px`,
    }
  }
  if (isMultiTerminalProject.value) {
    return {
      gridTemplateColumns: `44px 130px minmax(480px, 1fr) 1px minmax(160px, ${layout.explorerWidth}px)`,
    }
  }
  if (hasEmbeddedProjectEditor.value && isProjectLayoutSwapped.value) {
    return {
      gridTemplateColumns: `44px minmax(720px, 1fr) 1px minmax(300px, ${layout.conversationWidth}px) 130px`,
    }
  }
  if (hasEmbeddedProjectEditor.value) {
    return {
      gridTemplateColumns: `44px 130px minmax(300px, ${layout.conversationWidth}px) 1px minmax(720px, 1fr)`,
    }
  }
  if (isProjectLayoutSwapped.value) {
    return {
      gridTemplateColumns: `44px minmax(160px, ${layout.explorerWidth}px) 1px minmax(280px, 1fr) 1px minmax(300px, ${layout.conversationWidth}px) 130px`,
    }
  }
  return {
    gridTemplateColumns: `44px 130px minmax(300px, ${layout.conversationWidth}px) 1px minmax(280px, 1fr) 1px minmax(160px, ${layout.explorerWidth}px)`,
  }
})

function startResize(target: ResizeTarget, event: PointerEvent) {
  event.preventDefault()
  activeResize = {
    target,
    startX: event.clientX,
    conversationWidth: store.settings.panelLayout.conversationWidth,
    explorerWidth: store.settings.panelLayout.explorerWidth,
  }
  document.documentElement.classList.add('is-resizing-panels')
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
}

function onResizeMove(event: PointerEvent) {
  if (!activeResize) return
  const delta = event.clientX - activeResize.startX
  if (activeResize.target === 'conversation-preview') {
    store.setPanelLayoutSize('conversationWidth', activeResize.conversationWidth + (isProjectLayoutSwapped.value ? -delta : delta))
    return
  }

  store.setPanelLayoutSize('explorerWidth', activeResize.explorerWidth + (isProjectLayoutSwapped.value ? delta : -delta))
}

function stopResize() {
  if (!activeResize) return
  activeResize = null
  document.documentElement.classList.remove('is-resizing-panels')
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  void store.saveSettings()
}

onBeforeUnmount(() => {
  activeResize = null
  document.documentElement.classList.remove('is-resizing-panels')
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
})
</script>

<template>
  <div class="workspace-shell">
    <AppTopBar />
    <div class="workspace-main" :class="{ 'project-layout-swapped': isProjectLayoutSwapped }" :style="mainGridStyle">
      <ActivityBar />
      <SettingsDrawer v-if="store.settingsOpen" />
      <div v-show="!store.settingsOpen" class="workspace-surface">
      <FileManagerPanel v-if="store.activeWorkspaceSurface === 'files'" />
      <ProjectEditorPanel v-else-if="store.activeWorkspaceSurface === 'editor'" />
      <DocsWorkspacePanel v-else-if="store.activeWorkspaceSurface === 'docs'" />
      <ChannelProbePanel v-else-if="store.activeWorkspaceSurface === 'channels'" />
      <DragonImagePanel v-else-if="store.activeWorkspaceSurface === 'dragon'" />
      <ConversationMapPanel v-else-if="isDialogueMapProject" />
      <template v-else-if="isMultiTerminalProject && isProjectLayoutSwapped">
        <ExplorerPane />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整多终端区域和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <PreviewPane />
        <ConversationSidebar />
      </template>
      <template v-else-if="isMultiTerminalProject">
        <ConversationSidebar />
        <PreviewPane />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整多终端区域和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <ExplorerPane />
      </template>
      <template v-else-if="store.activeWorkspaceSurface === 'project' && isProjectLayoutSwapped">
        <ExplorerPane v-if="!hasEmbeddedProjectEditor" />
        <div
          v-if="!hasEmbeddedProjectEditor"
          class="workspace-resizer"
          role="separator"
          aria-label="调整代码预览和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <PreviewPane />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整对话列表和代码预览宽度"
          @pointerdown="startResize('conversation-preview', $event)"
        />
        <TerminalPane mode="cli" />
        <ConversationSidebar />
      </template>
      <template v-else-if="store.activeWorkspaceSurface === 'project'">
        <ConversationSidebar />
        <TerminalPane mode="cli" />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整对话列表和代码预览宽度"
          @pointerdown="startResize('conversation-preview', $event)"
        />
        <PreviewPane />
        <div
          v-if="!hasEmbeddedProjectEditor"
          class="workspace-resizer"
          role="separator"
          aria-label="调整代码预览和文件资源管理器宽度"
          @pointerdown="startResize('preview-explorer', $event)"
        />
        <ExplorerPane v-if="!hasEmbeddedProjectEditor" />
      </template>
      <KeepAlive>
        <MinecraftPanel v-if="store.activeWorkspaceSurface === 'minecraft'" />
      </KeepAlive>
      </div>
    </div>
    <ScriptToolsPanel v-if="store.scriptToolsOpen" />
    <MemoWindow v-show="store.memoWindowOpen" />
    <ItemLibrarySearchDialog />
    <NewConversationDialog />
    <DragonCoreToolsWindowManager />
  </div>
</template>
