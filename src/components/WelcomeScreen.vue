<script setup lang="ts">
import { FolderOpen } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
</script>

<template>
  <div class="welcome-screen">
    <div class="welcome-panel">
      <div class="welcome-brand">
        <span class="welcome-badge">Super High</span>
        <h1>工作区复刻版已就绪</h1>
        <p>按参考仓库的主界面结构打开本地项目，进入文件树、编辑区、预览区和项目 Skills 管理。</p>
      </div>

      <div class="welcome-actions">
        <button class="primary-button" @click="store.openProject()">
          <FolderOpen :size="14" />
          <span>打开项目</span>
        </button>
      </div>

      <div class="settings-path">当前主题：{{ store.currentTheme.name }}</div>

      <div class="recent-projects">
        <div class="section-title">最近项目</div>
        <button
          v-for="project in store.visibleRecentProjects"
          :key="project.path"
          class="recent-project-card"
          @click="store.openProject(project.path)"
        >
          <div class="recent-project-name">{{ store.recentProjectTitle(project) }}</div>
          <div class="recent-project-path">{{ project.path }}</div>
          <div class="recent-project-time">{{ project.lastOpenedAt }}</div>
        </button>
        <div v-if="!store.visibleRecentProjects.length" class="empty-hint">还没有最近项目记录。</div>
      </div>
    </div>
  </div>
</template>
