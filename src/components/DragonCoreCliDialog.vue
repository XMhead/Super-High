<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import TerminalPane from './TerminalPane.vue'

const store = useWorkspaceStore()
const open = ref(false)
const frame = reactive({
  left: 384,
  top: 64,
  width: 520,
  height: 580,
})

type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const resizeEdges: ResizeEdge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
const MIN_WIDTH = 360
const MIN_HEIGHT = 280
const OPEN_EVENT_NAME = 'superhigh:open-dragoncore-cli-dialog'

const isMinecraftSurface = computed(() => store.activeWorkspaceSurface === 'minecraft')
const isVisible = computed(() => open.value && isMinecraftSurface.value && store.dragonCoreModeOpen)
const frameStyle = computed(() => ({
  left: `${frame.left}px`,
  top: `${frame.top}px`,
  width: `${frame.width}px`,
  height: `${frame.height}px`,
}))

let activePointer: {
  mode: 'drag' | 'resize'
  pointerId: number
  startX: number
  startY: number
  left: number
  top: number
  width: number
  height: number
  edge?: ResizeEdge
} | null = null

function clampFrame() {
  const maxLeft = Math.max(0, window.innerWidth - MIN_WIDTH)
  const maxTop = Math.max(0, window.innerHeight - MIN_HEIGHT)
  frame.left = Math.round(Math.max(0, Math.min(frame.left, maxLeft)))
  frame.top = Math.round(Math.max(0, Math.min(frame.top, maxTop)))
  frame.width = Math.round(Math.max(MIN_WIDTH, Math.min(frame.width, window.innerWidth)))
  frame.height = Math.round(Math.max(MIN_HEIGHT, Math.min(frame.height, window.innerHeight)))
}

function openDialog() {
  if (!isMinecraftSurface.value || !store.dragonCoreModeOpen) return
  clampFrame()
  open.value = true
}

function closeDialog() {
  open.value = false
}

function beginPointer(mode: 'drag' | 'resize', event: PointerEvent, edge?: ResizeEdge) {
  if ((event.target as HTMLElement | null)?.closest('button')) return
  activePointer = {
    mode,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    edge,
  }
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function movePointer(event: PointerEvent) {
  const pointer = activePointer
  if (!pointer || pointer.pointerId !== event.pointerId) return
  const deltaX = event.clientX - pointer.startX
  const deltaY = event.clientY - pointer.startY

  if (pointer.mode === 'drag') {
    frame.left = Math.max(0, pointer.left + deltaX)
    frame.top = Math.max(0, pointer.top + deltaY)
    clampFrame()
    return
  }

  const edge = pointer.edge ?? 'se'
  let nextLeft = pointer.left
  let nextTop = pointer.top
  let nextWidth = pointer.width
  let nextHeight = pointer.height

  if (edge.includes('e')) nextWidth = Math.max(MIN_WIDTH, pointer.width + deltaX)
  if (edge.includes('s')) nextHeight = Math.max(MIN_HEIGHT, pointer.height + deltaY)
  if (edge.includes('w')) {
    nextWidth = Math.max(MIN_WIDTH, pointer.width - deltaX)
    nextLeft = pointer.left + (pointer.width - nextWidth)
  }
  if (edge.includes('n')) {
    nextHeight = Math.max(MIN_HEIGHT, pointer.height - deltaY)
    nextTop = pointer.top + (pointer.height - nextHeight)
  }

  frame.left = Math.round(Math.max(0, nextLeft))
  frame.top = Math.round(Math.max(0, nextTop))
  frame.width = Math.round(nextWidth)
  frame.height = Math.round(nextHeight)
  clampFrame()
}

function stopPointer(event?: PointerEvent) {
  if (activePointer && event && activePointer.pointerId !== event.pointerId) return
  activePointer = null
}

function handleOpenEvent() {
  openDialog()
}

watch(() => [store.activeWorkspaceSurface, store.dragonCoreModeOpen] as const, ([surface, dragonCoreModeOpen]) => {
  if (surface !== 'minecraft' || !dragonCoreModeOpen) closeDialog()
})

onMounted(() => {
  window.addEventListener('pointermove', movePointer)
  window.addEventListener('pointerup', stopPointer)
  window.addEventListener('pointercancel', stopPointer)
  window.addEventListener(OPEN_EVENT_NAME, handleOpenEvent as EventListener)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', movePointer)
  window.removeEventListener('pointerup', stopPointer)
  window.removeEventListener('pointercancel', stopPointer)
  window.removeEventListener(OPEN_EVENT_NAME, handleOpenEvent as EventListener)
})
</script>

<template>
  <section
    v-if="isVisible"
    class="dragoncore-cli-dialog"
    data-testid="dragoncore-cli-dialog"
    :style="frameStyle"
    role="dialog"
    aria-label="龙核快捷 CLI 对话"
    @wheel.stop
  >
    <header class="dragoncore-cli-header" @pointerdown="beginPointer('drag', $event)">
      <div>
        <div class="panel-title">龙核快捷 CLI</div>
        <div class="dialog-subtitle">{{ store.currentProjectTitle }}</div>
      </div>
      <button type="button" title="关闭" aria-label="关闭" @pointerdown.stop @click="closeDialog">
        <X :size="15" />
      </button>
    </header>
    <div class="dragoncore-cli-body">
      <TerminalPane mode="cli" :cwd="store.workspace?.rootPath ?? ''" />
    </div>
    <button
      v-for="edge in resizeEdges"
      :key="edge"
      class="dragoncore-cli-resize"
      :class="`is-${edge}`"
      type="button"
      title="拖拽调整大小"
      @pointerdown="beginPointer('resize', $event, edge)"
    />
  </section>
</template>

<style scoped>
.dragoncore-cli-dialog {
  position: fixed;
  z-index: 1210;
  display: grid;
  grid-template-rows: 34px minmax(0, 1fr);
  min-width: 360px;
  min-height: 280px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-primary);
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.34);
}

.dragoncore-cli-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  cursor: move;
  user-select: none;
}

.dragoncore-cli-header :deep(.panel-title) {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dragoncore-cli-header :deep(.dialog-subtitle) {
  overflow: hidden;
  max-width: 320px;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dragoncore-cli-header button {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.dragoncore-cli-header button:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.dragoncore-cli-body {
  min-width: 0;
  min-height: 0;
}

.dragoncore-cli-dialog :deep(.terminal-panel) {
  min-width: 0;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.dragoncore-cli-resize {
  position: absolute;
  border: 0;
  background: transparent;
}

.dragoncore-cli-resize.is-n,
.dragoncore-cli-resize.is-s {
  left: 12px;
  width: calc(100% - 24px);
  height: 8px;
  cursor: ns-resize;
}

.dragoncore-cli-resize.is-n {
  top: 0;
}

.dragoncore-cli-resize.is-s {
  bottom: 0;
}

.dragoncore-cli-resize.is-e,
.dragoncore-cli-resize.is-w {
  top: 12px;
  width: 8px;
  height: calc(100% - 24px);
  cursor: ew-resize;
}

.dragoncore-cli-resize.is-e {
  right: 0;
}

.dragoncore-cli-resize.is-w {
  left: 0;
}

.dragoncore-cli-resize.is-ne,
.dragoncore-cli-resize.is-nw,
.dragoncore-cli-resize.is-se,
.dragoncore-cli-resize.is-sw {
  width: 18px;
  height: 18px;
}

.dragoncore-cli-resize.is-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.dragoncore-cli-resize.is-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.dragoncore-cli-resize.is-se {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}

.dragoncore-cli-resize.is-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
</style>
