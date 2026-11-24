<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ src: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const width = ref(0)
const height = ref(0)
const mode = ref('fit')
const stageSize = ref({ width: 0, height: 0 })
let observer: ResizeObserver | null = null
let drag: { id: number; x: number; y: number; left: number; top: number } | null = null
const scale = computed(() => mode.value === 'fit'
  ? Math.min(1, Math.max(0.01, (stageSize.value.width - 32) / (width.value || 1)), Math.max(0.01, (stageSize.value.height - 32) / (height.value || 1)))
  : Number(mode.value))
function loaded(event: Event) {
  const img = event.target as HTMLImageElement
  width.value = img.naturalWidth
  height.value = img.naturalHeight
}
function zoomBy(factor: number) {
  mode.value = String(Math.min(8, Math.max(0.1, scale.value * factor)))
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || !stage.value) return
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.value.scrollLeft, top: stage.value.scrollTop }
  stage.value.setPointerCapture(event.pointerId)
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId || !stage.value) return
  stage.value.scrollLeft = drag.left + drag.x - event.clientX
  stage.value.scrollTop = drag.top + drag.y - event.clientY
}
onMounted(async () => {
  dialog.value?.showModal()
  await nextTick()
  if (stage.value) {
    observer = new ResizeObserver(([entry]) => { stageSize.value = { width: entry.contentRect.width, height: entry.contentRect.height } })
    observer.observe(stage.value)
  }
})
onBeforeUnmount(() => { observer?.disconnect(); dialog.value?.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="document-image-dialog" aria-label="文档图片放大查看" @cancel.prevent="emit('close')">
      <div class="document-image-toolbar">
        <span>{{ width }} × {{ height }} 像素</span>
        <button type="button" aria-label="缩小图片" @click="zoomBy(0.8)">−</button>
        <span>{{ Math.round(scale * 100) }}%</span>
        <button type="button" aria-label="放大图片" @click="zoomBy(1.25)">＋</button>
        <button type="button" @click="mode = 'fit'">适应窗口</button>
        <button type="button" @click="mode = '1'">原始大小</button>
        <span class="document-image-hint">滚轮缩放 · 拖动查看</span>
        <button type="button" class="document-image-close" @click="emit('close')">关闭</button>
      </div>
      <div ref="stage" class="document-image-stage" @wheel.prevent="zoomBy($event.deltaY < 0 ? 1.15 : 1 / 1.15)" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="drag = null" @pointercancel="drag = null" @lostpointercapture="drag = null">
        <img :src="src" alt="文档中的图片" draggable="false" :style="{ width: width ? `${width * scale}px` : 'auto', height: height ? `${height * scale}px` : 'auto' }" @load="loaded" />
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.document-image-dialog { position: fixed; inset: 0; width: calc(100vw - 48px); height: calc(100vh - 48px); max-width: none; max-height: none; margin: auto; padding: 0; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-primary); background: var(--color-bg-primary); box-shadow: none; overflow: hidden; }
.document-image-dialog[open] { display: flex; flex-direction: column; }
.document-image-dialog::backdrop { background: var(--surface-overlay); }
.document-image-toolbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding: 6px 10px; white-space: nowrap; overflow-x: auto; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); font-size: 12px; }
.document-image-toolbar > * { flex-shrink: 0; }
.document-image-toolbar button { height: 26px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-primary); color: var(--color-text-primary); font: inherit; box-shadow: none; cursor: pointer; }
.document-image-toolbar button:hover { background: var(--color-bg-hover); }
.document-image-toolbar button:focus-visible { outline: 1px solid var(--color-accent-blue); outline-offset: 1px; }
.document-image-close { margin-left: auto; }
.document-image-hint { color: var(--color-text-secondary); }
.document-image-stage { flex: 1; min-height: 0; overflow: auto; padding: 16px; cursor: grab; touch-action: none; }
.document-image-stage:active { cursor: grabbing; }
.document-image-stage img { display: block; max-width: none; max-height: none; margin: auto; image-rendering: auto; user-select: none; }
</style>
