<script setup lang="ts">
import { ref } from 'vue'
import { ExternalLink, RefreshCw, Smartphone } from 'lucide-vue-next'

const width = ref(390)
const frame = ref<HTMLIFrameElement | null>(null)
function refresh() {
  frame.value?.contentWindow?.location.reload()
}
</script>

<template>
  <main class="mobile-preview">
    <header class="preview-toolbar">
      <div class="preview-title"><Smartphone :size="17" /><strong>手机实时预览</strong></div>
      <span class="preview-hint">真实电脑 Host · 工作区与资源同步 · 热更新</span>
      <label class="preview-width">宽度
        <select v-model="width" aria-label="手机预览宽度">
          <option :value="360">360 px</option>
          <option :value="390">390 px</option>
          <option :value="430">430 px</option>
        </select>
      </label>
      <button class="ghost-button small" type="button" @click="refresh"><RefreshCw :size="14" />刷新</button>
      <a class="ghost-button small" href="/mobile/" target="_blank" rel="noopener"><ExternalLink :size="14" />打开手机页面</a>
    </header>
    <div class="preview-stage">
      <iframe ref="frame" class="preview-frame" :style="{ width: `${width}px` }" src="/mobile/" title="Super High 手机界面" />
    </div>
  </main>
</template>

<style scoped>
.mobile-preview { height: 100dvh; display: flex; flex-direction: column; background: var(--color-bg-secondary); color: var(--color-text-primary); }
.preview-toolbar { display: flex; flex-shrink: 0; align-items: center; gap: 12px; padding: 10px 14px; overflow-x: auto; white-space: nowrap; border-bottom: 1px solid var(--surface-divider-muted); }
.preview-title, .preview-width { display: flex; align-items: center; gap: 6px; }
.preview-title { font-size: 13px; }
.preview-hint { margin-right: auto; color: var(--color-text-secondary); font-size: 12px; }
.preview-width { font-size: 12px; }
.preview-width select { border: 1px solid var(--surface-divider-muted); border-radius: 4px; padding: 4px 6px; background: var(--color-bg-primary); color: var(--color-text-primary); }
.preview-width select:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 1px; }
.preview-stage { min-height: 0; flex: 1; display: flex; justify-content: center; padding: 16px; overflow: auto; }
.preview-frame { display: block; max-width: 100%; height: 100%; min-height: 320px; flex-shrink: 0; border: 1px solid var(--surface-divider-muted); border-radius: 6px; background: var(--color-bg-primary); }
</style>
