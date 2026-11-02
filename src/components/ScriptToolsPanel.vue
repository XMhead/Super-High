<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Copy, FileCode2, FolderOpen, X } from 'lucide-vue-next'

import { backend } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ScriptToolDescriptor, ScriptToolListResponse } from '@/types'
import ScriptToolExtensionPanel from './ScriptToolExtensionPanel.vue'
import SourceBadge from './SourceBadge.vue'

const store = useWorkspaceStore()
const MIN_WIDTH = 330
const MIN_HEIGHT = 360
const DEFAULT_WIDTH = 340
const DEFAULT_HEIGHT = 600
const EXPANDED_WIDTH = 880
const resizeEdges = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const

type ResizeEdge = typeof resizeEdges[number]

const error = ref('')
const registry = ref<ScriptToolListResponse | null>(null)
type SourceFilter = 'all' | 'global' | 'project'
const sourceFilters: Array<{ id: SourceFilter; label: string }> = [{ id: 'all', label: '全部' }, { id: 'global', label: '全局' }, { id: 'project', label: '项目' }]
const activeFilter = ref<SourceFilter>('all')
const selectedToolId = ref('')
const listElement = ref<HTMLElement | null>(null)
const frame = reactive({ left: 0, top: 76, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
const selectedTool = computed(() => registry.value?.tools.find((tool) => tool.id === selectedToolId.value) ?? null)
const visibleTools = computed(() => (registry.value?.tools ?? []).filter((tool) => activeFilter.value === 'all' || tool.scope === activeFilter.value))
const frameStyle = computed(() => ({
  left: `${frame.left}px`,
  top: `${frame.top}px`,
  width: `${frame.width}px`,
  height: `${frame.height}px`,
}))

let refreshToken = 0
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

async function refresh() {
  const rootPath = workspaceRoot.value
  const token = ++refreshToken
  registry.value = null
  error.value = ''
  selectedToolId.value = ''
  const saved = store.settings.scriptToolSelections[workspaceKey(rootPath)]
  activeFilter.value = saved && sourceFilters.some((filter) => filter.id === saved.filter) ? saved.filter : 'all'
  if (!rootPath) return
  try {
    const result = await backend.listProjectScriptTools(rootPath)
    if (token !== refreshToken) return
    registry.value = result
    if (saved?.toolId && !visibleTools.value.some((tool) => tool.id === saved.toolId)
      && (result.tools.some((tool) => tool.id === saved.toolId) || !visibleTools.value.length)) activeFilter.value = 'all'
    restoreSelection(saved?.toolId)
  } catch (loadError) {
    if (token !== refreshToken) return
    error.value = formatError(loadError)
  }
}

function workspaceKey(root: string) {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function restoreSelection(id?: string) {
  const next = visibleTools.value.find((tool) => tool.id === id)
    ?? visibleTools.value.find((tool) => tool.uiPath)
    ?? visibleTools.value[0]
  selectedToolId.value = next?.id ?? ''
  if (next) {
    if (frame.width < 620) frame.width = EXPANDED_WIDTH
    constrainFrame()
  }
  const rememberedId = next?.id ?? store.settings.scriptToolSelections[workspaceKey(workspaceRoot.value)]?.toolId ?? ''
  store.setScriptToolSelection(workspaceRoot.value, activeFilter.value, rememberedId)
  void nextTick(() => listElement.value?.querySelector('.script-tool-card.active')?.scrollIntoView?.({ block: 'nearest' }))
}

function selectFilter(filter: SourceFilter) {
  activeFilter.value = filter
  restoreSelection(selectedToolId.value)
}

function selectTool(tool: ScriptToolDescriptor) {
  restoreSelection(tool.id)
}

function sourcePath(tool: ScriptToolDescriptor) {
  if (tool.sourceAbsolutePath) return tool.sourceAbsolutePath
  const rootPath = workspaceRoot.value.replace(/[\\/]+$/, '')
  return `${rootPath}/${tool.sourcePath}`
}

function sourceDirectory(tool: ScriptToolDescriptor) {
  return sourcePath(tool).replace(/[\\/][^\\/]+$/, '')
}

async function openScriptDirectory(tool: ScriptToolDescriptor) {
  await store.openPath(sourceDirectory(tool))
}

async function openScriptSource(tool: ScriptToolDescriptor) {
  store.setWorkspaceSurface('project')
  store.setPreviewMode('code')
  await store.openFile(sourcePath(tool))
}

async function copyPath(tool: ScriptToolDescriptor, full: boolean) {
  const text = full ? sourcePath(tool) : tool.sourcePath
  if (!navigator.clipboard?.writeText) return
  await navigator.clipboard.writeText(text)
  store.showActivityMessage(full ? '已复制完整脚本路径' : '已复制相对脚本路径')
}

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

function constrainFrame() {
  frame.width = Math.min(frame.width, window.innerWidth - 32)
  frame.height = Math.min(frame.height, window.innerHeight - 32)
  frame.left = Math.max(16, Math.min(frame.left, window.innerWidth - frame.width - 16))
  frame.top = Math.max(16, Math.min(frame.top, window.innerHeight - frame.height - 16))
}

function movePointer(event: PointerEvent) {
  if (!activePointer) return
  const deltaX = event.clientX - activePointer.startX
  const deltaY = event.clientY - activePointer.startY
  if (activePointer.mode === 'drag') {
    frame.left = Math.max(0, activePointer.left + deltaX)
    frame.top = Math.max(0, activePointer.top + deltaY)
    constrainFrame()
    return
  }
  const edge = activePointer.edge ?? 'se'
  let nextLeft = activePointer.left
  let nextTop = activePointer.top
  let nextWidth = activePointer.width
  let nextHeight = activePointer.height
  const minWidth = selectedTool.value ? 620 : MIN_WIDTH
  if (edge.includes('e')) nextWidth = Math.max(minWidth, activePointer.width + deltaX)
  if (edge.includes('s')) nextHeight = Math.max(MIN_HEIGHT, activePointer.height + deltaY)
  if (edge.includes('w')) {
    nextWidth = Math.max(minWidth, activePointer.width - deltaX)
    nextLeft = activePointer.left + activePointer.width - nextWidth
  }
  if (edge.includes('n')) {
    nextHeight = Math.max(MIN_HEIGHT, activePointer.height - deltaY)
    nextTop = activePointer.top + activePointer.height - nextHeight
  }
  frame.left = Math.max(0, nextLeft)
  frame.top = Math.max(0, nextTop)
  frame.width = nextWidth
  frame.height = nextHeight
  constrainFrame()
}

function stopPointer() {
  activePointer = null
  window.removeEventListener('pointermove', movePointer)
  window.removeEventListener('pointerup', stopPointer)
}

function formatError(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

watch(workspaceRoot, () => { void refresh() }, { immediate: true })
onMounted(() => { frame.left = Math.max(16, window.innerWidth - frame.width - 20); constrainFrame(); window.addEventListener('resize', constrainFrame); window.addEventListener('superhigh:extension-projects-changed', refresh) })
onBeforeUnmount(() => { stopPointer(); window.removeEventListener('resize', constrainFrame); window.removeEventListener('superhigh:extension-projects-changed', refresh) })
</script>

<template>
  <section class="script-tools-window" aria-label="脚本工具箱" :class="{ expanded: !!selectedTool }" :style="frameStyle">
    <header class="script-tools-titlebar" @pointerdown="startPointer('drag', $event)">
      <strong>脚本工具箱</strong>
      <button type="button" title="关闭脚本工具箱" @pointerdown.stop @click="store.setScriptToolsOpen(false)">
        <X :size="15" />
      </button>
    </header>

    <div class="script-tools-body">
      <aside ref="listElement" class="script-tool-list" aria-label="已登记脚本">
        <div v-if="error" class="script-tools-error">{{ error }}</div>
        <nav class="script-tool-categories" aria-label="脚本工具来源">
          <button
            v-for="filter in sourceFilters"
            :key="filter.id"
            type="button"
            :class="{ active: filter.id === activeFilter }"
            :aria-pressed="filter.id === activeFilter"
            @click="selectFilter(filter.id)"
          >
            <SourceBadge v-if="filter.id !== 'all'" :kind="filter.id" /><template v-else>{{ filter.label }}</template>
          </button>
        </nav>
        <article v-for="tool in visibleTools" :key="tool.id" class="script-tool-card" :class="{ active: tool.id === selectedToolId }" :title="tool.tooltip || tool.displayName" :data-tool-id="tool.id" @click="selectTool(tool)" @keydown.enter.self.prevent="selectTool(tool)" @keydown.space.self.prevent="selectTool(tool)" tabindex="0" :aria-label="tool.displayName">
          <div class="script-tool-heading" :title="tool.registryPath || registry?.configPath || ''"><strong>{{ tool.displayName }}</strong><SourceBadge :kind="tool.scope === 'global' ? 'global' : 'project'" /></div>
          <div class="script-tool-actions" @click.stop @keydown.stop>
            <button type="button" title="打开脚本所在目录" @click="openScriptDirectory(tool)">
              <FolderOpen :size="14" />
            </button>
            <button type="button" title="在 Super High 打开脚本" @click="openScriptSource(tool)">
              <FileCode2 :size="14" />
            </button>
            <button type="button" title="复制相对脚本路径" @click="copyPath(tool, false)">
              <Copy :size="14" />
            </button>
            <button type="button" title="复制完整脚本路径" @click="copyPath(tool, true)">
              <Copy :size="14" />
            </button>
          </div>
        </article>
        <p v-if="registry && !visibleTools.length" class="script-tools-empty">此来源没有脚本工具</p>
      </aside>
      <div v-if="selectedTool" class="script-tool-extension-divider" aria-hidden="true" />
      <ScriptToolExtensionPanel v-if="selectedTool?.uiPath" :tool="selectedTool" />
      <p v-else-if="selectedTool" class="script-tools-empty">此脚本未登记扩展界面</p>
    </div>

    <div v-for="edge in resizeEdges" :key="edge" class="script-tools-resize" :class="`is-${edge}`" @pointerdown="startPointer('resize', $event, edge)" />
  </section>
</template>
