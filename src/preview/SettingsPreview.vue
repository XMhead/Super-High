<script setup lang="ts">
import { ref } from 'vue'
import SettingsDrawer from '@/components/SettingsDrawer.vue'
import DesktopOnboarding from '@/components/DesktopOnboarding.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { SettingsSection } from '@/lib/settingsSections'
import type { PreviewOptions } from './options'
import type { installSettingsSimulator } from './simulator'

const props = defineProps<{ options: PreviewOptions; simulator?: ReturnType<typeof installSettingsSimulator> }>()
const store = useWorkspaceStore()
const resetKey = ref(0)
const currentSection = ref(props.options.section)
function resetSimulation() {
  props.simulator?.reset()
  resetKey.value++
}
function selectSection(section: SettingsSection) {
  currentSection.value = section
  const url = new URL(window.location.href)
  url.searchParams.set('section', section)
  window.history.replaceState(null, '', url)
}
function changeScenario(event: Event) {
  const url = new URL(window.location.href)
  url.searchParams.set('scenario', (event.target as HTMLSelectElement).value)
  window.location.assign(url)
}
</script>

<template>
  <div class="html-preview">
    <header class="html-preview-bar">
      <strong>superhigh-html</strong>
      <span>{{ currentSection === 'updates' ? '更新日志' : options.mode === 'simulate' ? '交互模拟 · 使用模拟数据，不操作本机' : '只读预览' }}</span>
      <select v-if="simulator && currentSection !== 'updates'" class="settings-input" aria-label="模拟场景" :value="options.scenario" @change="changeScenario"><option value="ready">可用</option><option value="empty">空状态</option><option value="error">失败</option></select>
      <button v-if="simulator && currentSection !== 'updates'" class="ghost-button small" @click="resetSimulation">重置模拟</button>
      <button v-if="!store.settingsOpen" class="ghost-button small" @click="store.setSettingsOpen(true)">打开设置</button>
      <span v-if="currentSection !== 'updates' && simulator?.message.value" role="status">{{ simulator.message.value }}</span>
    </header>
    <SettingsDrawer :key="resetKey" :preview="options.mode === 'readonly'" :simulated="options.mode === 'simulate'" :initial-section="currentSection" @section-change="selectSection" />
    <DesktopOnboarding v-if="simulator" manual />
    <div v-if="!store.settingsOpen" class="html-preview-empty">设置已关闭，可点击“打开设置”继续预览。</div>
  </div>
</template>

<style scoped>
.html-preview { height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.html-preview-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 10px 16px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); font-size: 12px; }
.html-preview-bar span { color: var(--color-text-secondary); }
.html-preview :deep(.settings-workspace-panel) { grid-column: 1; border-left: 0; }
.html-preview-empty { padding: 32px; color: var(--color-text-secondary); }
</style>
