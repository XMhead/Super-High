<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-vue-next'
import { backend } from '@/lib/tauri'
import { isHtmlPreviewLongPressMessage, sendHtmlPreviewPathToChat } from '@/lib/htmlPreviewLongPress'
import { useWorkspaceStore } from '@/stores/workspace'

const props = defineProps<{ path: string; workspaceRoot: string; draft: string | null }>()
const store = useWorkspaceStore()
const frame = ref<HTMLIFrameElement | null>(null)
const entryUrl = ref('')
const currentUrl = ref('')
const address = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)
const error = ref('')
const owner = crypto.randomUUID()
let origin = ''
let pending = Promise.resolve()
let bridgeReady = false
let disposed = false

watch(() => props.draft, (draft, _old, onCleanup) => {
  let stale = false
  onCleanup(() => { stale = true })
  pending = pending.then(async () => {
    if (stale) return
    const url = await backend.openHtmlPreview(props.workspaceRoot, props.path, owner, draft)
    if (disposed) {
      await backend.closeHtmlPreviewDraft(url, owner)
      return
    }
    error.value = ''
    if (entryUrl.value) return
    origin = new URL(url).origin
    entryUrl.value = currentUrl.value = address.value = url
  }).catch(reason => {
    if (!stale) error.value = `HTML 预览加载失败：${reason instanceof Error ? reason.message : String(reason)}`
  })
}, { immediate: true })

function message(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.origin !== origin) return
  if (isHtmlPreviewLongPressMessage(event.data)) {
    sendHtmlPreviewPathToChat(props.path)
    return
  }
  const data = event.data
  if (data?.type !== 'superhigh-html:navigation' || typeof data.url !== 'string') return
  const url = parseAddress(data.url)
  if (url?.origin !== origin) return
  bridgeReady = true
  if (currentUrl.value !== url.href) currentUrl.value = address.value = url.href
  canGoBack.value = data.canGoBack === true
  canGoForward.value = data.canGoForward === true
}

function parseAddress(value: string) {
  try {
    const url = new URL(value, currentUrl.value)
    return ['http:', 'https:'].includes(url.protocol) ? url : null
  } catch { return null }
}

function send(action: 'back' | 'forward' | 'reload' | 'open' | 'report', url?: string) {
  frame.value?.contentWindow?.postMessage({ type: 'superhigh-html:navigate', action, url }, origin)
}

function navigate() {
  const url = parseAddress(address.value.trim())
  address.value = currentUrl.value
  if (!url) return
  if (url.origin !== origin) {
    openOutside(url.href)
    return
  }
  if (bridgeReady) send('open', url.href)
  else if (frame.value) {
    currentUrl.value = address.value = url.href
    frame.value.src = url.href
  }
}

function refresh() {
  if (bridgeReady) send('reload')
  else if (frame.value && currentUrl.value) frame.value.src = currentUrl.value
}

function openOutside(url: string) {
  void backend.openUrl(url).catch(reason => store.showErrorMessage(`打开网页失败：${String(reason)}`))
}

onMounted(() => window.addEventListener('message', message))
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('message', message)
  const url = entryUrl.value
  if (url) void pending.then(() => backend.closeHtmlPreviewDraft(url, owner)).catch(() => undefined)
})
</script>

<template>
  <div class="html-preview-shell html-site">
    <form class="html-site-toolbar" @submit.prevent="navigate">
      <button type="button" class="icon-button" title="后退" aria-label="后退" :disabled="!canGoBack" @click="send('back')"><ArrowLeft :size="15" /></button>
      <button type="button" class="icon-button" title="前进" aria-label="前进" :disabled="!canGoForward" @click="send('forward')"><ArrowRight :size="15" /></button>
      <button type="button" class="icon-button" title="刷新" aria-label="刷新" :disabled="!currentUrl" @click="refresh"><RotateCw :size="15" /></button>
      <input v-model="address" class="html-site-address" type="text" aria-label="预览地址" spellcheck="false" :disabled="!entryUrl" @keydown.esc.prevent="address = currentUrl">
      <button type="button" class="icon-button" title="在浏览器中打开" aria-label="在浏览器中打开" :disabled="!currentUrl" @click="openOutside(currentUrl)"><ExternalLink :size="15" /></button>
    </form>
    <div v-if="error" class="html-site-error" role="alert">{{ error }}</div>
    <iframe v-else-if="entryUrl" ref="frame" class="html-preview-frame" :src="entryUrl" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals" title="HTML 预览" @load="send('report')" />
  </div>
</template>

<style scoped>
.html-site { display: flex; flex-direction: column; }
.html-site-toolbar { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-bottom: 1px solid var(--color-border); }
.html-site-toolbar button { flex: 0 0 auto; }
.html-site-address { flex: 1; min-width: 0; height: 24px; padding: 0 6px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-primary); color: var(--color-text-primary); font: inherit; }
.html-site-address:focus-visible { outline: 1px solid var(--color-accent-blue); outline-offset: -1px; }
.html-site iframe { flex: 1; min-height: 0; }
.html-site-error { padding: 10px 12px; color: var(--color-text-secondary); }
</style>
