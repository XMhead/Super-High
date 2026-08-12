<script setup lang="ts">
import { File, FileCode2, FileImage, FileJson, FileText } from 'lucide-vue-next'
import { computed, nextTick } from 'vue'

import type { FileEntry } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'

const props = defineProps<{
  entry: FileEntry
  depth: number
  contextMenuPath?: string | null
}>()

const emit = defineEmits<{
  (event: 'node-context-menu', entry: FileEntry, mouseEvent: MouseEvent): void
  (event: 'node-file-open', entry: FileEntry): void
}>()

const TREE_INDENT_PX = 14
const TREE_ROW_START_PX = 8
const TREE_LABEL_OFFSET_PX = 25

const store = useWorkspaceStore()
const isDirectory = computed(() => props.entry.type === 'directory')
const isExpanded = computed(() => store.expandedPaths.includes(props.entry.path))
const isLoading = computed(() => store.loadingDirectories.includes(props.entry.path))
const isActive = computed(() => store.activeTab?.path === props.entry.path)
const isFocused = computed(() => store.explorerFocusedPath === props.entry.path)
const isContextTarget = computed(() => props.contextMenuPath === props.entry.path)
const hasDirectoryListing = computed(() => store.directoryCache[props.entry.path] !== undefined)
const children = computed(() => {
  return store.directoryCache[props.entry.path]?.entries ?? []
})
const iconTone = computed(() => {
  const extension = props.entry.extension?.toLowerCase() ?? ''
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.html', '.rs'].includes(extension)) return 'code'
  if (['.json', '.jsonc', '.lock', '.yml', '.yaml', '.toml', '.xml', '.ini'].includes(extension)) return 'data'
  if (['.md', '.mdx', '.txt'].includes(extension)) return 'document'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)) return 'image'
  return 'file'
})
const iconComponent = computed(() => {
  switch (iconTone.value) {
    case 'code':
      return FileCode2
    case 'data':
      return FileJson
    case 'document':
      return FileText
    case 'image':
      return FileImage
    default:
      return File
  }
})

function restoreScrollTopOnNextFrames(scrollContainer: HTMLElement | null, scrollTop: number) {
  if (!scrollContainer || scrollTop <= 0) return
  void nextTick().then(() => {
    if (scrollContainer.isConnected) scrollContainer.scrollTop = scrollTop
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (scrollContainer.isConnected) scrollContainer.scrollTop = scrollTop
      })
    }
  })
}

async function activate(event?: MouseEvent) {
  if (isDirectory.value) {
    const scrollContainer = event instanceof MouseEvent
      ? (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.explorer-body') ?? null
      : null
    const scrollTop = scrollContainer?.scrollTop ?? 0
    const toggleTask = store.toggleDirectory(props.entry.path)
    restoreScrollTopOnNextFrames(scrollContainer, scrollTop)
    await toggleTask
    restoreScrollTopOnNextFrames(scrollContainer, scrollTop)
  } else {
    emit('node-file-open', props.entry)
  }
}

function openContextMenu(event: MouseEvent) {
  emit('node-context-menu', props.entry, event)
}

function forwardContextMenu(entry: FileEntry, mouseEvent: MouseEvent) {
  emit('node-context-menu', entry, mouseEvent)
}

function forwardFileOpen(entry: FileEntry) {
  emit('node-file-open', entry)
}

</script>

<template>
  <div class="tree-node">
    <button
      type="button"
      class="tree-entry"
      :class="{ active: isActive, focused: isFocused, hidden: entry.isHidden, context: isContextTarget }"
      :style="{ paddingLeft: `${depth * TREE_INDENT_PX + TREE_ROW_START_PX}px` }"
      :title="entry.path"
      :data-path="entry.path"
      @click="activate"
      @contextmenu.prevent.stop="openContextMenu"
    >
      <span v-if="isDirectory" class="tree-disclosure">{{ isLoading ? '...' : isExpanded ? '▼' : '▶' }}</span>
      <span v-else class="tree-kind-icon" :class="iconTone" aria-hidden="true">
        <component :is="iconComponent" :size="15" :stroke-width="1.9" />
      </span>
      <span class="tree-name">{{ entry.name }}</span>
    </button>
    <div v-if="isDirectory && isExpanded" class="tree-children">
      <FileTreeNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :context-menu-path="contextMenuPath"
        @node-context-menu="forwardContextMenu"
        @node-file-open="forwardFileOpen"
      />
      <div v-if="isLoading && !hasDirectoryListing" class="tree-hint" :style="{ paddingLeft: `${(depth + 1) * TREE_INDENT_PX + TREE_LABEL_OFFSET_PX}px` }">读取中...</div>
      <div v-else-if="hasDirectoryListing && !children.length" class="tree-hint" :style="{ paddingLeft: `${(depth + 1) * TREE_INDENT_PX + TREE_LABEL_OFFSET_PX}px` }">空目录</div>
    </div>
  </div>
</template>
