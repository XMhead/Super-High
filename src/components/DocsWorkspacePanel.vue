<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { MessageSquarePlus, RefreshCw, X } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import TerminalPane from './TerminalPane.vue'

const store = useWorkspaceStore()
const iframeKey = ref(0)

const docs = computed(() => store.activeDocWorkspace)
const statusText = computed(() => {
  if (!docs.value) return '未检测'
  if (docs.value.status === 'starting') return '正在启动 VitePress…'
  if (docs.value.status === 'running') return docs.value.startedBySuperHigh ? 'Super High 已启动' : '已运行'
  if (docs.value.status === 'detected') return docs.value.running ? '已运行' : '已检测'
  if (docs.value.status === 'missing') return '未找到 VitePress 文档目录'
  if (docs.value.status === 'error') return '启动异常'
  return '待启动'
})

// ---- CLI dialog (draggable / resizable) ----
const cliDialogOpen = ref(false)
const cliDialogRect = ref({ left: 116, top: 88, width: 760, height: 560 })
const cliDialogDrag = ref<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
type DialogResizeHandle = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const cliDialogResize = ref<{
  pointerId: number
  handle: DialogResizeHandle
  x: number
  y: number
  left: number
  top: number
  width: number
  height: number
} | null>(null)

const CLI_DIALOG_MIN_WIDTH = 520
const CLI_DIALOG_MIN_HEIGHT = 360
const CLI_DIALOG_RESIZE_HANDLES: DialogResizeHandle[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']

function clampDialogRect() {
  const maxLeft = Math.max(0, window.innerWidth - CLI_DIALOG_MIN_WIDTH)
  const maxTop = Math.max(0, window.innerHeight - CLI_DIALOG_MIN_HEIGHT)
  cliDialogRect.value = {
    left: Math.round(Math.max(0, Math.min(cliDialogRect.value.left, maxLeft))),
    top: Math.round(Math.max(0, Math.min(cliDialogRect.value.top, maxTop))),
    width: Math.round(Math.max(CLI_DIALOG_MIN_WIDTH, Math.min(cliDialogRect.value.width, window.innerWidth))),
    height: Math.round(Math.max(CLI_DIALOG_MIN_HEIGHT, Math.min(cliDialogRect.value.height, window.innerHeight))),
  }
}

function openCliDialog() {
  clampDialogRect()
  cliDialogOpen.value = true
}

function closeCliDialog() {
  cliDialogOpen.value = false
}

function beginCliDialogDrag(event: PointerEvent) {
  if ((event.target as HTMLElement | null)?.closest('button')) return
  cliDialogDrag.value = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: cliDialogRect.value.left,
    top: cliDialogRect.value.top,
  }
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function onCliDialogPointerMove(event: PointerEvent) {
  const drag = cliDialogDrag.value
  if (drag && drag.pointerId === event.pointerId) {
    cliDialogRect.value = {
      ...cliDialogRect.value,
      left: Math.max(0, Math.min(drag.left + event.clientX - drag.x, window.innerWidth - CLI_DIALOG_MIN_WIDTH)),
      top: Math.max(0, Math.min(drag.top + event.clientY - drag.y, window.innerHeight - CLI_DIALOG_MIN_HEIGHT)),
    }
  }
  const resize = cliDialogResize.value
  if (resize && resize.pointerId === event.pointerId) {
    const dx = event.clientX - resize.x
    const dy = event.clientY - resize.y
    let { left, top, width, height } = resize
    if (resize.handle.includes('e')) width = Math.max(CLI_DIALOG_MIN_WIDTH, resize.width + dx)
    if (resize.handle.includes('w')) { width = Math.max(CLI_DIALOG_MIN_WIDTH, resize.width - dx); left = resize.left + resize.width - width }
    if (resize.handle.includes('s')) height = Math.max(CLI_DIALOG_MIN_HEIGHT, resize.height + dy)
    if (resize.handle.includes('n')) { height = Math.max(CLI_DIALOG_MIN_HEIGHT, resize.height - dy); top = resize.top + resize.height - height }
    cliDialogRect.value = { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) }
    clampDialogRect()
  }
}

function beginCliDialogResize(event: PointerEvent, handle: DialogResizeHandle) {
  cliDialogResize.value = {
    pointerId: event.pointerId,
    handle,
    x: event.clientX,
    y: event.clientY,
    left: cliDialogRect.value.left,
    top: cliDialogRect.value.top,
    width: cliDialogRect.value.width,
    height: cliDialogRect.value.height,
  }
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
  event.stopPropagation()
}

function endCliDialogPointer(event?: PointerEvent) {
  if (cliDialogDrag.value && event && cliDialogDrag.value.pointerId !== event.pointerId) return
  if (cliDialogResize.value && event && cliDialogResize.value.pointerId !== event.pointerId) return
  cliDialogDrag.value = null
  cliDialogResize.value = null
}

function refreshIframe() {
  iframeKey.value += 1
}

function retryDocs() {
  void store.ensureVitePressDocs()
}

onMounted(async () => {
  window.addEventListener('pointermove', onCliDialogPointerMove)
  window.addEventListener('pointerup', endCliDialogPointer)
  window.addEventListener('pointercancel', endCliDialogPointer)
  if (store.activeWorkspaceSurface === 'docs' && store.workspace) {
    await store.ensureVitePressDocs()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onCliDialogPointerMove)
  window.removeEventListener('pointerup', endCliDialogPointer)
  window.removeEventListener('pointercancel', endCliDialogPointer)
})
</script>

<template>
  <section class="docs-workspace-panel" aria-label="文档预览">
    <div class="docs-workspace-header">
      <div class="docs-workspace-title">
        <div class="panel-title">{{ store.currentProjectTitle }} 文档</div>
        <div class="dialog-subtitle docs-workspace-meta">
          <span :class="{
            'docs-status-dot': true,
            running: docs?.status === 'running',
            starting: docs?.status === 'starting',
            error: docs?.status === 'error' || docs?.status === 'missing',
          }" />
          <span>{{ statusText }}</span>
          <span v-if="docs?.url" class="docs-workspace-url">{{ docs.url }}</span>
          <span v-else-if="docs?.docsRoot" class="docs-workspace-url">{{ docs.docsRoot }}</span>
        </div>
      </div>
      <div class="docs-workspace-actions">
        <button class="ghost-button small" type="button" :disabled="!docs?.url" @click="refreshIframe">
          <RefreshCw :size="13" />
          <span>刷新</span>
        </button>
        <button class="ghost-button small" type="button" title="打开 CLI 快捷对话" @click="openCliDialog">
          <MessageSquarePlus :size="13" />
          <span>CLI</span>
        </button>
      </div>
    </div>

    <div class="docs-workspace-body">
      <iframe
        v-if="docs?.url"
        :key="`${docs.url}-${iframeKey}`"
        class="docs-workspace-frame"
        :src="docs.url"
        title="VitePress 文档预览"
      />
      <div v-else class="docs-workspace-empty">
        <div class="panel-title">{{ docs?.status === 'starting' ? '正在启动 VitePress 开发服务器…' : '文档预览不可用' }}</div>
        <div class="dialog-subtitle">{{ docs?.error || '正在扫描并启动 VitePress，请稍候。' }}</div>
        <button class="primary-button small" type="button" :disabled="docs?.status === 'starting'" @click="retryDocs">
          <RefreshCw :size="13" />
          <span>{{ docs?.status === 'starting' ? '启动中…' : '重试' }}</span>
        </button>
      </div>
    </div>

    <!-- CLI dialog -->
    <div
      v-if="cliDialogOpen"
      class="docs-cli-dialog"
      :style="{
        left: `${cliDialogRect.left}px`,
        top: `${cliDialogRect.top}px`,
        width: `${cliDialogRect.width}px`,
        height: `${cliDialogRect.height}px`,
      }"
      role="dialog"
      aria-label="文档 CLI 对话"
      @wheel.stop
    >
      <div class="docs-cli-header" @pointerdown="beginCliDialogDrag">
        <div>
          <div class="panel-title">文档 CLI</div>
          <div class="dialog-subtitle">{{ store.currentProjectTitle }}</div>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeCliDialog">
          <X :size="15" />
        </button>
      </div>
      <div class="docs-cli-body">
        <TerminalPane mode="cli" :cwd="store.workspace?.rootPath ?? ''" />
      </div>
      <button
        v-for="handle in CLI_DIALOG_RESIZE_HANDLES"
        :key="handle"
        class="docs-cli-resize"
        :class="`resize-${handle}`"
        type="button"
        title="拖拽调整大小"
        @pointerdown="beginCliDialogResize($event, handle)"
      />
    </div>
  </section>
</template>

<style scoped>
.docs-workspace-panel {
  grid-column: 2 / -1;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.docs-workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-strong);
}

.docs-workspace-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.docs-workspace-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.docs-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--color-text-muted);
}
.docs-status-dot.running { background: var(--color-accent-green); }
.docs-status-dot.starting { background: var(--color-accent-yellow); animation: docs-pulse 1.4s ease infinite; }
.docs-status-dot.error { background: var(--color-accent-red); }

@keyframes docs-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.docs-workspace-url {
  font-family: "Cascadia Code", Consolas, monospace;
  font-size: 10.5px;
  opacity: 0.7;
}

.docs-workspace-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.docs-workspace-body {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--color-bg-primary);
}

.docs-workspace-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

.docs-workspace-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 40px;
  color: var(--color-text-muted);
}

/* ---- CLI dialog ---- */
.docs-cli-dialog {
  position: fixed;
  z-index: 78;
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--surface-dialog);
  box-shadow: 0 25px 58px rgb(var(--surface-shadow-rgb) / 0.48);
  overflow: hidden;
}

.docs-cli-header {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--color-border);
  padding: 8px 12px;
  cursor: move;
  user-select: none;
}

.docs-cli-body {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.docs-cli-body .terminal-panel {
  height: 100%;
  border-right: 0;
}

.docs-cli-resize {
  position: absolute;
  z-index: 3;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0;
  opacity: 0;
}

.docs-cli-resize:hover { opacity: 0.65; }

.docs-cli-resize.resize-n,
.docs-cli-resize.resize-s { left: 10px; right: 10px; height: 7px; cursor: ns-resize; }
.docs-cli-resize.resize-n { top: 0; }
.docs-cli-resize.resize-s { bottom: 0; }

.docs-cli-resize.resize-e,
.docs-cli-resize.resize-w { top: 48px; bottom: 10px; width: 7px; cursor: ew-resize; }
.docs-cli-resize.resize-e { right: 0; }
.docs-cli-resize.resize-w { left: 0; }

.docs-cli-resize.resize-ne,
.docs-cli-resize.resize-nw,
.docs-cli-resize.resize-se,
.docs-cli-resize.resize-sw { width: 18px; height: 18px; }

.docs-cli-resize.resize-ne { top: 0; right: 0; cursor: nesw-resize; }
.docs-cli-resize.resize-nw { top: 0; left: 0; cursor: nwse-resize; }
.docs-cli-resize.resize-se { right: 0; bottom: 0; cursor: nwse-resize; }
.docs-cli-resize.resize-sw { left: 0; bottom: 0; cursor: nesw-resize; }
</style>
