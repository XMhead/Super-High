<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { useWorkspaceStore } from '@/stores/workspace'
import { terminalGridLayout } from '@/lib/terminalGridLayout'
import TerminalPane from './TerminalPane.vue'

const store = useWorkspaceStore()
const sessions = computed(() => store.cliTerminalSessions)
const grid = ref<HTMLElement | null>(null)
const gridSize = ref({ width: 0, height: 0 })
const layout = computed(() => terminalGridLayout(sessions.value.length, gridSize.value.width, gridSize.value.height))
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${layout.value.columns}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${layout.value.rows}, minmax(220px, 1fr))`,
}))
let observer: ResizeObserver | null = null

onMounted(() => {
  if (!grid.value) return
  observer = new ResizeObserver(([entry]) => { gridSize.value = { width: entry.contentRect.width, height: entry.contentRect.height } })
  observer.observe(grid.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <section ref="grid" class="cli-terminal-grid" :style="gridStyle" aria-label="多终端对话">
    <TerminalPane v-if="!sessions.length" mode="cli" class="cli-terminal-grid-cell" />
    <TerminalPane
      v-for="(session, index) in sessions"
      :key="session.id"
      mode="cli"
      :session-ids="[session.id]"
      :active-session-id="session.id"
      compact-team
      :show-launcher="index === 0"
      class="cli-terminal-grid-cell"
      :style="{ gridColumn: `span ${layout.spans[index] ?? 1}` }"
    />
  </section>
</template>

<style scoped>
.cli-terminal-grid {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 4px;
  padding: 4px;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--color-bg-secondary);
}

.cli-terminal-grid-cell {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--color-border);
}

</style>
