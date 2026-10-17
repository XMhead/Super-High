<script setup lang="ts">
import { computed } from 'vue'
import { TerminalSquare } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import TerminalPane from './TerminalPane.vue'

const store = useWorkspaceStore()
const sessions = computed(() => store.cliTerminalSessions)

</script>

<template>
  <section class="cli-terminal-grid" :class="{ 'cli-terminal-grid--many': sessions.length > 9 }" aria-label="多终端对话">
    <div v-if="!sessions.length" class="cli-terminal-grid-empty">
      <TerminalSquare :size="20" />
      <span>从对话列表新建 CLI 会话</span>
    </div>
    <TerminalPane
      v-for="session in sessions"
      :key="session.id"
      mode="cli"
      :session-ids="[session.id]"
      :active-session-id="session.id"
      compact-team
      class="cli-terminal-grid-cell"
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
  grid-template: repeat(3, minmax(0, 1fr)) / repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  overflow: hidden;
  background: var(--color-bg-secondary);
}

.cli-terminal-grid-cell {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--color-border);
}

.cli-terminal-grid--many {
  grid-template-rows: none;
  grid-auto-rows: minmax(220px, 1fr);
  overflow-y: auto;
}

.cli-terminal-grid-empty {
  grid-area: 1 / 1 / -1 / -1;
  min-height: 0;
  display: grid;
  place-content: center;
  gap: 8px;
  justify-items: center;
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
