<script setup lang="ts">
import { ref } from 'vue'
import { backend } from '@/lib/tauri'

const props = defineProps<{ path: string }>()
const error = ref('')
async function open(chooseApp: boolean) {
  error.value = ''
  try {
    if (chooseApp) await backend.openFileWithApp(props.path)
    else await backend.openPath(props.path)
  } catch (reason) {
    error.value = String(reason)
  }
}
</script>

<template>
  <div class="file-open-actions">
    <button type="button" class="conflict-action-btn" @click="open(true)">选择应用打开</button>
    <button type="button" class="conflict-action-btn" @click="open(false)">定位文件</button>
  </div>
  <div v-if="error" class="unsupported-preview-message" role="alert">{{ error }}</div>
</template>

<style scoped>
.file-open-actions {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  margin-top: 12px;
}
.file-open-actions button { flex-shrink: 0; white-space: nowrap; }
</style>
