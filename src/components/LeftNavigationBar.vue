<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { X } from 'lucide-vue-next'

import { buildBreadcrumbs } from '@/lib/path'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const activeTab = computed(() => store.activeTab)
const breadcrumbs = computed(() => buildBreadcrumbs(activeTab.value?.path ?? store.workspace?.rootPath ?? ''))
const searchPanelOpen = ref(false)
let searchTimer: number | null = null

function onSearchInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  store.searchQuery = value
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void store.searchProject(value)
  }, 250)
}

function openSearchPanel() {
  searchPanelOpen.value = true
  store.searchOpen = true
}

function closeSearchPanel() {
  searchPanelOpen.value = false
  store.searchOpen = false
}

function openSearchResult(path: string) {
  void store.openFile(path)
  closeSearchPanel()
}

onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer)
})
</script>

<template>
  <nav class="left-nav" aria-label="主导航">
    <div class="left-nav-brand" title="Super High">SH</div>

    <div class="left-nav-group">
      <button
        class="left-nav-button"
        :class="{ active: store.activeWorkspaceSurface === 'project' }"
        title="CLI 对话区域"
        @click="store.setWorkspaceSurface('project')"
      >
        <span>CLI</span>
      </button>
      <button
        class="left-nav-button"
        :class="{ active: store.activeWorkspaceSurface === 'dragon' }"
        title="画布"
        @click="store.setWorkspaceSurface('dragon')"
      >
        <span>画布</span>
      </button>
      <button
        class="left-nav-button"
        :class="{ active: store.activeWorkspaceSurface === 'project' && store.settings.activePreviewMode === 'code' }"
        title="代码预览"
        @click="store.setWorkspaceSurface('project'); store.setPreviewMode('code')"
      >
        <span>Code</span>
      </button>
      <button
        class="left-nav-button"
        :class="{ active: store.activeWorkspaceSurface === 'project' && store.settings.activePreviewMode === 'local_terminal' }"
        title="本地终端显示在代码预览区域"
        @click="store.setWorkspaceSurface('project'); store.setPreviewMode('local_terminal')"
      >
        <span>Term</span>
      </button>
      <button
        class="left-nav-button long-label"
        :class="{ active: store.markdownPreviewEnabled }"
        title="Markdown 预览"
        @click="store.toggleMarkdownPreview()"
      >
        <span>Markdown</span>
      </button>
      <button class="left-nav-button" title="搜索文件名和路径" @click="openSearchPanel">
        <span>Find</span>
      </button>
    </div>

    <div class="left-nav-spacer" />

    <button class="left-nav-button" :title="`设置 · ${store.currentTheme.name}`" @click="store.setSettingsOpen(true)">
      <span>Set</span>
    </button>

    <div v-if="searchPanelOpen" class="nav-search-panel">
      <div class="nav-search-panel-header">
        <div>
          <div class="panel-kicker">Search</div>
          <div class="nav-search-context" :title="breadcrumbs.map((crumb) => crumb.label).join(' / ')">
            {{ activeTab ? activeTab.name : (store.workspace ? store.currentProjectTitle : '当前项目') }}
          </div>
        </div>
        <button class="ghost-button small" @click="closeSearchPanel">
          <X :size="13" />
          <span>关闭</span>
        </button>
      </div>
      <input
        class="nav-search"
        :value="store.searchQuery"
        placeholder="按文件名或路径搜索"
        autofocus
        @input="onSearchInput"
      />
      <div class="nav-search-results">
        <div v-if="store.searchLoading" class="search-empty">正在搜索...</div>
        <template v-else-if="store.searchResults">
          <button
            v-for="file in store.searchResults.files"
            :key="file.path"
            class="search-result-row"
            @click="openSearchResult(file.path)"
          >
            <span>{{ file.name }}</span>
            <span>{{ file.relativePath }}</span>
          </button>
          <button
            v-for="match in store.searchResults.textMatches"
            :key="`${match.path}:${match.lineNumber}:${match.column}`"
            class="search-result-row text"
            @click="openSearchResult(match.path)"
          >
            <span>{{ match.relativePath }}</span>
            <span>{{ match.lineNumber }}:{{ match.column }} · {{ match.preview }}</span>
          </button>
          <div
            v-if="!(store.searchResults.files.length || store.searchResults.textMatches.length)"
            class="search-empty"
          >
            没有匹配结果
          </div>
        </template>
        <div v-else class="search-empty">输入关键词开始搜索。</div>
      </div>
    </div>
  </nav>
</template>
