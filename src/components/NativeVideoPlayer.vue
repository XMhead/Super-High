<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Pause, Play, Volume2 } from 'lucide-vue-next'
import { backend } from '@/lib/tauri'
import type { NativeVideoBounds, NativeVideoStatus } from '@/lib/nativeVideo'

const props = defineProps<{ path: string }>()
const emit = defineEmits<{ metadata: [width: number, height: number] }>()
const surface = ref<HTMLElement | null>(null)
const status = ref<NativeVideoStatus>({ position: 0, duration: 0, paused: true, ended: false, ready: false, width: 0, height: 0, volume: 100 })
const error = ref('')
const id = crypto.randomUUID()
let disposed = false
let opened = false
let polling = false
let timer: ReturnType<typeof setInterval> | undefined
let observer: ResizeObserver | undefined
let lastBounds = ''
let readyEmitted = false
let startedAt = 0

function bounds(): NativeVideoBounds {
  const rect = surface.value?.getBoundingClientRect()
  return {
    x: rect?.left ?? 0, y: rect?.top ?? 0,
    width: rect?.width ?? 0, height: rect?.height ?? 0,
    scale: window.devicePixelRatio || 1,
    visible: status.value.ready && !error.value && document.visibilityState !== 'hidden' && !!rect?.width && !!rect?.height,
  }
}

async function close() {
  await backend.nativeVideo(id, { type: 'close' }).catch(() => {})
}

function fail(reason: unknown) {
  if (disposed) return
  error.value = String(reason)
  if (timer) clearInterval(timer)
  void close()
}

async function syncBounds() {
  if (!opened || disposed) return
  const current = bounds()
  const key = JSON.stringify(current)
  if (key === lastBounds) return
  lastBounds = key
  try { await backend.nativeVideo(id, { type: 'bounds', bounds: current }) }
  catch (reason) { fail(reason) }
}

async function poll() {
  if (disposed || !opened || polling) return
  polling = true
  try {
    const current = await backend.nativeVideo<NativeVideoStatus>(id, { type: 'status' })
    if (disposed) return
    status.value = current
    if (current.ready && !readyEmitted) {
      readyEmitted = true
      emit('metadata', current.width, current.height)
    }
    if (!current.ready && performance.now() - startedAt > 15_000) throw new Error('视频画面加载超时')
    await syncBounds()
  } catch (reason) { fail(reason) }
  finally { polling = false }
}

async function togglePause() {
  if (!status.value.ready || disposed) return
  try {
    await backend.nativeVideo(id, { type: 'pause', paused: !status.value.paused })
    await poll()
  } catch (reason) { fail(reason) }
}

async function seek(event: Event) {
  try {
    await backend.nativeVideo(id, { type: 'seek', seconds: Number((event.target as HTMLInputElement).value) })
    await poll()
  } catch (reason) { fail(reason) }
}

async function volume(event: Event) {
  try {
    await backend.nativeVideo(id, { type: 'volume', volume: Number((event.target as HTMLInputElement).value) })
    await poll()
  } catch (reason) { fail(reason) }
}

function time(seconds: number) {
  const rounded = Math.floor(Math.max(0, seconds))
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`
}

function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.code !== 'Space') return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, button, select, [contenteditable="true"]')) return
  event.preventDefault()
  void togglePause()
}

defineExpose({
  screenshot: () => backend.nativeVideo<string>(id, { type: 'screenshot' }),
  togglePause,
})

onMounted(async () => {
  await nextTick()
  if (disposed) return
  observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { void syncBounds() })
  if (surface.value) observer?.observe(surface.value)
  window.addEventListener('resize', syncBounds)
  window.addEventListener('scroll', syncBounds, true)
  window.addEventListener('keydown', keydown)
  document.addEventListener('visibilitychange', syncBounds)
  try {
    startedAt = performance.now()
    await backend.nativeVideo(id, { type: 'open', path: props.path, bounds: bounds() })
    if (disposed) { void close(); return }
    opened = true
    await poll()
    if (!disposed && !error.value) timer = setInterval(() => { void poll() }, 200)
  } catch (reason) { fail(reason) }
})

onBeforeUnmount(() => {
  disposed = true
  if (timer) clearInterval(timer)
  observer?.disconnect()
  window.removeEventListener('resize', syncBounds)
  window.removeEventListener('scroll', syncBounds, true)
  window.removeEventListener('keydown', keydown)
  document.removeEventListener('visibilitychange', syncBounds)
  void close()
})
</script>

<template>
  <section class="native-video-player" aria-label="原片视频播放" @pointerdown.stop>
    <div ref="surface" class="native-video-surface">
      <span v-if="error" class="native-video-message error" role="alert">{{ error }}</span>
      <span v-else-if="!status.ready" class="native-video-message">正在打开原片…</span>
    </div>
    <div class="native-video-controls">
      <button type="button" :disabled="!status.ready || !!error" :title="status.paused ? '播放（空格）' : '暂停（空格）'" :aria-label="status.paused ? '播放' : '暂停'" @click="togglePause">
        <Play v-if="status.paused" :size="15" /><Pause v-else :size="15" />
      </button>
      <span class="native-video-time">{{ time(status.position) }} / {{ time(status.duration) }}</span>
      <input class="native-video-seek" type="range" min="0" :max="status.duration || 0" step="0.01" :value="status.position" :disabled="!status.ready || !!error" aria-label="播放进度" @change="seek">
      <Volume2 :size="14" aria-hidden="true" />
      <input class="native-video-volume" type="range" min="0" max="100" step="1" :value="status.volume" aria-label="音量" :disabled="!!error" @change="volume">
    </div>
  </section>
</template>

<style scoped>
.native-video-player { position: absolute; inset: 12px 48px 38px; display: grid; grid-template-rows: minmax(0, 1fr) 30px; gap: 6px; min-width: 0; min-height: 0; }
.native-video-surface { min-width: 0; min-height: 0; position: relative; background: var(--color-bg-primary); }
.native-video-message { position: absolute; inset: 0; display: grid; place-content: center; padding: 12px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.native-video-message.error { color: var(--color-accent-red); }
.native-video-controls { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--color-text-primary); font: inherit; }
.native-video-controls button { display: grid; place-content: center; width: 30px; height: 28px; flex-shrink: 0; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-secondary); color: inherit; cursor: pointer; }
.native-video-controls button:hover { background: var(--color-bg-hover); }
.native-video-controls button:disabled { opacity: .45; cursor: default; }
.native-video-time { flex-shrink: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.native-video-controls input { appearance: none; height: 4px; min-width: 0; margin: 0; background: var(--color-border); border: 0; border-radius: 0; cursor: pointer; }
.native-video-controls input::-webkit-slider-thumb { appearance: none; width: 8px; height: 13px; border: 0; border-radius: 1px; background: var(--color-accent-blue); }
.native-video-seek { flex: 1; }
.native-video-volume { flex: 0 1 70px; }
</style>
