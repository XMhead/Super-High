<script setup lang="ts">
import { computed } from 'vue'
import { File, FileCode2, FileImage, FileJson, FileText, Folder } from 'lucide-vue-next'

import { extensionFromPath } from '@/lib/path'
import type { DirectoryListing, FileEntry } from '@/types'

const props = defineProps<{
  entry: FileEntry
  depth: number
  directoryCache: Record<string, DirectoryListing>
  expandedPaths: string[]
  selectedPaths: string[]
  activeDirectory: string
}>()

const emit = defineEmits<{
  (event: 'toggle-directory', path: string): void
  (event: 'open-entry', entry: FileEntry, mouseEvent: MouseEvent): void
}>()

const isDirectory = computed(() => props.entry.type === 'directory')
const isExpanded = computed(() => props.expandedPaths.includes(props.entry.path))
const isSelected = computed(() => props.selectedPaths.includes(props.entry.path))
const isActiveDirectory = computed(() => props.activeDirectory === props.entry.path)
const children = computed(() => props.directoryCache[props.entry.path]?.entries ?? [])
const icon = computed(() => {
  if (isDirectory.value) return Folder
  const extension = (props.entry.extension ?? extensionFromPath(props.entry.name)).toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.html', '.rs', '.py'].includes(extension)) return FileCode2
  if (['.json', '.jsonc', '.lock', '.yml', '.yaml', '.toml', '.xml', '.ini'].includes(extension)) return FileJson
  if (['.md', '.mdx', '.txt'].includes(extension)) return FileText
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.mp4', '.webm', '.ogg', '.ogv', '.mov'].includes(extension)) return FileImage
  return File
})

function open(mouseEvent: MouseEvent) {
  emit('open-entry', props.entry, mouseEvent)
}

function toggle(mouseEvent: MouseEvent) {
  mouseEvent.stopPropagation()
  if (!isDirectory.value) return
  emit('toggle-directory', props.entry.path)
}

function forwardToggle(path: string) {
  emit('toggle-directory', path)
}

function forwardOpen(entry: FileEntry, mouseEvent: MouseEvent) {
  emit('open-entry', entry, mouseEvent)
}
</script>

<template>
  <div class="file-manager-tree-node">
    <button
      type="button"
      class="file-manager-tree-row"
      :class="{ expanded: isExpanded, selected: isSelected, active: isActiveDirectory }"
      :style="{ paddingLeft: `${depth * 14 + 6}px` }"
      :title="entry.path"
      @click="open"
    >
      <span class="file-manager-tree-arrow" @click="toggle">{{ isDirectory ? (isExpanded ? '▼' : '▶') : '' }}</span>
      <component :is="icon" :size="15" />
      <span>{{ entry.name }}</span>
    </button>
    <div v-if="isDirectory && isExpanded" class="file-manager-tree-children">
      <FileManagerTreeNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :directory-cache="directoryCache"
        :expanded-paths="expandedPaths"
        :selected-paths="selectedPaths"
        :active-directory="activeDirectory"
        @toggle-directory="forwardToggle"
        @open-entry="forwardOpen"
      />
      <div v-if="!children.length" class="file-manager-tree-empty" :style="{ paddingLeft: `${(depth + 1) * 14 + 27}px` }">
        空目录
      </div>
    </div>
  </div>
</template>
