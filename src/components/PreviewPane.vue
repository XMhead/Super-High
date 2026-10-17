<script setup lang="ts">
import { ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import EditorPane from './EditorPane.vue'
import TerminalPane from './TerminalPane.vue'
import CliTerminalGrid from './CliTerminalGrid.vue'
import PreviewChangesPane from './PreviewChangesPane.vue'

const store = useWorkspaceStore()
const changesMode = ref(false)
</script>

<template>
  <aside class="panel shared-preview-panel">
    <CliTerminalGrid v-if="store.settings.multiTerminalMode" />
    <div v-else-if="store.settings.activePreviewMode === 'code'" class="previewchanges-region">
      <EditorPane v-show="!changesMode" />
      <PreviewChangesPane @mode-change="changesMode = $event" />
    </div>
    <TerminalPane v-else mode="local" />
  </aside>
</template>
