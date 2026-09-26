<script setup lang="ts">
import { ref, watch } from 'vue'
import { isMediaAudio } from '@/lib/path'
import FileOpenActions from './FileOpenActions.vue'

const props = defineProps<{ path: string; source: string }>()
const failed = ref(false)
watch(() => [props.path, props.source], () => { failed.value = false })
</script>

<template>
  <div class="editor-media-preview">
    <div v-if="failed" class="unsupported-preview-panel">
      <div class="unsupported-preview-title">此媒体无法在内置播放器播放</div>
      <div class="unsupported-preview-path">{{ path }}</div>
      <div class="unsupported-preview-message">文件可能损坏或使用了不支持的编码，请选择其他应用打开。</div>
      <FileOpenActions :path="path" />
    </div>
    <template v-else>
      <audio v-if="isMediaAudio(path)" :key="source" :src="source" controls preload="metadata" @error="failed = true" />
      <video v-else :key="source" :src="source" controls preload="metadata" @error="failed = true" />
      <FileOpenActions :path="path" />
    </template>
  </div>
</template>

<style scoped>
.editor-media-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 12px;
  background: var(--color-bg-primary);
}
video { min-height: 0; max-height: calc(100% - 48px); max-width: 100%; }
audio { width: min(640px, 100%); }
</style>
