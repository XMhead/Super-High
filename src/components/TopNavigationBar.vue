<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { Code2, FileText, Settings, Terminal } from 'lucide-vue-next'

import { buildBreadcrumbs } from '@/lib/path'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const activeTab = computed(() => store.activeTab)
const breadcrumbs = computed(() => buildBreadcrumbs(activeTab.value?.path ?? store.workspace?.rootPath ?? ''))
let searchTimer: number | null = null

function onSearchInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  store.searchQuery = value
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void store.searchProject(value)
  }, 250)
}

onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer)
})
</script>

<template>
  <header class="top-nav">
    <div class="breadcrumb-strip">
      <button
        v-for="crumb in breadcrumbs"
        :key="crumb.path"
        class="breadcrumb-button"
        @click="store.openPath(crumb.path)"
      >
        {{ crumb.label }}
      </button>
    </div>

    <div class="search-slot">
      <input
        class="nav-search"
        :value="store.searchQuery"
        placeholder="按文件名或路径搜索"
        @input="onSearchInput"
        @focus="store.searchOpen = true"
      />
      <div v-if="store.searchOpen && (store.searchResults || store.searchLoading)" class="search-dropdown">
        <div v-if="store.searchLoading" class="search-empty">正在搜索...</div>
        <template v-else>
          <button
            v-for="file in store.searchResults?.files ?? []"
            :key="file.path"
            class="search-result-row"
            @click="store.openFile(file.path); store.searchOpen = false"
          >
            <span>{{ file.name }}</span>
            <span>{{ file.relativePath }}</span>
          </button>
          <button
            v-for="match in store.searchResults?.textMatches ?? []"
            :key="`${match.path}:${match.lineNumber}:${match.column}`"
            class="search-result-row text"
            @click="store.openFile(match.path); store.searchOpen = false"
          >
            <span>{{ match.relativePath }}</span>
            <span>{{ match.lineNumber }}:{{ match.column }} · {{ match.preview }}</span>
          </button>
          <div
            v-if="!(store.searchResults?.files.length || store.searchResults?.textMatches.length)"
            class="search-empty"
          >
            没有匹配结果
          </div>
        </template>
      </div>
    </div>

    <div class="nav-actions">
      <button
        class="mode-button"
        :class="{ active: store.settings.activePreviewMode === 'code' }"
        type="button"
        title="代码预览"
        @click="store.setPreviewMode('code')"
      >
        <Code2 class="mode-button-icon" :size="14" />
        <span>代码预览</span>
      </button>
      <button
        class="mode-button"
        :class="{ active: store.settings.activePreviewMode === 'local_terminal' }"
        type="button"
        title="本地终端"
        @click="store.setPreviewMode('local_terminal')"
      >
        <Terminal class="mode-button-icon" :size="14" />
        <span>本地终端</span>
      </button>
      <button
        class="mode-button"
        :class="{ active: store.markdownPreviewEnabled }"
        type="button"
        title="Markdown 渲染模式"
        @click="store.toggleMarkdownPreview()"
      >
        <FileText class="mode-button-icon" :size="12" />
        <span>Markdown</span>
      </button>
      <button class="ghost-button" @click="store.setSettingsOpen(true)">
        <Settings :size="13" />
        <span>设置 · {{ store.currentTheme.name }}</span>
      </button>
      <div class="nav-state">{{ activeTab ? (activeTab.isDirty ? '未保存' : '已打开') : '选择文件后显示路径' }}</div>
    </div>
  </header>
</template>
