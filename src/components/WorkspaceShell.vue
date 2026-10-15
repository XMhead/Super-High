<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

import AppTopBar from './AppTopBar.vue'
import AppDialog from './AppDialog.vue'
import ActivityBar from './ActivityBar.vue'
import ConversationSidebar from './ConversationSidebar.vue'
import ExplorerPane from './ExplorerPane.vue'
import FileManagerPanel from './FileManagerPanel.vue'

import MinecraftPanel from './MinecraftPanel.vue'
import MemoWindow from './MemoWindow.vue'
import NewConversationDialog from './NewConversationDialog.vue'
import TerminalPane from './TerminalPane.vue'

const ConversationMapPanel = defineAsyncComponent(() => import('./ConversationMapPanel.vue'))
const DocsWorkspacePanel = defineAsyncComponent(() => import('./DocsWorkspacePanel.vue'))
const ScriptToolsPanel = defineAsyncComponent(() => import('./ScriptToolsPanel.vue'))
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
  const columns = [isMultiTerminalProject.value ? 'minmax(480px, 1fr)' : 'minmax(280px, 1fr)']
  if (!isMultiTerminalProject.value) {
    columns.unshift(`minmax(300px, ${layout.conversationWidth}px)`, '1px')
  }
  if (store.settings.conversationSidebarVisible) columns.unshift('130px')
  if (store.settings.explorerVisible) {
    columns.push('1px', `minmax(160px, ${layout.explorerWidth}px)`)
  }
  if (isProjectLayoutSwapped.value) columns.reverse()
  return { gridTemplateColumns: ['44px', ...columns].join(' ') }
})

const commandLayout = computed(() => {
  if (store.settingsOpen || store.activeWorkspaceSurface !== 'project' || isDialogueMapProject.value || isMultiTerminalProject.value) return undefined
  const sidebarColumns = store.settings.conversationSidebarVisible ? 1 : 0
  const explorerColumns = store.settings.explorerVisible ? 2 : 0
  const separatorColumn = isProjectLayoutSwapped.value ? 3 + explorerColumns : 3 + sidebarColumns
  const previewColumns = isProjectLayoutSwapped.value ? `1 / ${separatorColumn}` : `${separatorColumn + 1} / -1`
  const cliColumns = isProjectLayoutSwapped.value ? `${separatorColumn + 1} / -1` : `1 / ${separatorColumn}`
  return { ...mainGridStyle.value, previewColumns, cliColumns, previewOnRight: !isProjectLayoutSwapped.value }
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
  activeResize = null
  document.documentElement.classList.remove('is-resizing-panels')
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
})
</script>

<template>
  <div class="workspace-shell">
    <AppTopBar :command-layout="commandLayout" />
    <div class="workspace-main" :class="{ 'project-layout-swapped': isProjectLayoutSwapped }" :style="mainGridStyle">
      <ActivityBar />
      <SettingsDrawer v-if="store.settingsOpen" />
      <div v-show="!store.settingsOpen" class="workspace-surface">
      <FileManagerPanel v-if="store.activeWorkspaceSurface === 'files'" />
      <DocsWorkspacePanel v-else-if="store.activeWorkspaceSurface === 'docs'" />
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
        <ConversationSidebar v-show="store.settings.conversationSidebarVisible" />
      </template>
      <template v-else-if="isMultiTerminalProject">
        <ConversationSidebar v-show="store.settings.conversationSidebarVisible" />
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
          aria-label="调整对话列表和代码预览宽度"
          @pointerdown="startResize('conversation-preview', $event)"
        />
        <TerminalPane mode="cli" />
        <ConversationSidebar v-show="store.settings.conversationSidebarVisible" />
      </template>
      <template v-else-if="store.activeWorkspaceSurface === 'project'">
        <ConversationSidebar v-show="store.settings.conversationSidebarVisible" />
        <TerminalPane mode="cli" />
        <div
          class="workspace-resizer"
          role="separator"
          aria-label="调整对话列表和代码预览宽度"
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
      </KeepAlive>
      </div>
    </div>
    <ScriptToolsPanel v-if="store.scriptToolsOpen" />
    <MemoWindow v-show="store.memoWindowOpen" />
    <NewConversationDialog />
    <AppDialog />
  </div>
</template>
