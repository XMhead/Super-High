<script setup lang="ts">
import { Files, Gamepad2, MessageSquare, Puzzle, Settings } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()

function openProjectSurface() {
  store.setWorkspaceSurface('project')
}

</script>

<template>
  <nav class="activity-bar" aria-label="活动栏">
    <button
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'project' }"
      title="对话列表"
      @click="openProjectSurface"
    >
      <MessageSquare :size="17" />
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
      v-if="store.minecraftClientAvailable"
      class="activity-button"
      :class="{ active: !store.settingsOpen && store.activeWorkspaceSurface === 'minecraft' }"
      data-testid="minecraft-activity"
      title="Minecraft"
      @click="store.setWorkspaceSurface('minecraft')"
    >
      <Gamepad2 :size="17" />
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
