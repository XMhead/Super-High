<script setup lang="ts">
import { computed } from 'vue'

import { fileNameFromPath } from '@/lib/path'
import type { GitCommitFile } from '@/types'

const props = defineProps<{
  file: Pick<GitCommitFile, 'path' | 'oldPath' | 'status' | 'additions' | 'deletions'>
  active: boolean
}>()

const name = computed(() => fileNameFromPath(props.file.path))
const directory = computed(() => {
  const index = props.file.path.lastIndexOf('/')
  return index > 0 ? props.file.path.slice(0, index) : ''
})
const title = computed(() => props.file.oldPath ? `${props.file.oldPath} → ${props.file.path}` : props.file.path)
const statusClass = computed(() => {
  const value = props.file.status
  if (value === 'A' || value === '?') return 'git-status--add'
  if (value === 'D') return 'git-status--delete'
  if (value === 'R' || value === 'C') return 'git-status--rename'
  if (value === 'U') return 'git-status--conflict'
  return 'git-status--modify'
})
</script>

<template>
  <button type="button" class="git-file-row" :class="{ active }" :title="title">
    <span class="git-status-letter" :class="statusClass">{{ file.status }}</span>
    <span class="git-file-name">{{ name }}</span>
    <span class="git-file-dir">{{ directory }}</span>
    <span v-if="file.additions || file.deletions" class="git-file-stat">
      <span v-if="file.additions" class="git-stat-add">+{{ file.additions }}</span>
      <span v-if="file.deletions" class="git-stat-del">−{{ file.deletions }}</span>
    </span>
  </button>
</template>

<style scoped>
.git-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.git-file-row:hover {
  background: var(--color-bg-hover);
}

.git-file-row.active {
  background: var(--surface-accent-blue-soft);
}

.git-status-letter {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: var(--sh-weight-emphasis);
  line-height: 1;
}

.git-status--add { color: var(--color-accent-green); }
.git-status--delete { color: var(--color-accent-red); }
.git-status--modify { color: var(--color-accent-yellow); }
.git-status--rename { color: var(--color-accent-purple); }
.git-status--conflict { color: var(--color-accent-red); }

.git-file-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-file-dir {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-file-stat {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.git-stat-add { color: var(--color-accent-green); }
.git-stat-del { color: var(--color-accent-red); }
</style>
