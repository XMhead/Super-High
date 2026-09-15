<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import EditorPane from './EditorPane.vue'
import ProjectEditorPanel from './ProjectEditorPanel.vue'
import TerminalPane from './TerminalPane.vue'
import CliTerminalGrid from './CliTerminalGrid.vue'

const store = useWorkspaceStore()
const showProjectEditor = computed(() => (
  store.settings.activePreviewMode === 'code'
  && store.codePreviewProjectEditorOpen
))
</script>

<template>
  <aside class="panel shared-preview-panel">
    <CliTerminalGrid v-if="store.settings.multiTerminalMode" />
    <ProjectEditorPanel v-else-if="showProjectEditor" embedded />
    <EditorPane v-else-if="store.settings.activePreviewMode === 'code'" />
    <TerminalPane v-else mode="local" />
  </aside>
</template>
