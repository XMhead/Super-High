<script setup lang="ts">
import { computed } from 'vue'
import { TerminalSquare } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import TerminalPane from './TerminalPane.vue'

const store = useWorkspaceStore()
const sessions = computed(() => store.cliTerminalSessions)

const layoutClass = computed(() => {
  const count = sessions.value.length
  if (count <= 1) return 'one'
  if (count === 2) return 'two'
  if (count === 3) return 'three'
  if (count === 4) return 'four'
  if (count === 5) return 'five'
  if (count === 6) return 'six'
  if (count === 7) return 'seven'
  if (count === 8) return 'eight'
  if (count === 9) return 'nine'
  return 'many'
})
</script>

<template>
  <section class="cli-terminal-grid" :class="`cli-terminal-grid--${layoutClass}`" aria-label="多终端对话">
    <div v-if="!sessions.length" class="cli-terminal-grid-empty">
      <TerminalSquare :size="20" />
      <span>从对话列表新建 CLI 会话</span>
    </div>
    <TerminalPane
      v-for="(session, index) in sessions"
      :key="session.id"
      mode="cli"
      :session-ids="[session.id]"
      :active-session-id="session.id"
      compact-team
      class="cli-terminal-grid-cell"
      :class="{ 'cli-terminal-grid-cell--last': index === sessions.length - 1 }"
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
  overflow: hidden;
  background: var(--color-bg-secondary);
}

.cli-terminal-grid-cell {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--color-border);
}

.cli-terminal-grid--one {
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
}

.cli-terminal-grid--two {
  grid-template: minmax(0, 1fr) / repeat(2, minmax(0, 1fr));
}

.cli-terminal-grid--three {
  grid-template: minmax(0, 1fr) / repeat(3, minmax(0, 1fr));
}

.cli-terminal-grid--four {
  grid-template: repeat(2, minmax(0, 1fr)) / repeat(2, minmax(0, 1fr));
}

.cli-terminal-grid--five,
.cli-terminal-grid--six {
  grid-template: repeat(2, minmax(0, 1fr)) / repeat(3, minmax(0, 1fr));
}

.cli-terminal-grid--five .cli-terminal-grid-cell--last {
  grid-column: span 2;
}

.cli-terminal-grid--seven,
.cli-terminal-grid--eight,
.cli-terminal-grid--nine {
  grid-template: repeat(3, minmax(0, 1fr)) / repeat(3, minmax(0, 1fr));
}

.cli-terminal-grid--seven .cli-terminal-grid-cell--last {
  grid-column: span 3;
}

.cli-terminal-grid--eight .cli-terminal-grid-cell--last {
  grid-column: span 2;
}

.cli-terminal-grid--many {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: minmax(220px, 1fr);
  overflow-y: auto;
}

.cli-terminal-grid-empty {
  min-height: 0;
  display: grid;
  place-content: center;
  gap: 8px;
  justify-items: center;
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
