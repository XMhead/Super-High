<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { X, ZoomIn, ZoomOut, Maximize } from 'lucide-vue-next'

defineProps<{ src: string; alt: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const scale = ref(1)
const natural = ref(false)

function zoom(factor: number) {
  natural.value = true
  scale.value = Math.min(8, Math.max(0.1, scale.value * factor))
}

onMounted(() => dialog.value?.showModal())
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="image-preview-dialog" aria-label="图片预览" @cancel.prevent="emit('close')" @close="emit('close')">
      <div class="image-preview-dialog-toolbar">
        <span>{{ alt }}</span>
        <button type="button" title="缩小" @click="zoom(1 / 1.2)"><ZoomOut :size="16" /></button>
        <button type="button" title="适合窗口" @click="natural = false; scale = 1"><Maximize :size="16" /></button>
        <button type="button" title="放大" @click="zoom(1.2)"><ZoomIn :size="16" /></button>
        <button type="button" title="关闭图片预览（Esc）" autofocus @click="emit('close')"><X :size="16" /></button>
      </div>
      <div class="image-preview-dialog-stage" @wheel.prevent="zoom($event.deltaY < 0 ? 1.2 : 1 / 1.2)">
        <img :src="src" :alt="alt" :class="{ 'is-natural': natural }" :style="natural ? { zoom: scale } : undefined" />
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.image-preview-dialog { width: calc(100vw - 48px); height: calc(100vh - 48px); max-width: none; max-height: none; padding: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-primary); color: var(--color-text-primary); font-family: var(--font-ui); }
.image-preview-dialog[open] { display: flex; flex-direction: column; }
.image-preview-dialog::backdrop { background: var(--color-bg-overlay, var(--color-bg-secondary)); opacity: .8; }
.image-preview-dialog-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px; border-bottom: 1px solid var(--color-border); }
.image-preview-dialog-toolbar span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-preview-dialog-toolbar button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-secondary); color: inherit; cursor: pointer; }
.image-preview-dialog-toolbar button:hover { background: var(--color-bg-hover); }
.image-preview-dialog-stage { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 12px; }
.image-preview-dialog-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.image-preview-dialog-stage img.is-natural { max-width: none; max-height: none; }
</style>
