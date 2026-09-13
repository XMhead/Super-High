<script setup lang="ts">
import FileOpenActions from './FileOpenActions.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { WorkBook } from 'xlsx'
import { extensionFromPath } from '@/lib/path'
import { backend } from '@/lib/tauri'
import DocumentImageViewer from './DocumentImageViewer.vue'

const props = defineProps<{ path: string; content: string }>()
const isWord = computed(() => ['.doc', '.docx'].includes(extensionFromPath(props.path)))
const selectedImage = ref('')
const expanded = ref(false)
function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && !selectedImage.value) expanded.value = false
}
const loading = ref(true)
const error = ref('')
const wordHost = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const workbook = shallowRef<WorkBook | null>(null)
const sheetReader = shallowRef<typeof import('@/lib/officeSpreadsheet') | null>(null)
const sheetIndex = ref(0)
const rowPage = ref(0)
const columnPage = ref(0)
const zoom = ref('fit')
const stageWidth = ref(0)
const documentWidth = ref(800)
let generation = 0
let observer: ResizeObserver | null = null

const sheetNames = computed(() => workbook.value?.SheetNames ?? [])
const activeSheet = computed(() => workbook.value?.Sheets[sheetNames.value[sheetIndex.value]])
const size = computed(() => activeSheet.value && sheetReader.value
  ? sheetReader.value.sheetSize(activeSheet.value) : { rows: 0, columns: 0 })
const page = computed(() => activeSheet.value && sheetReader.value
  ? sheetReader.value.buildSheetPage(activeSheet.value, size.value, rowPage.value, columnPage.value) : null)
const rowPages = computed(() => Math.ceil(size.value.rows / (sheetReader.value?.SHEET_PAGE_ROWS ?? 200)))
const columnPages = computed(() => Math.ceil(size.value.columns / (sheetReader.value?.SHEET_PAGE_COLUMNS ?? 40)))
const wordZoom = computed(() => zoom.value === 'fit'
  ? Math.min(1, Math.max(0.1, (stageWidth.value - 24) / documentWidth.value)) : Number(zoom.value))

function handleWordLink(event: MouseEvent) {
  const image = event.composedPath().find((node) => node instanceof HTMLImageElement) as HTMLImageElement | undefined
  if (image) {
    event.preventDefault()
    selectedImage.value = image.currentSrc || image.src
    return
  }
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (href.startsWith('#')) {
    wordHost.value?.shadowRoot?.getElementById(href.slice(1))?.scrollIntoView({ block: 'nearest' })
  } else if (/^https?:\/\//i.test(href)) {
    void backend.openUrl(href).catch(() => { error.value = '无法打开文档中的链接。' })
  }
}

async function renderPreview() {
  const current = ++generation
  loading.value = true
  error.value = ''
  selectedImage.value = ''
  workbook.value = null
  sheetIndex.value = 0
  rowPage.value = 0
  columnPage.value = 0
  try {
    const bytes = Uint8Array.from(atob(props.content), (character) => character.charCodeAt(0))
    if (isWord.value) {
      const { renderAsync } = await import('docx-preview')
      if (current !== generation) return
      await nextTick()
      const host = wordHost.value
      if (!host) return
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
      const body = document.createElement('div')
      const styles = document.createElement('div')
      const overrides = document.createElement('style')
      overrides.textContent = ':host { display: block; width: max-content; margin: 0 auto; color-scheme: light; } .docx-wrapper { padding: 0; background: transparent; } .docx-wrapper > section.docx { margin: 0 0 12px; box-shadow: none; } img { image-rendering: auto; cursor: zoom-in; } img:focus-visible { outline: 2px solid var(--color-accent-blue); }'
      shadow.replaceChildren(styles, body, overrides)
      await renderAsync(bytes, body, styles, {
        useBase64URL: true,
        ignoreFonts: false,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
      })
      if (current !== generation) return
      body.querySelectorAll('img').forEach((image) => {
        image.tabIndex = 0
        image.title = '点击放大查看图片'
        image.setAttribute('role', 'button')
        image.setAttribute('aria-label', image.alt ? `放大图片：${image.alt}` : '放大文档图片')
        image.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectedImage.value = image.currentSrc || image.src
          }
        })
      })
      documentWidth.value = body.offsetWidth || 800
    } else {
      const reader = await import('@/lib/officeSpreadsheet')
      if (current !== generation) return
      sheetReader.value = reader
      workbook.value = reader.parseSpreadsheet(bytes)
      if (!workbook.value.SheetNames.length) throw new Error('工作簿中没有工作表。')
    }
  } catch (cause) {
    if (current === generation) {
      error.value = `无法解析此${isWord.value ? '文档' : '工作簿'}，文件可能已损坏或受密码保护。${cause instanceof Error ? ` ${cause.message}` : ''}`
    }
  } finally {
    if (current === generation) loading.value = false
  }
}

watch(() => [props.path, props.content], renderPreview, { immediate: true, flush: 'post' })
watch(sheetIndex, () => { rowPage.value = 0; columnPage.value = 0 })
watch([sheetIndex, rowPage, columnPage], () => {
  if (stage.value) { stage.value.scrollTop = 0; stage.value.scrollLeft = 0 }
})
onMounted(() => {
  window.addEventListener('keydown', handleEscape)
  if (stage.value) {
    stageWidth.value = stage.value.clientWidth
    observer = new ResizeObserver(([entry]) => { stageWidth.value = entry.contentRect.width })
    observer.observe(stage.value)
  }
})
onBeforeUnmount(() => { generation++; observer?.disconnect(); window.removeEventListener('keydown', handleEscape) })
</script>

<template>
  <section class="office-preview" :class="{ 'office-expanded': expanded }" :aria-label="isWord ? 'Word 文档预览' : 'Excel 工作簿预览'" :aria-busy="loading">
    <div class="office-toolbar">
      <span class="office-format">{{ isWord ? 'Word' : 'Excel' }} · 只读</span>
      <button type="button" :aria-pressed="expanded" @click="expanded = !expanded">{{ expanded ? '收起阅读' : '展开阅读' }}</button>
      <select v-if="isWord" v-model="zoom" aria-label="文档缩放">
        <option value="fit">适应宽度</option>
        <option value="0.5">50%</option><option value="0.75">75%</option>
        <option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
        <option value="2">200%</option><option value="3">300%</option><option value="4">400%</option>
      </select>
      <span v-if="isWord">点击图片放大</span>
      <template v-else-if="workbook && page">
        <select v-model="sheetIndex" aria-label="工作表">
          <option v-for="(name, index) in sheetNames" :key="name" :value="index">{{ name }}</option>
        </select>
        <span>{{ size.rows }} 行 × {{ size.columns }} 列</span>
        <template v-if="rowPages > 1">
          <button type="button" :disabled="rowPage === 0" aria-label="上一页行" @click="rowPage--">上一页</button>
          <span>{{ page.startRow + 1 }}–{{ page.endRow }} 行</span>
          <button type="button" :disabled="rowPage >= rowPages - 1" aria-label="下一页行" @click="rowPage++">下一页</button>
        </template>
        <template v-if="columnPages > 1">
          <button type="button" :disabled="columnPage === 0" aria-label="前一组列" @click="columnPage--">前列</button>
          <span>{{ page.columns[0]?.label }}–{{ page.columns.at(-1)?.label }} 列</span>
          <button type="button" :disabled="columnPage >= columnPages - 1" aria-label="后一组列" @click="columnPage++">后列</button>
        </template>
      </template>
    </div>
    <div v-if="loading" class="office-message" role="status">正在解析{{ isWord ? '文档' : '工作簿' }}…</div>
    <div v-if="error" class="office-message office-error" role="alert">{{ error }}</div>
    <FileOpenActions v-if="error" :path="path" />
    <div ref="stage" class="office-stage" :class="{ 'office-word-stage': isWord }" v-show="!error">
      <div v-if="isWord" ref="wordHost" class="office-word" :style="{ zoom: wordZoom, visibility: loading ? 'hidden' : 'visible' }" @click="handleWordLink" />
      <template v-else-if="page && !loading">
        <table v-if="size.rows && size.columns" class="office-sheet">
          <colgroup><col class="office-row-number" /><col v-for="column in page.columns" :key="column.label" :style="{ width: `${column.width}px` }" /></colgroup>
          <thead><tr><th aria-label="行号" /><th v-for="column in page.columns" :key="column.label" scope="col">{{ column.label }}</th></tr></thead>
          <tbody>
            <tr v-for="row in page.rows" :key="row.number">
              <th scope="row">{{ row.number }}</th>
              <td v-for="cell in row.cells" :key="cell.key" :rowspan="cell.rowSpan" :colspan="cell.colSpan" :title="cell.title" :data-cell="cell.address" :class="{ numeric: cell.numeric }">{{ cell.text }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="office-message">此工作表为空。</div>
      </template>
    </div>
    <DocumentImageViewer v-if="selectedImage" :src="selectedImage" @close="selectedImage = ''" />
  </section>
</template>

<style scoped>
.office-preview { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: var(--color-text-primary); background: var(--color-bg-primary); }
.office-preview.office-expanded { position: fixed; inset: 40px 8px 8px; z-index: 2000; border: 1px solid var(--color-border); }
.office-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; min-height: 34px; padding: 4px 10px; overflow-x: auto; white-space: nowrap; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); font-size: 12px; color: var(--color-text-secondary); }
.office-format { flex-shrink: 0; }
.office-toolbar select, .office-toolbar button { flex-shrink: 0; height: 26px; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-primary); color: var(--color-text-primary); font: inherit; box-shadow: none; }
.office-toolbar select { max-width: 220px; }
.office-toolbar button:disabled { opacity: 0.4; cursor: default; }
.office-toolbar button:hover:not(:disabled) { background: var(--color-bg-hover); }
.office-toolbar :focus-visible { outline: 1px solid var(--color-accent-blue); outline-offset: 1px; }
.office-message { padding: 16px; color: var(--color-text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.office-error { color: var(--color-accent-red); }
.office-stage { flex: 1; min-width: 0; min-height: 0; overflow: auto; }
.office-word-stage { padding: 12px; background: var(--color-bg-tertiary); }
.office-sheet { table-layout: fixed; width: max-content; border-collapse: separate; border-spacing: 0; font-size: 12px; line-height: 1.5; }
.office-row-number { width: 50px; }
.office-sheet th, .office-sheet td { padding: 5px 8px; border-right: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.office-sheet th { background: var(--color-bg-secondary); color: var(--color-text-secondary); font-weight: 500; text-align: center; }
.office-sheet thead th { position: sticky; top: 0; z-index: 2; }
.office-sheet tbody th { position: sticky; left: 0; z-index: 1; }
.office-sheet thead th:first-child { left: 0; z-index: 3; }
.office-sheet td.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.office-sheet tbody tr:hover td { background: var(--color-bg-hover); }
</style>
