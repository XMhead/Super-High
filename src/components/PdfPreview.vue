<script setup lang="ts">
import FileOpenActions from './FileOpenActions.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { boundedPdfScale, pdfImageRegions, type PdfImageRegion } from '@/lib/pdfImageRegions'
import DocumentImageViewer from './DocumentImageViewer.vue'

GlobalWorkerOptions.workerSrc = workerUrl
const props = defineProps<{ path: string; content: string }>()
const stage = ref<HTMLElement | null>(null)
const canvasHost = ref<HTMLElement | null>(null)
const pageHost = ref<HTMLElement | null>(null)
const pdf = shallowRef<PDFDocumentProxy | null>(null)
const page = shallowRef<PDFPageProxy | null>(null)
const pageNumber = ref(1)
const pageInput = ref('1')
const zoom = ref('fit')
const stageWidth = ref(0)
const pixelRatio = ref(window.devicePixelRatio || 1)
const loading = ref(true)
const rendering = ref(false)
const error = ref('')
const detailError = ref('')
const detailLoading = ref(false)
const imageSrc = ref('')
const expanded = ref(false)
function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && !imageSrc.value) expanded.value = false
}
const regions = ref<PdfImageRegion[]>([])
const pageSize = ref({ width: 612, height: 792 })
const displayedScale = ref(1)
const selecting = ref(false)
const selection = ref<{ x: number; y: number; endX: number; endY: number } | null>(null)
let pointerId: number | null = null
let loadingTask: PDFDocumentLoadingTask | null = null
let renderTask: RenderTask | null = null
let detailTask: RenderTask | null = null
let generation = 0
let renderGeneration = 0
let detailGeneration = 0
let observer: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined
const totalPages = computed(() => pdf.value?.numPages ?? 0)
const desiredScale = computed(() => zoom.value === 'fit'
  ? Math.max(0.1, (stageWidth.value - 24) / pageSize.value.width) : Number(zoom.value) * 96 / 72)
const selectionStyle = computed(() => {
  const s = selection.value
  return s ? { left: `${Math.min(s.x, s.endX)}px`, top: `${Math.min(s.y, s.endY)}px`, width: `${Math.abs(s.endX - s.x)}px`, height: `${Math.abs(s.endY - s.y)}px` } : {}
})

function closeImage() {
  if (imageSrc.value) URL.revokeObjectURL(imageSrc.value)
  imageSrc.value = ''
}
function cancelDetail() {
  detailGeneration++
  detailTask?.cancel()
  detailTask = null
  detailLoading.value = false
  selection.value = null
  pointerId = null
  closeImage()
}
function jumpToPage() {
  const requested = Number(pageInput.value)
  if (Number.isFinite(requested)) pageNumber.value = Math.max(1, Math.min(totalPages.value, Math.trunc(requested)))
  pageInput.value = String(pageNumber.value)
}

async function loadPdf() {
  const current = ++generation
  ++renderGeneration
  renderTask?.cancel()
  renderTask = null
  cancelDetail()
  const previous = loadingTask
  loadingTask = null
  pdf.value = null
  page.value = null
  regions.value = []
  canvasHost.value?.replaceChildren()
  pageNumber.value = 1
  pageInput.value = '1'
  loading.value = true
  rendering.value = false
  error.value = ''
  detailError.value = ''
  try {
    await previous?.destroy()
    if (current !== generation) return
    const bytes = Uint8Array.from(atob(props.content), character => character.charCodeAt(0))
    const resources = `${import.meta.env.BASE_URL}pdfjs/`
    const task = getDocument({ data: bytes, cMapUrl: `${resources}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${resources}standard_fonts/`, wasmUrl: `${resources}wasm/` })
    loadingTask = task
    const document = await task.promise
    if (current !== generation) return
    pdf.value = document
    loading.value = false
    await nextTick()
    await renderPage()
  } catch (cause) {
    if (current === generation) error.value = `无法加载 PDF，文件可能已损坏或受密码保护。${cause instanceof Error ? ` ${cause.message}` : ''}`
  } finally {
    if (current === generation) loading.value = false
  }
}

async function renderPage() {
  const document = pdf.value
  if (!document) return
  const current = ++renderGeneration
  renderTask?.cancel()
  renderTask = null
  cancelDetail()
  rendering.value = true
  error.value = ''
  detailError.value = ''
  regions.value = []
  try {
    const nextPage = await document.getPage(pageNumber.value)
    if (current !== renderGeneration) return
    const baseViewport = nextPage.getViewport({ scale: 1 })
    pageSize.value = { width: baseViewport.width, height: baseViewport.height }
    const scale = desiredScale.value
    const outputScale = boundedPdfScale(baseViewport.width, baseViewport.height, scale * pixelRatio.value)
    const viewport = nextPage.getViewport({ scale: outputScale })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    canvas.style.width = `${baseViewport.width * scale}px`
    canvas.style.height = `${baseViewport.height * scale}px`
    canvas.setAttribute('aria-label', `PDF 第 ${pageNumber.value} 页`)
    const task = nextPage.render({ canvas, viewport })
    renderTask = task
    await task.promise
    if (current !== renderGeneration) return
    renderTask = null
    page.value = nextPage
    displayedScale.value = scale
    canvasHost.value?.replaceChildren(canvas)
    const operations = await nextPage.getOperatorList()
    if (current !== renderGeneration) return
    regions.value = pdfImageRegions(operations, baseViewport, id => {
      try { return (id.startsWith('g_') ? nextPage.commonObjs : nextPage.objs).get(id) } catch { return undefined }
    })
  } catch (cause) {
    if (current === renderGeneration && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
      error.value = `此页渲染失败。${cause instanceof Error ? ` ${cause.message}` : ''}`
    }
  } finally {
    if (current === renderGeneration) rendering.value = false
  }
}

async function openRegion(region: PdfImageRegion) {
  const currentPage = page.value
  if (!currentPage || rendering.value || loading.value) return
  cancelDetail()
  const current = ++detailGeneration
  detailLoading.value = true
  detailError.value = ''
  try {
    // Render directly from the PDF at the embedded image's resolution, never
    // enlarge a screenshot of the preview. This also preserves masks and rotation.
    const requestedScale = Math.max(4 * 96 / 72, region.pixelWidth / region.width, region.pixelHeight / region.height)
    const scale = boundedPdfScale(region.width, region.height, requestedScale, 32_000_000)
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(region.width * scale)
    canvas.height = Math.ceil(region.height * scale)
    const task = currentPage.render({ canvas, viewport: currentPage.getViewport({ scale }),
      transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale] })
    detailTask = task
    await task.promise
    if (current !== detailGeneration) return
    detailTask = null
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    canvas.width = canvas.height = 0
    if (current !== detailGeneration) return
    if (!blob) throw new Error('无法生成放大图。')
    imageSrc.value = URL.createObjectURL(blob)
  } catch (cause) {
    if (current === detailGeneration && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) detailError.value = `无法放大此区域。${cause instanceof Error ? ` ${cause.message}` : ''}`
  } finally {
    if (current === detailGeneration) detailLoading.value = false
  }
}

function point(event: PointerEvent) {
  const bounds = pageHost.value!.getBoundingClientRect()
  return { x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) }
}
function startSelection(event: PointerEvent) {
  if (!selecting.value || rendering.value || event.button !== 0 || !pageHost.value) return
  event.preventDefault()
  const p = point(event)
  selection.value = { ...p, endX: p.x, endY: p.y }
  pointerId = event.pointerId
  pageHost.value.setPointerCapture(event.pointerId)
}
function moveSelection(event: PointerEvent) {
  if (pointerId !== event.pointerId || !selection.value) return
  const p = point(event)
  selection.value = { ...selection.value, endX: p.x, endY: p.y }
}
function finishSelection(event: PointerEvent) {
  if (pointerId !== event.pointerId || !selection.value) return
  moveSelection(event)
  const s = selection.value
  pointerId = null
  pageHost.value?.releasePointerCapture(event.pointerId)
  selection.value = null
  if (Math.abs(s.endX - s.x) < 6 || Math.abs(s.endY - s.y) < 6) return
  const scale = displayedScale.value
  void openRegion({ x: Math.min(s.x, s.endX) / scale, y: Math.min(s.y, s.endY) / scale,
    width: Math.abs(s.endX - s.x) / scale, height: Math.abs(s.endY - s.y) / scale, pixelWidth: 0, pixelHeight: 0 })
}
function imageStyle(region: PdfImageRegion) {
  const scale = displayedScale.value
  return { left: `${region.x * scale}px`, top: `${region.y * scale}px`, width: `${region.width * scale}px`, height: `${region.height * scale}px` }
}
function updatePixelRatio() { pixelRatio.value = window.devicePixelRatio || 1 }
watch(() => [props.path, props.content], loadPdf)
watch(pageNumber, () => { pageInput.value = String(pageNumber.value); if (stage.value) stage.value.scrollTop = stage.value.scrollLeft = 0; void renderPage() })
watch([zoom, pixelRatio], () => { void renderPage() })
watch(stageWidth, () => {
  clearTimeout(resizeTimer)
  if (zoom.value === 'fit') resizeTimer = setTimeout(() => { void renderPage() }, 100)
})
onMounted(() => {
  window.addEventListener('keydown', handleEscape)
  if (stage.value) {
    stageWidth.value = stage.value.clientWidth
    observer = new ResizeObserver(([entry]) => { stageWidth.value = entry.contentRect.width })
    observer.observe(stage.value)
  }
  window.addEventListener('resize', updatePixelRatio)
  void loadPdf()
})
onBeforeUnmount(() => {
  generation++
  renderGeneration++
  renderTask?.cancel()
  cancelDetail()
  void loadingTask?.destroy().catch(() => {})
  observer?.disconnect()
  clearTimeout(resizeTimer)
  window.removeEventListener('resize', updatePixelRatio)
  window.removeEventListener('keydown', handleEscape)
})
</script>

<template>
  <section class="pdf-preview" :class="{ 'pdf-expanded': expanded }" aria-label="PDF 预览" :aria-busy="loading || rendering">
    <div class="pdf-toolbar">
      <button type="button" :aria-pressed="expanded" @click="expanded = !expanded">{{ expanded ? '收起阅读' : '展开阅读' }}</button>
      <button :disabled="pageNumber <= 1 || loading" aria-label="上一页" @click="pageNumber--">上一页</button>
      <form class="pdf-page-input" @submit.prevent="jumpToPage">
        <input v-model="pageInput" inputmode="numeric" aria-label="页码" :disabled="loading" @change="jumpToPage" />
        <span>/ {{ totalPages }}</span>
      </form>
      <button :disabled="pageNumber >= totalPages || loading" aria-label="下一页" @click="pageNumber++">下一页</button>
      <select v-model="zoom" aria-label="PDF 缩放">
        <option value="fit">适应宽度</option>
        <option value="1">100%</option><option value="1.5">150%</option>
        <option value="2">200%</option><option value="3">300%</option><option value="4">400%</option>
      </select>
      <button :class="{ active: selecting }" :aria-pressed="selecting" :disabled="!page || loading" @click="selecting = !selecting; selection = null">框选放大</button>
      <span class="pdf-hint">{{ detailLoading ? '正在生成清晰大图…' : selecting ? '拖动框选要查看的区域' : '点击图片可放大' }}</span>
    </div>
    <div v-if="error || detailError" class="pdf-error" role="alert">{{ error || detailError }}</div>
    <FileOpenActions v-if="error" :path="path" />
    <div ref="stage" class="pdf-stage">
      <div v-if="loading" class="pdf-status" role="status">正在加载 PDF…</div>
      <div v-if="rendering" class="pdf-rendering" role="status">正在渲染…</div>
      <div ref="pageHost" class="pdf-page" :class="{ selecting, busy: rendering || loading }"
        @pointerdown="startSelection" @pointermove="moveSelection" @pointerup="finishSelection" @pointercancel="selection = null; pointerId = null">
        <div ref="canvasHost" class="pdf-canvas" />
        <button v-for="(region, index) in regions" v-show="!selecting && !rendering" :key="index" class="pdf-image-region"
          :style="imageStyle(region)" :aria-label="`放大第 ${index + 1} 张图片`" title="点击放大图片" @click="openRegion(region)" />
        <div v-if="selection" class="pdf-selection" :style="selectionStyle" />
      </div>
    </div>
    <DocumentImageViewer v-if="imageSrc" :src="imageSrc" @close="closeImage" />
  </section>
</template>

<style scoped>
.pdf-preview { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; background: var(--color-bg-primary); }
.pdf-preview.pdf-expanded { position: fixed; inset: 40px 8px 8px; z-index: 2000; height: auto; border: 1px solid var(--color-border); }
.pdf-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; min-height: 36px; padding: 4px 8px; overflow-x: auto; white-space: nowrap; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); color: var(--color-text-secondary); font-size: 12px; }
.pdf-toolbar button, .pdf-toolbar select, .pdf-toolbar input { flex-shrink: 0; height: 26px; padding: 2px 7px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-input-bg); color: var(--color-text-primary); font: inherit; box-shadow: none; }
.pdf-toolbar button { cursor: pointer; }
.pdf-toolbar button:hover, .pdf-toolbar button.active { border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.pdf-toolbar button:disabled { opacity: .45; cursor: default; }
.pdf-toolbar :focus-visible { outline: 1px solid var(--color-accent-blue); outline-offset: -1px; }
.pdf-page-input { display: flex; align-items: center; gap: 5px; }
.pdf-page-input input { width: 46px; text-align: center; }
.pdf-hint { color: var(--color-text-secondary); }
.pdf-stage { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.pdf-page { position: relative; width: max-content; margin: 0 auto; line-height: 0; background: white; color-scheme: light; }
.pdf-canvas :deep(canvas) { display: block; }
.pdf-page.selecting { cursor: crosshair; touch-action: none; }
.pdf-page.busy { pointer-events: none; }
.pdf-status, .pdf-error { padding: 12px; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }
.pdf-error { color: var(--color-accent-red); }
.pdf-rendering { position: sticky; z-index: 2; top: 0; width: max-content; padding: 4px 8px; margin-bottom: 6px; border: 1px solid var(--color-border); background: var(--surface-overlay); color: var(--color-text-primary); font-size: 12px; }
.pdf-image-region { position: absolute; padding: 0; border: 1px solid transparent; border-radius: 0; background: transparent; cursor: zoom-in; box-shadow: none; }
.pdf-image-region:hover, .pdf-image-region:focus-visible { border-color: var(--color-accent-blue); outline: 1px solid var(--color-accent-blue); outline-offset: -1px; }
.pdf-selection { position: absolute; pointer-events: none; border: 1px solid var(--color-accent-blue); background: var(--surface-accent-blue-soft); }
</style>
