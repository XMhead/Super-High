<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Copy, FileCode2, FolderOpen, PanelRightClose, PanelRightOpen, X } from 'lucide-vue-next'

import { backend } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ScriptToolDescriptor, ScriptToolListResponse } from '@/types'
import ScriptToolExtensionPanel from './ScriptToolExtensionPanel.vue'

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
const activeToolType = ref('user')
const expandedToolId = ref('')
const frame = reactive({ left: 0, top: 76, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
const expandedTool = computed(() => registry.value?.tools.find((tool) => tool.id === expandedToolId.value) ?? null)
const toolTypes = computed(() => Array.from(new Set((registry.value?.tools ?? []).map(toolType))).sort(compareToolTypes))
const visibleTools = computed(() => (registry.value?.tools ?? []).filter((tool) => toolType(tool) === activeToolType.value))
const frameStyle = computed(() => ({
  left: `${frame.left}px`,
  top: `${frame.top}px`,
  width: `${frame.width}px`,
  height: `${frame.height}px`,
}))

let collapsedWidth = DEFAULT_WIDTH
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
  registry.value = null
  error.value = ''
  activeToolType.value = 'user'
  expandedToolId.value = ''
  if (!rootPath) return
  try {
    registry.value = await backend.listProjectScriptTools(rootPath)
    if (!toolTypes.value.includes('user')) activeToolType.value = toolTypes.value[0] ?? 'user'
  } catch (loadError) {
    error.value = formatError(loadError)
  }
}

function toolType(tool: ScriptToolDescriptor) {
  return tool.type?.trim().toLowerCase() || 'user'
}

function compareToolTypes(left: string, right: string) {
  const priority = (value: string) => value === 'user' ? 0 : value === 'agent' ? 1 : 2
  return priority(left) - priority(right) || left.localeCompare(right)
}

function selectToolType(type: string) {
  if (type === activeToolType.value) return
  activeToolType.value = type
  if (!expandedToolId.value) return
  expandedToolId.value = ''
  frame.width = Math.max(MIN_WIDTH, collapsedWidth)
}

function toggleExtension(tool: ScriptToolDescriptor) {
  if (!tool.uiPath) {
    store.showErrorMessage(`“${tool.displayName}”没有在 .superhigh 中登记扩展 UI。`)
    return
  }
  if (expandedToolId.value === tool.id) {
    expandedToolId.value = ''
    frame.width = Math.max(MIN_WIDTH, collapsedWidth)
    return
  }
  if (!expandedToolId.value) collapsedWidth = frame.width
  expandedToolId.value = tool.id
  frame.width = Math.max(EXPANDED_WIDTH, frame.width)
}

function sourcePath(tool: ScriptToolDescriptor) {
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
  if (edge.includes('e')) nextWidth = Math.max(MIN_WIDTH, activePointer.width + deltaX)
  if (edge.includes('s')) nextHeight = Math.max(MIN_HEIGHT, activePointer.height + deltaY)
  if (edge.includes('w')) {
    nextWidth = Math.max(MIN_WIDTH, activePointer.width - deltaX)
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
onMounted(() => { frame.left = Math.max(16, window.innerWidth - DEFAULT_WIDTH - 20) })
onBeforeUnmount(stopPointer)
</script>

<template>
  <section class="script-tools-window" aria-label="脚本工具箱" :class="{ expanded: !!expandedTool }" :style="frameStyle">
    <header class="script-tools-titlebar" @pointerdown="startPointer('drag', $event)">
      <strong>脚本工具箱</strong>
      <button type="button" title="关闭脚本工具箱" @pointerdown.stop @click="store.setScriptToolsOpen(false)">
        <X :size="15" />
      </button>
    </header>

    <div class="script-tools-body">
      <aside class="script-tool-list" aria-label="已登记脚本">
        <div v-if="error" class="script-tools-error">{{ error }}</div>
        <nav v-if="toolTypes.length > 1" class="script-tool-categories" aria-label="脚本工具分类">
          <button
            v-for="type in toolTypes"
            :key="type"
            type="button"
            :class="{ active: type === activeToolType }"
            :aria-pressed="type === activeToolType"
            @click="selectToolType(type)"
          >
            {{ type }}
          </button>
        </nav>
        <article v-for="tool in visibleTools" :key="tool.id" class="script-tool-card" :class="{ active: tool.id === expandedToolId }" :title="tool.tooltip || tool.displayName">
          <strong>{{ tool.displayName }}</strong>
          <div class="script-tool-actions">
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
            <button class="script-tool-expand" type="button" :title="expandedToolId === tool.id ? '收起扩展 UI' : '展开扩展 UI'" @click="toggleExtension(tool)">
              <PanelRightClose v-if="expandedToolId === tool.id" :size="14" />
              <PanelRightOpen v-else :size="14" />
            </button>
          </div>
        </article>
      </aside>
      <div v-if="expandedTool" class="script-tool-extension-divider" aria-hidden="true" />
      <ScriptToolExtensionPanel v-if="expandedTool" :tool="expandedTool" />
    </div>

    <div v-for="edge in resizeEdges" :key="edge" class="script-tools-resize" :class="`is-${edge}`" @pointerdown="startPointer('resize', $event, edge)" />
  </section>
</template>
