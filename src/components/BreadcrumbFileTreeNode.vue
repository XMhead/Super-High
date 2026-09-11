<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, ChevronRight, FileText } from 'lucide-vue-next'

import { normalizePath } from '@/lib/path'
import type { FileEntry } from '@/types'

const props = defineProps<{
  entry: FileEntry
  depth: number
  activePath?: string | null
  expanded?: boolean
}>()

const emit = defineEmits<{
  (event: 'directory-open', path: string): void
  (event: 'file-open', path: string): void
  (event: 'context-menu', path: string, mouseEvent: MouseEvent): void
}>()

const isDirectory = computed(() => props.entry.type === 'directory')
const isActive = computed(() => normalizePath(props.entry.path).toLowerCase() === normalizePath(props.activePath ?? '').toLowerCase())

function activate() {
  if (isDirectory.value) {
    emit('directory-open', props.entry.path)
    return
  }
  emit('file-open', props.entry.path)
}

function openContextMenu(event: MouseEvent) {
  emit('context-menu', props.entry.path, event)
}
</script>

<template>
  <div class="breadcrumb-picker-node">
    <button
      type="button"
      class="breadcrumb-picker-row"
      :class="{ active: isActive, directory: isDirectory, file: !isDirectory }"
      :style="{ paddingLeft: `${depth * 8 + 8}px` }"
      :title="entry.path"
      @click="activate"
      @contextmenu.prevent.stop="openContextMenu"
    >
      <ChevronDown v-if="isDirectory && expanded" :size="15" class="breadcrumb-picker-icon directory" />
      <ChevronRight v-else-if="isDirectory" :size="15" class="breadcrumb-picker-icon directory" />
      <FileText v-else :size="14" class="breadcrumb-picker-icon file" />
      <span class="breadcrumb-picker-name">{{ entry.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.breadcrumb-picker-node {
  min-width: 0;
}

.breadcrumb-picker-row {
  width: max-content;
  min-width: 100%;
  max-width: min(380px, calc(100vw - 48px));
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  outline: 0;
  padding-right: 8px;
  cursor: pointer;
}

.breadcrumb-picker-row:hover,
.breadcrumb-picker-row.active {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.breadcrumb-picker-icon {
  width: 15px;
  flex: none;
}

.breadcrumb-picker-icon.directory {
  color: var(--color-accent-yellow);
}

.breadcrumb-picker-icon.file {
  color: var(--color-text-muted);
}

.breadcrumb-picker-name {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
