<script setup lang="ts">
import { useWorkspaceStore } from '@/stores/workspace'
import EditorPane from './EditorPane.vue'
import TerminalPane from './TerminalPane.vue'
import CliTerminalGrid from './CliTerminalGrid.vue'

const store = useWorkspaceStore()
</script>

<template>
  <aside class="panel shared-preview-panel">
    <CliTerminalGrid v-if="store.settings.multiTerminalMode" />
    <EditorPane v-else-if="store.settings.activePreviewMode === 'code'" />
    <TerminalPane v-else mode="local" />
  </aside>
</template>
