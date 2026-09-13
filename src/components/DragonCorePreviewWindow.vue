<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue'
import { X } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import PreviewPane from './PreviewPane.vue'

const store = useWorkspaceStore()
const MIN_WIDTH = 360
const MIN_HEIGHT = 280
const DEFAULT_LEFT = 960
const DEFAULT_TOP = 64
const DEFAULT_WIDTH = 520
const DEFAULT_HEIGHT = 580
const resizeEdges = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const
const shouldRender = computed(() => store.activeWorkspaceSurface === 'minecraft' && store.dragonCoreModeOpen)

type ResizeEdge = typeof resizeEdges[number]

const frame = reactive({
  left: DEFAULT_LEFT,
  top: DEFAULT_TOP,
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
})

let activePointer: {
  mode: 'drag' | 'resize'
  startX: number
  startY: number
  left: number
  top: number
  width: number
  height: number
  edge?: ResizeEdge
} | null = null

const frameStyle = computed(() => ({
  left: `${frame.left}px`,
  top: `${frame.top}px`,
  width: `${frame.width}px`,
  height: `${frame.height}px`,
}))

function startPointer(mode: 'drag' | 'resize', event: PointerEvent, edge?: ResizeEdge) {
  event.preventDefault()
  activePointer = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    edge,
  }
  window.addEventListener('pointermove', movePointer)
  window.addEventListener('pointerup', stopPointer)
}

function movePointer(event: PointerEvent) {
  if (!activePointer) return
  const deltaX = event.clientX - activePointer.startX
  const deltaY = event.clientY - activePointer.startY
  if (activePointer.mode === 'drag') {
    frame.left = Math.max(0, activePointer.left + deltaX)
    frame.top = Math.max(0, activePointer.top + deltaY)
    return
  }
  const edge = activePointer.edge ?? 'se'
  let nextLeft = activePointer.left
  let nextTop = activePointer.top
  let nextWidth = activePointer.width
  let nextHeight = activePointer.height

  if (edge.includes('e')) {
    nextWidth = Math.max(MIN_WIDTH, activePointer.width + deltaX)
  }
  if (edge.includes('s')) {
    nextHeight = Math.max(MIN_HEIGHT, activePointer.height + deltaY)
  }
  if (edge.includes('w')) {
    nextWidth = Math.max(MIN_WIDTH, activePointer.width - deltaX)
    nextLeft = activePointer.left + (activePointer.width - nextWidth)
  }
  if (edge.includes('n')) {
    nextHeight = Math.max(MIN_HEIGHT, activePointer.height - deltaY)
    nextTop = activePointer.top + (activePointer.height - nextHeight)
  }

  frame.left = Math.max(0, nextLeft)
  frame.top = Math.max(0, nextTop)
  frame.width = nextWidth
  frame.height = nextHeight
}

function stopPointer() {
  activePointer = null
  window.removeEventListener('pointermove', movePointer)
  window.removeEventListener('pointerup', stopPointer)
}

onBeforeUnmount(stopPointer)
</script>

<template>
  <section
    v-if="shouldRender"
    class="dragoncore-preview-window"
    data-testid="dragoncore-preview-window"
    :style="frameStyle"
  >
    <header
      class="dragoncore-preview-titlebar"
      data-testid="dragoncore-preview-drag"
      @pointerdown="startPointer('drag', $event)"
    >
      <strong>DragonCore</strong>
      <button
        type="button"
        title="关闭 DragonCore 模式"
        data-testid="dragoncore-preview-close"
        @pointerdown.stop
        @click="store.closeDragonCoreMode()"
      >
        <X :size="15" />
      </button>
    </header>
    <PreviewPane />
    <div
      v-for="edge in resizeEdges"
      :key="edge"
      class="dragoncore-preview-resize"
      :class="`is-${edge}`"
      :data-testid="`dragoncore-preview-resize-${edge}`"
      @pointerdown="startPointer('resize', $event, edge)"
    />
  </section>
</template>

<style scoped>
.dragoncore-preview-window {
  position: fixed;
  z-index: 1200;
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

.dragoncore-preview-titlebar {
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

.dragoncore-preview-titlebar strong {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dragoncore-preview-titlebar button {
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

.dragoncore-preview-titlebar button:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.dragoncore-preview-window :deep(.shared-preview-panel) {
  min-width: 0;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.dragoncore-preview-resize {
  position: absolute;
}

.dragoncore-preview-resize.is-n,
.dragoncore-preview-resize.is-s {
  left: 12px;
  width: calc(100% - 24px);
  height: 8px;
  cursor: ns-resize;
}

.dragoncore-preview-resize.is-n {
  top: 0;
}

.dragoncore-preview-resize.is-s {
  bottom: 0;
}

.dragoncore-preview-resize.is-e,
.dragoncore-preview-resize.is-w {
  top: 12px;
  width: 8px;
  height: calc(100% - 24px);
  cursor: ew-resize;
}

.dragoncore-preview-resize.is-e {
  right: 0;
}

.dragoncore-preview-resize.is-w {
  left: 0;
}

.dragoncore-preview-resize.is-ne,
.dragoncore-preview-resize.is-nw,
.dragoncore-preview-resize.is-se,
.dragoncore-preview-resize.is-sw {
  width: 18px;
  height: 18px;
}

.dragoncore-preview-resize.is-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.dragoncore-preview-resize.is-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.dragoncore-preview-resize.is-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}

.dragoncore-preview-resize.is-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
</style>
