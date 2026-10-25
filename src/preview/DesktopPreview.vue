<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import VisualFeedbackPreview from './VisualFeedbackPreview.vue'
import WorkspaceShell from '@/components/WorkspaceShell.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNativeScrollSpeed } from '@/lib/scrollSpeed'
import type { DesktopPreviewOptions } from './options'
import type { DesktopSimulator } from './desktopSimulator'

const props = defineProps<{ options: DesktopPreviewOptions; simulator: DesktopSimulator }>()
const store = useWorkspaceStore()
useNativeScrollSpeed(() => store.settings.scrollSpeedPercent)
const resetKey = ref(0)
const resetting = ref(false)
const feedbackOpen = ref(new URLSearchParams(window.location.search).get('prototype') === 'feedback')
const previewTarget = ref<Element | null>(null)
onMounted(async () => {
  await nextTick()
  const findTarget = () => { previewTarget.value = document.querySelector('.shared-preview-panel') }
  findTarget()
  const observer = new MutationObserver(findTarget)
  observer.observe(document.querySelector('.desktop-preview-body')!, { childList: true, subtree: true })
  // The preview shell owns this observer; HMR also unmounts the shell.
  stopTargetObserver = () => observer.disconnect()
})
let stopTargetObserver = () => {}
onBeforeUnmount(() => stopTargetObserver())

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
      <button class="ghost-button small" :aria-pressed="feedbackOpen" @click="feedbackOpen = !feedbackOpen">{{ feedbackOpen ? '退出视觉反馈方案' : '视觉反馈方案' }}</button>
      <span>主工作区演示 · {{ options.mode === 'readonly' ? '只读源码' : '浏览器内可写' }}</span>
      <select class="settings-input" aria-label="模拟场景" :value="options.scenario" @change="changeScenario"><option value="ready">可用</option><option value="empty">空状态</option><option value="error">失败</option></select>
      <button class="ghost-button small" :disabled="resetting" @click="resetSimulation">重置模拟</button>
      <span v-if="simulator.message.value" role="status">{{ simulator.message.value }}</span>
    </header>
    <div class="desktop-preview-body">
      <WorkspaceShell :key="resetKey" />
      <Teleport v-if="previewTarget && feedbackOpen" :to="previewTarget">
        <VisualFeedbackPreview :key="resetKey" @close="feedbackOpen = false" />
      </Teleport>
    </div>
    <div v-if="store.activityMessage" class="toast-message" @click="store.dismissActivityMessage()">{{ store.activityMessage }}</div>
    <div v-if="store.errorMessage" class="toast-message error" @click="store.dismissErrorMessage()">{{ store.errorMessage }}</div>
  </div>
</template>

<style scoped>
.desktop-preview { height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.desktop-preview-body { min-height: 0; overflow: hidden; }
.desktop-preview-body :deep(.shared-preview-panel) { position: relative; }
</style>
