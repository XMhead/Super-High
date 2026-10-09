<script setup lang="ts">
import { ref } from 'vue'
import WorkspaceShell from '@/components/WorkspaceShell.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DesktopPreviewOptions } from './options'
import type { DesktopSimulator } from './desktopSimulator'

const props = defineProps<{ options: DesktopPreviewOptions; simulator: DesktopSimulator }>()
const store = useWorkspaceStore()
const resetKey = ref(0)
const resetting = ref(false)

async function resetSimulation() {
  if (resetting.value) return
  resetting.value = true
  try {
    await props.simulator.reset()
    resetKey.value++
  } finally {
    resetting.value = false
  }
}

function changeScenario(event: Event) {
  const url = new URL(window.location.href)
  url.searchParams.set('scenario', (event.target as HTMLSelectElement).value)
  window.location.assign(url)
}
</script>

<template>
  <div class="html-preview desktop-preview">
    <header class="html-preview-bar">
      <strong>superhigh-html</strong>
      <span>主工作区演示 · {{ options.mode === 'readonly' ? '只读源码' : '浏览器内可写' }}</span>
      <select class="settings-input" aria-label="模拟场景" :value="options.scenario" @change="changeScenario"><option value="ready">可用</option><option value="empty">空状态</option><option value="error">失败</option></select>
      <button class="ghost-button small" :disabled="resetting" @click="resetSimulation">重置模拟</button>
      <span v-if="simulator.message.value" role="status">{{ simulator.message.value }}</span>
    </header>
    <div class="desktop-preview-body">
      <WorkspaceShell :key="resetKey" />
    </div>
    <div v-if="store.activityMessage" class="toast-message" @click="store.dismissActivityMessage()">{{ store.activityMessage }}</div>
    <div v-if="store.errorMessage" class="toast-message error" @click="store.dismissErrorMessage()">{{ store.errorMessage }}</div>
  </div>
</template>

<style scoped>
.desktop-preview { height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.desktop-preview-body { min-height: 0; overflow: hidden; }
</style>
