<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { backend } from '@/lib/tauri'
import { normalizePath } from '@/lib/path'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EditorTab } from '@/types'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'

const props = defineProps<{ src: string; parameters?: Record<string, unknown>; height?: number }>()
const store = useWorkspaceStore()
const tab = ref<EditorTab | null>(null)
const error = ref('')
// The SuperHigh mobile development preview needs its own origin for storage and HMR.
const mobilePreview = computed(() => props.src === 'http://127.0.0.1:1421/')
const height = computed(() => `${Math.max(120, Number(props.height) || 400)}px`)
watch(() => [props.src, store.workspace?.rootPath] as const, async ([src, root], _, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  tab.value = null
  error.value = ''
  if (mobilePreview.value) return
  try {
    if (!root) throw new Error('编辑器需要当前工作区。')
    const relative = normalizePath(src)
    if (!relative || relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.split('/').some(part => part === '..' || part === '.') || !/\.html?$/i.test(relative)) throw new Error('Editor.src 必须是工作区内的相对 HTML 路径。')
    const path = `${root.replace(/[\\/]+$/, '')}/${relative}`
    const content = await backend.readFile(path)
    if (!cancelled) tab.value = { id: `iui-editor:${path}`, path, name: relative.split('/').at(-1)!, content, contentType: 'text', language: 'html', isDirty: false }
  } catch (cause) { if (!cancelled) error.value = String(cause) }
}, { immediate: true })
</script>

<template>
  <div class="shui-editor" :style="{ height, minWidth: 0, display: 'flex', flexDirection: 'column' }">
    <iframe v-if="mobilePreview" src="http://127.0.0.1:1421/" title="手机实时预览" style="width:100%;height:100%;border:0" />
    <SuperhighHtmlPreview v-else-if="tab" :tab="tab" :parameters="parameters" />
    <span v-else-if="error" class="shui-error">{{ error }}</span>
  </div>
</template>
