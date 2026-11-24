<script setup lang="ts">
import { useWorkspaceStore } from '@/stores/workspace'
import EditorPane from './EditorPane.vue'
import CliTerminalGrid from './CliTerminalGrid.vue'

const store = useWorkspaceStore()
</script>

<template>
  <aside class="panel shared-preview-panel">
    <CliTerminalGrid v-if="store.settings.multiTerminalMode" />
    <EditorPane v-else />
  </aside>
</template>
