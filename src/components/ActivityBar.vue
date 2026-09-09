<script setup lang="ts">
import { FileCode2, Files, GitBranch, Image as ImageIcon, MessageSquare, Network, Puzzle, RadioTower, Settings, TerminalSquare } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()

function openProjectSurface() {
  store.setWorkspaceSurface('project')
}

function openTerminalPreview() {
  store.setWorkspaceSurface('project')
  store.setPreviewMode('local_terminal')
}

function openDocs() {
  void store.ensureVitePressDocs()
}
</script>

<template>
  <nav class="activity-bar" aria-label="活动栏">
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'editor' }"
      title="编辑器预览"
      :disabled="!store.workspace"
      @click="store.setWorkspaceSurface('editor')"
    >
      <FileCode2 :size="17" />
    </button>
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'project' }"
      title="对话列表"
      @click="openProjectSurface"
    >
      <MessageSquare :size="17" />
    </button>
    <button class="activity-button" title="Git">
      <GitBranch :size="17" />
    </button>
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'files' }"
      data-testid="files-activity"
      title="文件管理器"
      :disabled="!store.workspace"
      @click="store.setWorkspaceSurface('files')"
    >
      <Files :size="17" />
    </button>
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'docs' }"
      title="文档预览"
      :disabled="!store.workspace"
      @click="openDocs"
    >
      <Network :size="17" />
    </button>
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'channels' }"
      data-testid="channels-activity"
      title="渠道检测"
      @click="store.setWorkspaceSurface('channels')"
    >
      <RadioTower :size="17" />
    </button>
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'project' && store.settings.activePreviewMode === 'local_terminal' }"
      title="终端"
      @click="openTerminalPreview"
    >
      <TerminalSquare :size="17" />
    </button>
    <button
      v-for="command in store.pluginCommands"
      :key="command.id"
      class="activity-button plugin-command-button"
      :data-testid="`plugin-command-${command.id}`"
      :title="command.tooltip || command.title"
      @click="store.runPluginCommand(command.id)"
    >
      <Puzzle :size="17" />
    </button>
    <div class="activity-divider" />
    <div class="activity-spacer" />
    <button class="activity-button" :class="{ active: store.settingsOpen }" title="设置" @click="store.setSettingsOpen(true)">
      <Settings :size="17" />
    </button>
  </nav>
</template>
