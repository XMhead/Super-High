<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PluginEditorTab } from '@/lib/pluginRuntime'

const props = defineProps<{ plugin?: PluginEditorTab; visible: boolean }>()
const element = ref<HTMLElement | null>(null)
const error = ref('')
let page: ReturnType<PluginEditorTab['mount']> | undefined

watch(() => [element.value, props.plugin] as const, ([target, plugin], _previous, onCleanup) => {
  error.value = ''
  if (!target || !plugin) return
  try {
    const mounted = plugin.mount(target)
    page = mounted
    onCleanup(() => {
      page = undefined
      mounted.dispose()
    })
    mounted.setVisible(props.visible)
  } catch (caught) {
    error.value = String(caught)
  }
}, { flush: 'post' })
watch(() => props.visible, visible => page?.setVisible(visible), { flush: 'post' })
</script>

<template>
  <div ref="element" class="plugin-editor-page" />
  <div v-if="error || !plugin" class="plugin-editor-status" role="status">{{ error || '插件未加载' }}</div>
</template>

<style scoped>
.plugin-editor-page { flex: 1; min-height: 0; min-width: 0; }
.plugin-editor-status { padding: 12px; color: var(--color-text-secondary); }
</style>
