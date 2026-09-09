<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CSSProperties } from 'vue'
import { Download } from 'lucide-vue-next'

import { backend } from '@/lib/tauri'
import {
  buildDragonPixelBuffer,
  DragonImageParseError,
  extractDragonPixelSource,
  parseDragonImageConfig,
  type DragonImageDocument,
  type DragonImageIssue,
} from '@/lib/dragonImage'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DragonCoreInfo, FileEntry } from '@/types'

import ExplorerPane from './ExplorerPane.vue'
import TerminalPane from './TerminalPane.vue'

const store = useWorkspaceStore()
const canvas = ref<HTMLCanvasElement | null>(null)
const dragonCoreInfo = ref<DragonCoreInfo | null>(null)
const parsedDocument = ref<DragonImageDocument | null>(null)
const parseIssues = ref<DragonImageIssue[]>([])
const isLoading = ref(false)
const isExporting = ref(false)
const statusMessage = ref('')
const exportError = ref('')
const configContent = ref('')
const activeConfigPath = ref('')
const zoom = ref(12)

const activeConfigName = computed(() => fileNameFromPath(activeConfigPath.value) || 'main.md')
const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)
const canvasStyle = computed<CSSProperties>(() => {
  const document = parsedDocument.value
  if (!document) return {}
  return {
    width: `${Math.max(1, Math.round(document.width * zoom.value))}px`,
    height: `${Math.max(1, Math.round(document.height * zoom.value))}px`,
  }
})
const imageMeta = computed(() => {
  const document = parsedDocument.value
  if (!document) return `${activeConfigName.value} · 未读取`
  return `${activeConfigName.value} · ${document.width} x ${document.height} · ${document.pixels.length} 像素`
})
const dragonPrompt = computed(() => {
  const info = dragonCoreInfo.value
  if (!info) return ''
  const currentConfigPath = activeConfigPath.value || info.configPath
  return [
    '你现在负责给 Super High 画布写像素图配置。',
    `工作目录固定为：${info.appRootPath}`,
    `只在这个目录创建或编辑 .md 或 .dragon 配置：${info.dragonCorePath}`,
    `当前正在预览的配置：${currentConfigPath}`,
    '可以创建多个命名配置，例如 gold-sword.md、iron-sword.md、potion.md；不要把所有图鉴都写进 main.md。',
    '不要读取或写入任何 Minecraft 插件目录。',
    '不要生成 PNG，不要修改 output.png；应用会读取 DragonCore 里的 .md 或 .dragon 配置并渲染画布。',
    '格式如下：',
    'width: 16',
    'height: 16',
    '',
    'colors:',
    '[0]=rgba(0,0,0,0)',
    '[1]=&a',
    '[2]=#ffcc00ff',
    '',
    'pixels:',
    'x:1,y:1[1]',
    'x:2,y:1[2]',
    'x:1~10,y:4[1]',
    'x:4,y:1~10[1]',
    'x:3~8,y:3~6[2]',
    '',
    '如果文件是 Markdown，就把上面的配置放进唯一的 ```dragon-pixel 代码块中，不要写别的内容。',
    '',
    '坐标从 1 开始，x:1,y:1 是左上角像素。未写到的像素透明。',
    '坐标支持闭区间范围：x:1~10,y:4[1] 是横条；x:4,y:1~10[1] 是竖条；x:3~8,y:3~6[2] 是矩形。',
    '需要图标模板时，可在 Super High 根目录运行 npm run dragon:icon:32 或 npm run dragon:icon:64；加 -- --name gold-sword 可以写入 DragonCore/gold-sword.md。',
    '生成 icon 时风格保持克制、质感明确、边缘干净，不要过于卡通。',
    '',
    '终端进度输出规范：生成或修改配置时，用 ANSI synchronized update 刷新固定状态块；每秒最多刷新 10 次，只显示状态、百分比和低清色块预览。',
    'ANSI 帧格式：以 \\x1b[?2026h 开始，以 \\x1b[?2026l 结束；刷新旧状态块时用 \\r、\\x1b[2K 和 \\x1b[<n>A 原地覆盖；处理完成后输出 \\x1b[?25h 恢复光标。',
    '不要把 PNG、base64 或大段图片数据输出到终端；高清预览由 Super High 读取配置后在右侧画布显示。',
  ].join('\n')
})

onMounted(() => {
  void ensureDragonCore()
  window.addEventListener('superhigh:dragon-files-changed', onDragonFilesChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('superhigh:dragon-files-changed', onDragonFilesChanged)
})

function onDragonFilesChanged() {
  void refreshConfig({ silent: true })
  void refreshDragonFiles()
}

async function ensureDragonCore() {
  isLoading.value = true
  exportError.value = ''
  try {
    const info = await backend.ensureDragonCore()
    dragonCoreInfo.value = info
    activeConfigPath.value = info.configPath
    configContent.value = info.configContent
    parseAndRender(info.configContent, `已读取 ${fileNameFromPath(info.configPath)}`)
    await store.loadDirectory(info.dragonCorePath, true).catch(() => undefined)
  } catch (error) {
    exportError.value = formatError(error)
    parsedDocument.value = null
    clearPreview()
  } finally {
    isLoading.value = false
  }
}

async function refreshConfig(options: { silent?: boolean; allowDuringExport?: boolean } = {}) {
  const info = dragonCoreInfo.value
  if (!info || isLoading.value || (!options.allowDuringExport && isExporting.value)) return
  const configPath = activeConfigPath.value || info.configPath
  try {
    const nextContent = await backend.readFile(configPath)
    if (options.silent && nextContent === configContent.value) return
    configContent.value = nextContent
    parseAndRender(nextContent, `已读取 ${fileNameFromPath(configPath)}`)
  } catch (error) {
    if (!options.silent) exportError.value = formatError(error)
  }
}

async function refreshDragonFiles() {
  const path = dragonCoreInfo.value?.dragonCorePath
  if (!path) return
  await store.loadDirectory(path, true).catch(() => undefined)
}

async function renderDragonFile(entry: FileEntry) {
  if (entry.type !== 'file') return
  if (!['.dragon', '.md'].includes(fileExtension(entry.name))) {
    store.showActivityMessage('只有 .md 或 .dragon 配置会渲染到画布')
    return
  }
  const info = dragonCoreInfo.value
  if (!info) return
  exportError.value = ''
  try {
    const nextContent = await backend.readFile(entry.path)
    activeConfigPath.value = entry.path
    configContent.value = nextContent
    parseAndRender(nextContent, `已渲染 ${entry.name}`)
  } catch (error) {
    exportError.value = formatError(error)
  }
}

function parseAndRender(source: string, successMessage = '配置已读取') {
  exportError.value = ''
  try {
    const document = parseDragonImageConfig(extractDragonPixelSource(source))
    parsedDocument.value = document
    parseIssues.value = []
    statusMessage.value = successMessage
    void drawPreview(document)
  } catch (error) {
    parsedDocument.value = null
    clearPreview()
    if (error instanceof DragonImageParseError) {
      parseIssues.value = error.issues
      statusMessage.value = '配置有错误'
      return
    }
    parseIssues.value = [{ lineNumber: 1, message: formatError(error) }]
    statusMessage.value = '配置有错误'
  }
}

async function drawPreview(document: DragonImageDocument) {
  await nextTick()
  const target = canvas.value
  if (!target) return
  target.width = document.width
  target.height = document.height
  const context = target.getContext('2d')
  if (!context) return
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, document.width, document.height)
  context.putImageData(new ImageData(buildDragonPixelBuffer(document), document.width, document.height), 0, 0)
}

function clearPreview() {
  const target = canvas.value
  if (!target) return
  target.width = 1
  target.height = 1
  const context = target.getContext('2d')
  context?.clearRect(0, 0, 1, 1)
}

async function exportImage() {
  isExporting.value = true
  exportError.value = ''
  try {
    await refreshConfig({ allowDuringExport: true })
    const document = parsedDocument.value
    if (!document) throw new Error(`${activeConfigName.value} 还有错误，不能导出`)
    const outputPath = await backend.exportDragonImage(renderToPngDataUrl(document), outputFileNameForActiveConfig())
    if (dragonCoreInfo.value) dragonCoreInfo.value = { ...dragonCoreInfo.value, outputPath }
    statusMessage.value = `已导出 ${outputPath}`
    store.showActivityMessage(`已导出：${outputPath}`)
    if (dragonCoreInfo.value?.dragonCorePath) {
      await store.loadDirectory(dragonCoreInfo.value.dragonCorePath, true).catch(() => undefined)
    }
  } catch (error) {
    exportError.value = formatError(error)
  } finally {
    isExporting.value = false
  }
}

function renderToPngDataUrl(document: DragonImageDocument): string {
  const target = window.document.createElement('canvas')
  target.width = document.width
  target.height = document.height
  const context = target.getContext('2d')
  if (!context) throw new Error('无法创建 PNG 画布')
  context.imageSmoothingEnabled = false
  context.putImageData(new ImageData(buildDragonPixelBuffer(document), document.width, document.height), 0, 0)
  return target.toDataURL('image/png')
}

function outputFileNameForActiveConfig(): string {
  const name = activeConfigName.value
  const lower = name.toLowerCase()
  const stem = lower.endsWith('.dragon')
    ? name.slice(0, -'.dragon'.length)
    : lower.endsWith('.md')
      ? name.slice(0, -'.md'.length)
      : name
  return `${stem || 'output'}.png`
}

function setZoom(nextZoom: number) {
  zoom.value = Math.min(32, Math.max(0.25, nextZoom))
}

function onZoomInput(event: Event) {
  setZoom(Number((event.target as HTMLInputElement).value))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() ?? ''
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}
</script>

<template>
  <section class="dragon-workspace-panel" aria-label="画布工作区">
    <div class="dragon-workspace-body">
      <div class="dragon-cli-pane">
        <TerminalPane
          v-if="dragonCoreInfo"
          mode="cli"
          scope="dragon"
          :cwd="dragonCoreInfo.appRootPath"
          :initial-prompt="dragonPrompt"
        />
        <div v-else class="dragon-loading-panel">
          {{ isLoading ? '正在准备画布目录...' : '画布目录不可用' }}
        </div>
      </div>

      <aside class="dragon-preview-pane panel">
        <div class="dragon-preview-toolbar">
          <div class="dragon-preview-meta">
            <span>{{ imageMeta }}</span>
            <span>{{ statusMessage || '等待配置' }}</span>
          </div>
          <div class="dragon-zoom-controls">
            <button class="image-zoom-button" type="button" @click="setZoom(1)">100%</button>
            <button class="image-zoom-button" type="button" @click="setZoom(4)">400%</button>
            <button class="image-zoom-button" type="button" @click="setZoom(12)">1200%</button>
            <input
              class="dragon-zoom-slider"
              type="range"
              min="0.25"
              max="32"
              step="0.25"
              :value="zoom"
              @input="onZoomInput"
            />
            <span class="dragon-zoom-label">{{ zoomPercent }}</span>
          </div>
          <button class="primary-button small" type="button" :disabled="isExporting || !parsedDocument" @click="exportImage">
            <Download :size="13" />
            <span>{{ isExporting ? '导出中...' : '导出图片' }}</span>
          </button>
        </div>

        <div v-if="parseIssues.length || exportError" class="dragon-error-list">
          <div v-if="exportError">{{ exportError }}</div>
          <div v-for="issue in parseIssues" :key="`${issue.lineNumber}:${issue.message}`">
            {{ issue.message }}
          </div>
        </div>

        <div class="dragon-canvas-stage">
          <canvas
            v-show="parsedDocument"
            ref="canvas"
            class="dragon-pixel-canvas"
            :style="canvasStyle"
          />
          <div v-if="!parsedDocument" class="dragon-canvas-empty">
            {{ activeConfigName }} 未生成可预览图片
          </div>
        </div>
      </aside>

      <ExplorerPane
        class="dragon-files-pane"
        title="生成文件"
        empty-text="还没有生成文件。"
        custom-file-open
        :root-path="dragonCoreInfo?.dragonCorePath ?? ''"
        @file-open="renderDragonFile"
      />
    </div>
  </section>
</template>
