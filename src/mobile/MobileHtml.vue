<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MobileHostApi } from '@/lib/hostApi'
import type { MobileHtmlDocument } from '@/lib/mobileHtmlBridge'
import { urlFromExternalUrlMessage } from '@/lib/externalLinks'
import { HTML_PREVIEW_RESOURCE_MESSAGE, HTML_PREVIEW_RESOURCE_ERROR_MESSAGE } from '@/lib/htmlPreviewResources'

const props = defineProps<{ api: MobileHostApi; root: string; path: string; revision: number }>()
const emit = defineEmits<{ error: [message: string] }>()
const frame = ref<HTMLIFrameElement | null>(null)
const preview = ref<MobileHtmlDocument | null>(null)
let generation = 0
function context() {
  for (const data of preview.value?.contextMessages ?? []) frame.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify(data)), '*')
}
watch(() => [props.api, props.root, props.path, props.revision], async () => {
  const request = ++generation
  try {
    const next = await props.api.view<MobileHtmlDocument>({ operation: 'html-document', root: props.root, path: props.path })
    if (request === generation) { preview.value = next; context() }
  } catch (error) { if (request === generation) emit('error', error instanceof Error ? error.message : String(error)) }
}, { immediate: true })
async function message(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || !event.data || typeof event.data !== 'object') return
  const data = event.data as Record<string, unknown>
  if (data.type === 'superhigh-editor:preview-ready' || data.type === 'superhigh-editor:theme-ready') { context(); return }
  const url = urlFromExternalUrlMessage(data)
  if (url) { window.open(url, '_blank', 'noopener,noreferrer'); return }
  const request = generation
  const target = frame.value?.contentWindow
  try {
    const result = await props.api.view({ operation: 'html-message', root: props.root, path: props.path, data })
    if (request === generation && result) target?.postMessage(result, '*')
  } catch (error) {
    if (request !== generation) return
    const text = error instanceof Error ? error.message : String(error)
    if (typeof data.requestId === 'string') target?.postMessage({
      type: data.type === HTML_PREVIEW_RESOURCE_MESSAGE ? HTML_PREVIEW_RESOURCE_ERROR_MESSAGE : `${data.type}-error`,
      requestId: data.requestId, error: text,
    }, '*')
    emit('error', text)
  }
}
onMounted(() => window.addEventListener('message', message))
onBeforeUnmount(() => { generation++; window.removeEventListener('message', message) })
</script>

<template>
  <iframe v-if="preview" ref="frame" class="mobile-html-preview" :srcdoc="preview.document" sandbox="allow-scripts allow-downloads allow-modals" title="HTML 预览" @load="context" />
</template>

<style scoped>
.mobile-html-preview { width: 100%; height: 100%; min-height: 0; border: 0; background: var(--color-bg-primary); }
</style>
