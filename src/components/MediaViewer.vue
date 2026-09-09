<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  Crop,
  Download,
  Eye,
  Files,
  FolderOpen,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Pipette,
  Save,
  Scan,
  X,
} from 'lucide-vue-next'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'

import {
  extensionFromPath,
  fileNameFromPath,
  isMediaFile,
  isMediaImage,
  isMediaVideo,
  isRasterMediaImage,
  normalizePath,
} from '@/lib/path'
import { backend, isTauri } from '@/lib/tauri'

const props = defineProps<{
  initialPath: string
}>()

const emit = defineEmits<{
  closeApproved: []
}>()

type ViewerMode = 'view' | 'edit'
type ZoomMode = 'fit' | 'custom'
type StatusTone = 'normal' | 'error'

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

interface DrawState {
  pointerId: number
  x: number
  y: number
}

interface CropState {
  pointerId: number
  start: CanvasPoint
}

interface PendingAction {
  kind: 'navigate' | 'close'
  path?: string
}

interface CanvasPoint {
  x: number
  y: number
}

interface CropSelection {
  x: number
  y: number
  width: number
  height: number
}

interface RgbaColor {
  red: number
  green: number
  blue: number
  alpha: number
}

interface PaletteColor extends RgbaColor {
  count: number
  key: string
}

const ZOOM_PRESETS = [1, 2, 4, 8] as const
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
const VIEWPORT_PADDING = 48
const ASEPRITE_CHECKER_SIZE = 16
const ASEPRITE_CHECKER_COLOR_ONE = '#808080'
const ASEPRITE_CHECKER_COLOR_TWO = '#c0c0c0'

const stageElement = ref<HTMLElement | null>(null)
const imageElement = ref<HTMLImageElement | null>(null)
const videoElement = ref<HTMLVideoElement | null>(null)
const checkerboardElement = ref<HTMLCanvasElement | null>(null)
const canvasElement = ref<HTMLCanvasElement | null>(null)
const selectionOverlayElement = ref<HTMLCanvasElement | null>(null)
const mediaPaths = ref<string[]>([])
const currentPath = ref(normalizePath(props.initialPath))
const mediaDataUrl = ref('')
const loading = ref(true)
const loadError = ref('')
const mediaWidth = ref(0)
const mediaHeight = ref(0)
const viewerMode = ref<ViewerMode>('view')
const canvasReady = ref(false)
const isDirty = ref(false)
const brushSize = ref(1)
const eyedropperActive = ref(false)
const cropMode = ref(false)
const cropWidthInput = ref('')
const cropHeightInput = ref('')
const cropSelection = ref<CropSelection | null>(null)
const replacementSource = ref<RgbaColor>({ red: 0, green: 0, blue: 0, alpha: 255 })
const replacementTarget = ref<RgbaColor>({ red: 0, green: 0, blue: 0, alpha: 255 })
const replacementRange = ref(1)
const paletteColors = ref<PaletteColor[]>([])
const selectionPreviewActive = ref(false)
const replacementMenuOpen = ref(false)
const zoomMode = ref<ZoomMode>('fit')
const customZoom = ref(1)
const panX = ref(0)
const panY = ref(0)
const dragState = ref<DragState | null>(null)
const drawState = ref<DrawState | null>(null)
const cropState = ref<CropState | null>(null)
const brushPreviewPoint = ref<CanvasPoint | null>(null)
const pendingAction = ref<PendingAction | null>(null)
const exportedPath = ref<string | null>(null)
const viewportVersion = ref(0)
const copyBusy = ref(false)
const saveBusy = ref(false)
const statusMessage = ref('')
const statusTone = ref<StatusTone>('normal')
const windowFullscreen = ref(false)
let loadSequence = 0
let resizeObserver: ResizeObserver | null = null

const currentName = computed(() => fileNameFromPath(currentPath.value))
const currentIsImage = computed(() => isMediaImage(currentPath.value))
const currentIsVideo = computed(() => isMediaVideo(currentPath.value))
const currentIsRasterImage = computed(() => isRasterMediaImage(currentPath.value))
const canEdit = computed(() => (
  currentIsRasterImage.value
  && !!mediaDataUrl.value
  && !loading.value
  && !loadError.value
  && mediaWidth.value > 0
  && mediaHeight.value > 0
))
const canSaveInPlace = computed(() => (
  canvasReady.value && ['.png', '.jpg', '.jpeg'].includes(extensionFromPath(currentPath.value))
))
const currentIndex = computed(() => {
  const key = currentPath.value.toLowerCase()
  return mediaPaths.value.findIndex((path) => path.toLowerCase() === key)
})
const positionLabel = computed(() => {
  if (!mediaPaths.value.length || currentIndex.value < 0) return '1 / 1'
  return `${currentIndex.value + 1} / ${mediaPaths.value.length}`
})
const fitZoom = computed(() => {
  viewportVersion.value
  const stage = stageElement.value
  if (!stage || !mediaWidth.value || !mediaHeight.value) return 1
  const availableWidth = Math.max(1, stage.clientWidth - VIEWPORT_PADDING * 2)
  const availableHeight = Math.max(1, stage.clientHeight - VIEWPORT_PADDING * 2)
  return Math.min(MAX_ZOOM, Math.max(0.001, Math.min(availableWidth / mediaWidth.value, availableHeight / mediaHeight.value)))
})
const displayedZoom = computed(() => zoomMode.value === 'fit' ? fitZoom.value : customZoom.value)
const imageStyle = computed(() => ({
  width: mediaWidth.value ? `${mediaWidth.value}px` : 'auto',
  height: mediaHeight.value ? `${mediaHeight.value}px` : 'auto',
  transform: `translate(-50%, -50%) translate(${panX.value}px, ${panY.value}px) scale(${displayedZoom.value})`,
}))
const brushPreviewStyle = computed(() => {
  const point = brushPreviewPoint.value
  const canvas = canvasElement.value
  if (!point || !canvas) return null
  const rect = brushRectAt(point)
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    background: rgbaCss(replacementTarget.value),
  }
})
const cropSelectionStyle = computed(() => {
  const selection = cropSelection.value
  if (!selection) return null
  return {
    left: `${selection.x}px`,
    top: `${selection.y}px`,
    width: `${selection.width}px`,
    height: `${selection.height}px`,
  }
})
const pendingSaveLabel = computed(() => canSaveInPlace.value ? '保存' : '导出 PNG')
const pendingMessage = computed(() => (
  canSaveInPlace.value
    ? '图片有未保存修改。继续前是否保存？'
    : '当前图片不能原地保存。继续前是否导出 PNG？'
))

function normalizeDirectoryPath(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '')
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`
  return normalized
}

function parentDirectoryOf(path: string): string {
  const normalized = normalizeDirectoryPath(path)
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized
  const index = normalized.lastIndexOf('/')
  if (index === 2 && normalized[1] === ':') return normalized.slice(0, 3)
  return index > 0 ? normalized.slice(0, index) : normalized
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 1000) / 1000))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setStatus(message: string, tone: StatusTone = 'normal') {
  statusMessage.value = message
  statusTone.value = tone
}

function resetView() {
  zoomMode.value = 'fit'
  customZoom.value = 1
  panX.value = 0
  panY.value = 0
  stopPan()
  stopDraw()
  stopCrop()
}

function resetEditor() {
  viewerMode.value = 'view'
  canvasReady.value = false
  isDirty.value = false
  eyedropperActive.value = false
  cropMode.value = false
  cropWidthInput.value = ''
  cropHeightInput.value = ''
  cropSelection.value = null
  paletteColors.value = []
  selectionPreviewActive.value = false
  replacementMenuOpen.value = false
  brushPreviewPoint.value = null
  pendingAction.value = null
  exportedPath.value = null
}

function canvasContext(): CanvasRenderingContext2D | null {
  return canvasElement.value?.getContext('2d') ?? null
}

function drawAsepriteCheckerboard(width: number, height: number) {
  const checkerboard = checkerboardElement.value
  if (!checkerboard || width <= 0 || height <= 0) return
  checkerboard.width = width
  checkerboard.height = height
  const context = checkerboard.getContext('2d')
  if (!context) return
  context.imageSmoothingEnabled = false

  for (let y = 0, row = 0; y < height; y += ASEPRITE_CHECKER_SIZE, row += 1) {
    for (let x = 0, column = 0; x < width; x += ASEPRITE_CHECKER_SIZE, column += 1) {
      context.fillStyle = (row + column) % 2
        ? ASEPRITE_CHECKER_COLOR_TWO
        : ASEPRITE_CHECKER_COLOR_ONE
      context.fillRect(
        x,
        y,
        Math.min(ASEPRITE_CHECKER_SIZE, width - x),
        Math.min(ASEPRITE_CHECKER_SIZE, height - y),
      )
    }
  }
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function rgbaKey(color: RgbaColor): string {
  return `${color.red},${color.green},${color.blue},${color.alpha}`
}

function rgbaCss(color: RgbaColor): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha / 255})`
}

function rgbaLabel(color: RgbaColor): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})`
}

function colorInputValue(color: RgbaColor): string {
  return `#${[color.red, color.green, color.blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function syncCropInputs(selection = cropSelection.value) {
  cropWidthInput.value = selection ? String(selection.width) : ''
  cropHeightInput.value = selection ? String(selection.height) : ''
}

function resetCropSelection(width = mediaWidth.value, height = mediaHeight.value) {
  cropSelection.value = width > 0 && height > 0 ? { x: 0, y: 0, width, height } : null
  syncCropInputs()
}

function setReplacementColor(target: 'source' | 'target', color: RgbaColor) {
  const next = {
    red: clampColorChannel(color.red),
    green: clampColorChannel(color.green),
    blue: clampColorChannel(color.blue),
    alpha: clampColorChannel(color.alpha),
  }
  if (target === 'source') replacementSource.value = next
  else replacementTarget.value = next
  queueSelectionOverlay()
}

function updateReplacementColor(target: 'source' | 'target', event: Event) {
  const value = (event.currentTarget as HTMLInputElement).value
  if (!/^#[0-9a-f]{6}$/i.test(value)) return
  const current = target === 'source' ? replacementSource.value : replacementTarget.value
  setReplacementColor(target, {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
    alpha: current.alpha,
  })
}

function updateReplacementRange(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const value = Number(input.value)
  if (!Number.isFinite(value)) {
    input.value = String(replacementRange.value)
    return
  }
  replacementRange.value = Math.max(1, Math.min(255, Math.round(value)))
  input.value = String(replacementRange.value)
}

function refreshPalette() {
  const canvas = canvasElement.value
  const context = canvasContext()
  if (!canvas || !context || !canvas.width || !canvas.height) return
  const counts = new Map<string, PaletteColor>()
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 0; index < data.length; index += 4) {
    const color: RgbaColor = {
      red: data[index],
      green: data[index + 1],
      blue: data[index + 2],
      alpha: data[index + 3],
    }
    const key = rgbaKey(color)
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { ...color, key, count: 1 })
  }
  paletteColors.value = [...counts.values()]
  queueSelectionOverlay()
}

function selectPaletteColor(color: PaletteColor, target: 'source' | 'target') {
  setReplacementColor(target, color)
}

function queueSelectionOverlay() {
  if (!selectionPreviewActive.value) return
  void nextTick().then(drawSelectionOverlay)
}

function matchesColor(pixel: RgbaColor, color: RgbaColor): boolean {
  return pixel.red === color.red
    && pixel.green === color.green
    && pixel.blue === color.blue
    && pixel.alpha === color.alpha
}

function drawSelectionOverlay() {
  const canvas = canvasElement.value
  const overlay = selectionOverlayElement.value
  const sourceContext = canvasContext()
  const overlayContext = overlay?.getContext('2d')
  if (!canvas || !overlay || !sourceContext || !overlayContext) return
  overlay.width = canvas.width
  overlay.height = canvas.height
  overlayContext.clearRect(0, 0, overlay.width, overlay.height)
  if (!selectionPreviewActive.value) return

  const source = replacementSource.value
  const target = replacementTarget.value
  const data = sourceContext.getImageData(0, 0, canvas.width, canvas.height).data
  overlayContext.strokeStyle = '#ffffff'
  overlayContext.lineWidth = 0.1
  for (let index = 0; index < data.length; index += 4) {
    const pixel = { red: data[index], green: data[index + 1], blue: data[index + 2], alpha: data[index + 3] }
    if (!matchesColor(pixel, source) && !matchesColor(pixel, target)) continue
    const pixelIndex = index / 4
    const x = pixelIndex % canvas.width
    const y = Math.floor(pixelIndex / canvas.width)
    overlayContext.strokeRect(x + 0.05, y + 0.05, 0.9, 0.9)
  }
}

function toggleSelectionPreview() {
  selectionPreviewActive.value = !selectionPreviewActive.value
  queueSelectionOverlay()
}

async function copyRgbaColor(color: RgbaColor) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持复制文本')
    await navigator.clipboard.writeText(rgbaLabel(color))
    setStatus(`已复制 ${rgbaLabel(color)}`)
  } catch (error) {
    setStatus(`复制 RGBA 失败：${formatError(error)}`, 'error')
  }
}

function isWithinReplacementRange(pixel: RgbaColor, source: RgbaColor) {
  const range = replacementRange.value
  return Math.max(
    Math.abs(pixel.red - source.red),
    Math.abs(pixel.green - source.green),
    Math.abs(pixel.blue - source.blue),
    Math.abs(pixel.alpha - source.alpha),
  ) <= range
}

async function loadDirectoryMedia() {
  const directory = parentDirectoryOf(currentPath.value)
  try {
    const listing = await backend.listDirectory(directory)
    const paths = listing.entries
      .filter((entry) => entry.type === 'file' && isMediaFile(entry.path))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
      .map((entry) => normalizePath(entry.path))
    if (!paths.some((path) => path.toLowerCase() === currentPath.value.toLowerCase())) {
      paths.push(currentPath.value)
      paths.sort((left, right) => fileNameFromPath(left).localeCompare(fileNameFromPath(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      }))
    }
    mediaPaths.value = paths
  } catch (error) {
    mediaPaths.value = [currentPath.value]
    setStatus(`同目录媒体列表读取失败：${formatError(error)}`, 'error')
  }
}

async function loadMedia(path: string) {
  const normalizedPath = normalizePath(path)
  const sequence = ++loadSequence
  currentPath.value = normalizedPath
  mediaDataUrl.value = ''
  loadError.value = ''
  loading.value = true
  mediaWidth.value = 0
  mediaHeight.value = 0
  statusMessage.value = ''
  resetEditor()
  resetView()
  try {
    const dataUrl = await backend.readMediaAsDataUrl(normalizedPath)
    if (sequence !== loadSequence) return
    mediaDataUrl.value = dataUrl
    if (isTauri()) void getCurrentWindow().setTitle(`${fileNameFromPath(normalizedPath)} - Super High`)
  } catch (error) {
    if (sequence !== loadSequence) return
    loadError.value = `无法读取媒体：${formatError(error)}`
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function configureViewerWindow() {
  if (!isTauri()) return
  try {
    const currentWindow = getCurrentWindow()
    await currentWindow.setMinSize(new LogicalSize(760, 520))
    await currentWindow.setSize(new LogicalSize(1100, 760))
    await currentWindow.center()
  } catch (error) {
    setStatus(`调整查看器窗口失败：${formatError(error)}`, 'error')
  }
}

function requestMediaChange(path: string) {
  if (path.toLowerCase() === currentPath.value.toLowerCase()) return
  if (isDirty.value) {
    pendingAction.value = { kind: 'navigate', path }
    return
  }
  void loadMedia(path)
}

function shiftMedia(delta: number) {
  const count = mediaPaths.value.length
  if (!count) return
  const index = currentIndex.value < 0 ? 0 : currentIndex.value
  const nextIndex = (index + delta + count) % count
  requestMediaChange(mediaPaths.value[nextIndex])
}

function handleImageLoad(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  mediaWidth.value = image.naturalWidth
  mediaHeight.value = image.naturalHeight
  viewportVersion.value += 1
}

function handleVideoMetadata(event: Event) {
  const video = event.currentTarget as HTMLVideoElement
  mediaWidth.value = video.videoWidth
  mediaHeight.value = video.videoHeight
}

function useFitZoom() {
  zoomMode.value = 'fit'
  panX.value = 0
  panY.value = 0
}

function useZoomPreset(value: number) {
  zoomMode.value = 'custom'
  customZoom.value = clampZoom(value)
  panX.value = 0
  panY.value = 0
}

function handleWheel(event: WheelEvent) {
  if (!currentIsImage.value || !mediaDataUrl.value) return
  event.preventDefault()
  const oldZoom = displayedZoom.value
  const nextZoom = clampZoom(oldZoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
  const bounds = stageElement.value?.getBoundingClientRect()
  if (bounds && oldZoom > 0) {
    const pointerX = event.clientX - bounds.left - bounds.width / 2
    const pointerY = event.clientY - bounds.top - bounds.height / 2
    const ratio = nextZoom / oldZoom
    panX.value = pointerX - (pointerX - panX.value) * ratio
    panY.value = pointerY - (pointerY - panY.value) * ratio
  }
  zoomMode.value = 'custom'
  customZoom.value = nextZoom
}

function beginPan(event: PointerEvent) {
  if (viewerMode.value === 'edit' || !currentIsImage.value || !mediaDataUrl.value || event.button !== 0) return
  event.preventDefault()
  stopPan()
  dragState.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: panX.value,
    originY: panY.value,
  }
  window.addEventListener('pointermove', handlePanMove)
  window.addEventListener('pointerup', endPan)
  window.addEventListener('pointercancel', endPan)
}

function handlePanMove(event: PointerEvent) {
  const drag = dragState.value
  if (!drag || event.pointerId !== drag.pointerId) return
  panX.value = drag.originX + event.clientX - drag.startX
  panY.value = drag.originY + event.clientY - drag.startY
}

function endPan(event: PointerEvent) {
  if (dragState.value && event.pointerId !== dragState.value.pointerId) return
  stopPan()
}

function stopPan() {
  dragState.value = null
  window.removeEventListener('pointermove', handlePanMove)
  window.removeEventListener('pointerup', endPan)
  window.removeEventListener('pointercancel', endPan)
}

function canvasPointFromPointer(event: PointerEvent): CanvasPoint | null {
  const canvas = canvasElement.value
  if (!canvas || !canvas.width || !canvas.height) return null

  const surface = canvas.parentElement
  const offsetElement = event.target === canvas
    ? canvas
    : event.target === surface || event.currentTarget === surface
      ? surface
      : null
  if (offsetElement) {
    const layoutWidth = offsetElement.clientWidth || canvas.width
    const layoutHeight = offsetElement.clientHeight || canvas.height
    if (layoutWidth > 0 && layoutHeight > 0 && Number.isFinite(event.offsetX) && Number.isFinite(event.offsetY)) {
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(event.offsetX * canvas.width / layoutWidth)))
      const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(event.offsetY * canvas.height / layoutHeight)))
      return { x, y }
    }
  }

  const bounds = canvas.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  const x = Math.min(canvas.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width)))
  const y = Math.min(canvas.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)))
  return { x, y }
}

function brushRectAt(point: CanvasPoint): CropSelection {
  const canvas = canvasElement.value
  if (!canvas) return { x: point.x, y: point.y, width: 0, height: 0 }
  const size = Math.min(brushSize.value, canvas.width, canvas.height)
  const half = Math.floor(size / 2)
  return {
    x: Math.max(0, Math.min(canvas.width - size, point.x - half)),
    y: Math.max(0, Math.min(canvas.height - size, point.y - half)),
    width: size,
    height: size,
  }
}

function drawBrushAt(point: CanvasPoint) {
  const context = canvasContext()
  if (!context) return
  const rect = brushRectAt(point)
  context.fillStyle = rgbaCss(replacementTarget.value)
  context.fillRect(rect.x, rect.y, rect.width, rect.height)
}

function drawBetween(from: CanvasPoint, to: CanvasPoint) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
  for (let step = 0; step <= steps; step += 1) {
    const ratio = steps ? step / steps : 0
    drawBrushAt({
      x: Math.round(from.x + (to.x - from.x) * ratio),
      y: Math.round(from.y + (to.y - from.y) * ratio),
    })
  }
}

function pickCanvasColor(point: CanvasPoint, target: 'source' | 'target') {
  const context = canvasContext()
  if (!context) return
  const [red, green, blue, alpha] = context.getImageData(point.x, point.y, 1, 1).data
  const color = { red, green, blue, alpha }
  setReplacementColor(target, color)
  eyedropperActive.value = false
  setStatus(`已取${target === 'source' ? '被替换色' : '替换颜色'} ${rgbaLabel(color)}`)
}

function beginCanvasInteraction(event: PointerEvent) {
  if (viewerMode.value !== 'edit' || (event.button !== 0 && event.button !== 2)) return
  event.preventDefault()
  event.stopPropagation()
  const point = canvasPointFromPointer(event)
  if (!point) return
  brushPreviewPoint.value = point
  if (eyedropperActive.value) {
    pickCanvasColor(point, event.button === 0 ? 'source' : 'target')
    return
  }
  if (event.button !== 0) return
  if (cropMode.value) {
    beginCrop(event, point)
    return
  }
  stopDraw()
  drawBrushAt(point)
  isDirty.value = true
  drawState.value = { pointerId: event.pointerId, ...point }
  const canvas = event.currentTarget as HTMLElement
  if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(event.pointerId)
  window.addEventListener('pointermove', handleDrawMove)
  window.addEventListener('pointerup', endDraw)
  window.addEventListener('pointercancel', endDraw)
}

function handleDrawMove(event: PointerEvent) {
  const draw = drawState.value
  if (!draw || event.pointerId !== draw.pointerId) return
  const point = canvasPointFromPointer(event)
  if (!point) return
  brushPreviewPoint.value = point
  drawBetween(draw, point)
  drawState.value = { pointerId: draw.pointerId, ...point }
  isDirty.value = true
}

function endDraw(event: PointerEvent) {
  if (drawState.value && event.pointerId !== drawState.value.pointerId) return
  if (drawState.value) refreshPalette()
  stopDraw()
}

function stopDraw() {
  drawState.value = null
  window.removeEventListener('pointermove', handleDrawMove)
  window.removeEventListener('pointerup', endDraw)
  window.removeEventListener('pointercancel', endDraw)
}

function updateCanvasHover(event: PointerEvent) {
  if (viewerMode.value !== 'edit') return
  brushPreviewPoint.value = canvasPointFromPointer(event)
}

function clearCanvasHover() {
  if (!drawState.value && !cropState.value) brushPreviewPoint.value = null
}

function cropSelectionFromPoints(start: CanvasPoint, end: CanvasPoint): CropSelection {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return {
    x,
    y,
    width: Math.abs(end.x - start.x) + 1,
    height: Math.abs(end.y - start.y) + 1,
  }
}

function beginCrop(event: PointerEvent, point: CanvasPoint) {
  stopCrop()
  cropSelection.value = { x: point.x, y: point.y, width: 1, height: 1 }
  syncCropInputs()
  cropState.value = { pointerId: event.pointerId, start: point }
  const canvas = event.currentTarget as HTMLElement
  if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(event.pointerId)
  window.addEventListener('pointermove', handleCropMove)
  window.addEventListener('pointerup', endCrop)
  window.addEventListener('pointercancel', endCrop)
}

function handleCropMove(event: PointerEvent) {
  const crop = cropState.value
  if (!crop || event.pointerId !== crop.pointerId) return
  const point = canvasPointFromPointer(event)
  if (!point) return
  cropSelection.value = cropSelectionFromPoints(crop.start, point)
  syncCropInputs()
}

function endCrop(event: PointerEvent) {
  if (cropState.value && event.pointerId !== cropState.value.pointerId) return
  stopCrop()
}

function stopCrop() {
  cropState.value = null
  window.removeEventListener('pointermove', handleCropMove)
  window.removeEventListener('pointerup', endCrop)
  window.removeEventListener('pointercancel', endCrop)
}

async function enterEditMode() {
  if (!canEdit.value) return
  if (canvasReady.value) {
    viewerMode.value = 'edit'
    await nextTick()
    drawAsepriteCheckerboard(canvasElement.value?.width ?? 0, canvasElement.value?.height ?? 0)
    return
  }
  const image = imageElement.value
  if (!image) {
    setStatus('图片尚未加载完成', 'error')
    return
  }
  viewerMode.value = 'edit'
  await nextTick()
  const canvas = canvasElement.value
  const context = canvas?.getContext('2d')
  if (!canvas || !context) {
    viewerMode.value = 'view'
    setStatus('无法创建编辑画布', 'error')
    return
  }
  canvas.width = mediaWidth.value
  canvas.height = mediaHeight.value
  context.imageSmoothingEnabled = false
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  drawAsepriteCheckerboard(canvas.width, canvas.height)
  canvasReady.value = true
  resetCropSelection(canvas.width, canvas.height)
  refreshPalette()
}

function switchToViewMode() {
  viewerMode.value = 'view'
  eyedropperActive.value = false
  cropMode.value = false
  selectionPreviewActive.value = false
  replacementMenuOpen.value = false
  brushPreviewPoint.value = null
  stopDraw()
  stopCrop()
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function updateBrushSize(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const next = positiveInteger(input.value)
  if (next) {
    brushSize.value = next
    return
  }
  input.value = String(brushSize.value)
}

function updateCropInput(axis: 'width' | 'height', event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const canvas = canvasElement.value
  const next = positiveInteger(input.value)
  if (!canvas || !next) return
  const current = cropSelection.value ?? { x: 0, y: 0, width: canvas.width, height: canvas.height }
  const width = axis === 'width' ? Math.min(next, canvas.width) : current.width
  const height = axis === 'height' ? Math.min(next, canvas.height) : current.height
  cropSelection.value = {
    x: Math.min(current.x, canvas.width - width),
    y: Math.min(current.y, canvas.height - height),
    width,
    height,
  }
  syncCropInputs()
}

function applyCrop() {
  const canvas = canvasElement.value
  const selection = cropSelection.value
  if (!canvas || !selection || !selection.width || !selection.height) {
    setStatus('请先选择裁剪区域', 'error')
    return
  }
  if (selection.x === 0 && selection.y === 0 && selection.width === canvas.width && selection.height === canvas.height) return

  const source = document.createElement('canvas')
  source.width = selection.width
  source.height = selection.height
  const sourceContext = source.getContext('2d')
  if (!sourceContext) {
    setStatus('无法裁剪图片', 'error')
    return
  }
  sourceContext.drawImage(
    canvas,
    selection.x,
    selection.y,
    selection.width,
    selection.height,
    0,
    0,
    selection.width,
    selection.height,
  )
  canvas.width = selection.width
  canvas.height = selection.height
  const croppedContext = canvas.getContext('2d')
  if (!croppedContext) {
    setStatus('无法裁剪图片', 'error')
    return
  }
  croppedContext.imageSmoothingEnabled = false
  croppedContext.drawImage(source, 0, 0)
  drawAsepriteCheckerboard(selection.width, selection.height)
  mediaWidth.value = selection.width
  mediaHeight.value = selection.height
  resetCropSelection(selection.width, selection.height)
  refreshPalette()
  viewportVersion.value += 1
  isDirty.value = true
}

function replaceColors() {
  const canvas = canvasElement.value
  const context = canvasContext()
  if (!canvas || !context) return
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  let replaced = 0
  for (let index = 0; index < imageData.data.length; index += 4) {
    const pixel = {
      red: imageData.data[index],
      green: imageData.data[index + 1],
      blue: imageData.data[index + 2],
      alpha: imageData.data[index + 3],
    }
    if (!isWithinReplacementRange(pixel, replacementSource.value)) continue
    imageData.data[index] = replacementTarget.value.red
    imageData.data[index + 1] = replacementTarget.value.green
    imageData.data[index + 2] = replacementTarget.value.blue
    imageData.data[index + 3] = replacementTarget.value.alpha
    replaced += 1
  }
  if (!replaced) {
    setStatus('没有匹配到可替换的像素')
    return
  }
  context.putImageData(imageData, 0, 0)
  refreshPalette()
  isDirty.value = true
  replacementMenuOpen.value = false
  setStatus(`已替换 ${replaced} 个像素`)
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 转换失败'))
    }, 'image/png')
  })
}

function renderedImageSource(): CanvasImageSource | null {
  if (canvasReady.value && canvasElement.value) return canvasElement.value
  return imageElement.value
}

async function copyRenderedMedia() {
  if (copyBusy.value) return
  copyBusy.value = true
  try {
    const source = currentIsImage.value ? renderedImageSource() : videoElement.value
    const width = currentIsImage.value
      ? canvasReady.value ? canvasElement.value?.width ?? 0 : imageElement.value?.naturalWidth ?? 0
      : videoElement.value?.videoWidth ?? 0
    const height = currentIsImage.value
      ? canvasReady.value ? canvasElement.value?.height ?? 0 : imageElement.value?.naturalHeight ?? 0
      : videoElement.value?.videoHeight ?? 0
    if (!source || !width || !height) throw new Error(currentIsVideo.value ? '视频画面尚未加载' : '图片尚未加载')
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前环境不支持复制 PNG 图片')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建图片画布')
    context.drawImage(source, 0, 0, width, height)
    const blob = await canvasToPngBlob(canvas)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    setStatus(currentIsVideo.value ? '已复制当前画面为 PNG' : '已复制图片为 PNG')
  } catch (error) {
    setStatus(`复制${currentIsVideo.value ? '当前画面' : '图片'}失败：${formatError(error)}`, 'error')
  } finally {
    copyBusy.value = false
  }
}

function imageDataUrl(format: 'png' | 'jpeg'): string {
  const canvas = canvasElement.value
  if (!canvas) throw new Error('图片编辑画布尚未加载')
  return format === 'png'
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', 0.92)
}

async function saveCurrentImage(): Promise<boolean> {
  if (!canSaveInPlace.value || saveBusy.value) return false
  saveBusy.value = true
  try {
    const format = extensionFromPath(currentPath.value) === '.png' ? 'png' : 'jpeg'
    await backend.saveImageDataUrl(currentPath.value, imageDataUrl(format))
    isDirty.value = false
    setStatus('已保存修改')
    return true
  } catch (error) {
    setStatus(`保存图片失败：${formatError(error)}`, 'error')
    return false
  } finally {
    saveBusy.value = false
  }
}

async function exportCurrentImage(): Promise<boolean> {
  if (!canvasReady.value || saveBusy.value) return false
  saveBusy.value = true
  try {
    const outputPath = await backend.pickPngExportPath(currentPath.value)
    if (!outputPath) return false
    exportedPath.value = await backend.saveImageDataUrl(outputPath, imageDataUrl('png'))
    isDirty.value = false
    setStatus('已导出 PNG')
    return true
  } catch (error) {
    setStatus(`导出 PNG 失败：${formatError(error)}`, 'error')
    return false
  } finally {
    saveBusy.value = false
  }
}

async function openExportedFileLocation() {
  if (!exportedPath.value) return
  try {
    await backend.openPath(exportedPath.value)
    exportedPath.value = null
  } catch (error) {
    setStatus(`打开文件位置失败：${formatError(error)}`, 'error')
  }
}

function dismissExportNotice() {
  exportedPath.value = null
}

async function answerPendingAction(choice: 'save' | 'discard' | 'cancel') {
  const action = pendingAction.value
  if (!action || saveBusy.value) return
  if (choice === 'cancel') {
    pendingAction.value = null
    return
  }
  if (choice === 'save') {
    const completed = canSaveInPlace.value ? await saveCurrentImage() : await exportCurrentImage()
    if (!completed) return
  } else {
    isDirty.value = false
  }
  pendingAction.value = null
  if (action.kind === 'navigate' && action.path) {
    await loadMedia(action.path)
  } else if (action.kind === 'close') {
    emit('closeApproved')
  }
}

async function copyOriginalFile() {
  if (copyBusy.value) return
  copyBusy.value = true
  try {
    await backend.copyFilesToClipboard([currentPath.value])
    setStatus('已复制原文件')
  } catch (error) {
    setStatus(`复制文件失败：${formatError(error)}`, 'error')
  } finally {
    copyBusy.value = false
  }
}

async function copyFullPath() {
  if (copyBusy.value) return
  copyBusy.value = true
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持复制文本')
    await navigator.clipboard.writeText(currentPath.value)
    setStatus('已复制完整路径')
  } catch (error) {
    setStatus(`复制路径失败：${formatError(error)}`, 'error')
  } finally {
    copyBusy.value = false
  }
}

async function minimizeWindow() {
  if (!isTauri()) return
  try {
    await getCurrentWindow().minimize()
  } catch (error) {
    setStatus(`最小化窗口失败：${formatError(error)}`, 'error')
  }
}

async function toggleFullscreenWindow() {
  if (!isTauri()) return
  try {
    const currentWindow = getCurrentWindow()
    const nextFullscreen = !(await currentWindow.isFullscreen())
    await currentWindow.setFullscreen(nextFullscreen)
    windowFullscreen.value = nextFullscreen
  } catch (error) {
    setStatus(`切换全屏失败：${formatError(error)}`, 'error')
  }
}

async function startWindowDrag(event: PointerEvent) {
  if (event.button !== 0 || !isTauri()) return
  if (event.target instanceof Element && event.target.closest('button, input, label')) return
  try {
    await getCurrentWindow().startDragging()
  } catch (error) {
    setStatus(`移动窗口失败：${formatError(error)}`, 'error')
  }
}

function requestClose() {
  if (pendingAction.value) return
  if (isDirty.value) {
    pendingAction.value = { kind: 'close' }
    return
  }
  emit('closeApproved')
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target
  const acceptsInput = target instanceof Element
    && target.matches('input, textarea, select, [contenteditable="true"]')
  if (!acceptsInput && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    void copyRenderedMedia()
    return
  }
  if (acceptsInput || event.ctrlKey || event.metaKey || event.altKey || pendingAction.value) return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    shiftMedia(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    shiftMedia(1)
  }
}

defineExpose({ requestClose })

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => { viewportVersion.value += 1 })
  if (stageElement.value) resizeObserver?.observe(stageElement.value)
  void configureViewerWindow()
  void Promise.all([loadDirectoryMedia(), loadMedia(currentPath.value)])
})

onBeforeUnmount(() => {
  loadSequence += 1
  window.removeEventListener('keydown', handleKeydown)
  resizeObserver?.disconnect()
  stopPan()
  stopDraw()
  stopCrop()
})
</script>

<template>
  <section
    class="media-viewer"
    :class="{
      'has-color-panel': viewerMode === 'edit' && canvasReady,
      'is-window-fullscreen': windowFullscreen,
    }"
    aria-label="Super High 媒体查看器"
  >
    <header class="media-viewer-titlebar" data-tauri-drag-region @pointerdown="startWindowDrag">
      <div class="media-viewer-title">
        <ImageIcon :size="14" aria-hidden="true" />
        <span class="media-viewer-brand">Super High 查看器</span>
        <span class="media-viewer-file">{{ currentName }}</span>
        <span v-if="isDirty" class="media-viewer-dirty-status">未保存</span>
      </div>
      <div class="media-viewer-window-controls" @pointerdown.stop>
        <button type="button" title="最小化" aria-label="最小化" @click="minimizeWindow">
          <Minus :size="13" />
        </button>
        <button
          type="button"
          :title="windowFullscreen ? '退出全屏' : '全屏'"
          :aria-label="windowFullscreen ? '退出全屏' : '全屏'"
          @click="toggleFullscreenWindow"
        >
          <Minimize2 v-if="windowFullscreen" :size="13" />
          <Maximize2 v-else :size="13" />
        </button>
        <button class="close" type="button" title="关闭" aria-label="关闭" @click="requestClose">
          <X :size="15" />
        </button>
      </div>
    </header>

    <div class="media-viewer-toolbar">
      <div class="media-viewer-tool-group navigation">
        <button type="button" title="上一个媒体（左方向键）" aria-label="上一个媒体" @click="shiftMedia(-1)">
          <ChevronLeft :size="15" />
        </button>
        <span class="media-viewer-position">{{ positionLabel }}</span>
        <button type="button" title="下一个媒体（右方向键）" aria-label="下一个媒体" @click="shiftMedia(1)">
          <ChevronRight :size="15" />
        </button>
      </div>

      <div v-if="currentIsRasterImage" class="media-viewer-tool-group" aria-label="查看模式">
        <button
          type="button"
          title="查看模式"
          aria-label="查看模式"
          :class="{ active: viewerMode === 'view' }"
          @click="switchToViewMode"
        >
          <Eye :size="14" />
        </button>
        <button
          type="button"
          title="编辑模式"
          aria-label="编辑模式"
          :disabled="!canEdit"
          :class="{ active: viewerMode === 'edit' }"
          @click="enterEditMode"
        >
          <Pencil :size="14" />
        </button>
      </div>

      <div v-if="currentIsImage" class="media-viewer-tool-group zoom" aria-label="图片缩放">
        <button
          type="button"
          title="适应窗口"
          :class="{ active: zoomMode === 'fit' }"
          @click="useFitZoom"
        >
          <Scan :size="14" />
          <span>适应</span>
        </button>
        <button
          v-for="preset in ZOOM_PRESETS"
          :key="preset"
          type="button"
          :title="`${preset * 100}%`"
          :aria-label="`${preset * 100}%`"
          :class="{ active: zoomMode === 'custom' && customZoom === preset }"
          @click="useZoomPreset(preset)"
        >
          {{ preset * 100 }}%
        </button>
      </div>

      <div v-if="viewerMode === 'edit' && canvasReady" class="media-viewer-tool-group edit-tools" aria-label="图片编辑工具">
        <input
          class="media-viewer-number-input brush-size"
          :value="brushSize"
          type="number"
          min="1"
          step="1"
          title="画笔像素"
          aria-label="画笔像素"
          @input="updateBrushSize"
        >
        <button
          type="button"
          title="从图片取色：左键取被替换颜色，右键取替换为颜色"
          aria-label="从图片取色"
          :class="{ active: eyedropperActive }"
          @click="eyedropperActive = !eyedropperActive"
        >
          <Pipette :size="14" />
        </button>
      </div>

      <div v-if="viewerMode === 'edit' && canvasReady" class="media-viewer-tool-group crop-tools" aria-label="图片裁剪">
        <button
          type="button"
          title="框选裁剪区域"
          aria-label="框选裁剪区域"
          :class="{ active: cropMode }"
          @click="cropMode = !cropMode; eyedropperActive = false"
        >
          <Crop :size="14" />
        </button>
        <input
          class="media-viewer-number-input dimension"
          :value="cropWidthInput"
          type="number"
          min="1"
          step="1"
          title="裁剪宽度"
          aria-label="裁剪宽度"
          @input="updateCropInput('width', $event)"
        >
        <span class="media-viewer-dimension-separator">×</span>
        <input
          class="media-viewer-number-input dimension"
          :value="cropHeightInput"
          type="number"
          min="1"
          step="1"
          title="裁剪高度"
          aria-label="裁剪高度"
          @input="updateCropInput('height', $event)"
        >
        <button type="button" title="裁剪为选定尺寸" aria-label="裁剪为选定尺寸" @click="applyCrop">
          <Crop :size="14" />
        </button>
      </div>

      <div v-if="viewerMode === 'edit' && canvasReady" class="media-viewer-tool-group save-actions">
        <button
          v-if="canSaveInPlace"
          type="button"
          :disabled="saveBusy"
          title="保存并覆盖原图片"
          aria-label="保存并覆盖原图片"
          @click="saveCurrentImage"
        >
          <Save :size="14" />
        </button>
        <button
          type="button"
          :disabled="saveBusy"
          title="导出 PNG"
          aria-label="导出 PNG"
          @click="exportCurrentImage"
        >
          <Download :size="14" />
        </button>
      </div>

      <div class="media-viewer-tool-group copy-actions">
        <button type="button" :disabled="copyBusy || !mediaDataUrl" :title="currentIsVideo ? '复制当前视频画面为 PNG（Ctrl+C）' : '复制图片为 PNG（Ctrl+C）'" @click="copyRenderedMedia">
          <Copy :size="14" />
          <span>{{ currentIsVideo ? '复制画面' : '复制图片' }}</span>
        </button>
        <button type="button" :disabled="copyBusy" title="复制原文件到 Windows 剪贴板" @click="copyOriginalFile">
          <Files :size="14" />
          <span>复制文件</span>
        </button>
        <button type="button" :disabled="copyBusy" title="复制完整路径" @click="copyFullPath">
          <Clipboard :size="14" />
          <span>复制路径</span>
        </button>
      </div>
    </div>

    <section v-if="viewerMode === 'edit' && canvasReady" class="media-viewer-color-panel" aria-label="图片取色盘">
      <div class="media-viewer-palette" aria-label="当前图片的 RGBA 颜色">
        <article
          v-for="color in paletteColors"
          :key="color.key"
          class="media-viewer-palette-item"
          :class="{
            source: color.key === rgbaKey(replacementSource),
            target: color.key === rgbaKey(replacementTarget),
          }"
        >
          <button
            type="button"
            class="media-viewer-palette-swatch"
            :style="{ background: rgbaCss(color) }"
            :title="`${rgbaLabel(color)}，${color.count} 像素。左键设为被替换颜色，右键设为替换为颜色`"
            :aria-label="rgbaLabel(color)"
            @click="selectPaletteColor(color, 'source')"
            @contextmenu.prevent="selectPaletteColor(color, 'target')"
          />
          <code>{{ rgbaLabel(color) }}</code>
          <span>{{ color.count }}</span>
          <button type="button" class="media-viewer-color-copy" :title="`复制 ${rgbaLabel(color)}`" :aria-label="`复制 ${rgbaLabel(color)}`" @click="copyRgbaColor(color)">
            <Copy :size="13" />
          </button>
        </article>
      </div>
      <div class="media-viewer-replace-row">
        <div class="media-viewer-selected-color source">
          <input
            class="media-viewer-color-input"
            :value="colorInputValue(replacementSource)"
            type="color"
            :title="`被替换颜色：${rgbaLabel(replacementSource)}`"
            aria-label="被替换颜色"
            @input="updateReplacementColor('source', $event)"
          >
          <div>
            <span>被替换</span>
            <code>{{ rgbaLabel(replacementSource) }}</code>
          </div>
          <button type="button" title="复制被替换颜色 RGBA" aria-label="复制被替换颜色 RGBA" @click="copyRgbaColor(replacementSource)">
            <Copy :size="13" />
          </button>
        </div>
        <ArrowRightLeft class="media-viewer-replace-arrow" :size="15" aria-hidden="true" />
        <div class="media-viewer-selected-color target">
          <input
            class="media-viewer-color-input"
            :value="colorInputValue(replacementTarget)"
            type="color"
            :title="`替换为颜色（画笔颜色）：${rgbaLabel(replacementTarget)}`"
            aria-label="替换为颜色"
            @input="updateReplacementColor('target', $event)"
          >
          <div>
            <span>替换为</span>
            <code>{{ rgbaLabel(replacementTarget) }}</code>
          </div>
          <button type="button" title="复制替换为颜色 RGBA" aria-label="复制替换为颜色 RGBA" @click="copyRgbaColor(replacementTarget)">
            <Copy :size="13" />
          </button>
        </div>
        <button
          type="button"
          title="显示选中颜色出现的位置"
          aria-label="显示选中颜色出现的位置"
          :class="{ active: selectionPreviewActive }"
          @click="toggleSelectionPreview"
        >
          <Eye :size="14" />
        </button>
        <div class="media-viewer-replace-action">
          <button type="button" title="替换颜色" aria-label="替换颜色" :class="{ active: replacementMenuOpen }" @click="replacementMenuOpen = !replacementMenuOpen">
            <ArrowRightLeft :size="14" />
            <span>替换</span>
          </button>
          <div v-if="replacementMenuOpen" class="media-viewer-replace-popover" role="dialog" aria-label="颜色替换设置">
            <label class="media-viewer-range-input">
              <span>范围</span>
              <input
                :value="replacementRange"
                type="number"
                min="1"
                max="255"
                step="1"
                title="颜色替换范围（1-255）"
                aria-label="颜色替换范围"
                @input="updateReplacementRange"
              >
            </label>
            <button type="button" @click="replaceColors">
              <ArrowRightLeft :size="14" />
              <span>应用替换</span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <main
      ref="stageElement"
      class="media-viewer-stage"
      :class="{
        pannable: currentIsImage && !!mediaDataUrl && viewerMode === 'view',
        panning: !!dragState,
        editing: viewerMode === 'edit',
      }"
      @wheel="handleWheel"
      @pointerdown="beginPan"
    >
      <button class="media-viewer-side-control previous" type="button" title="上一个媒体" aria-label="上一个媒体" @pointerdown.stop @click="shiftMedia(-1)">
        <ChevronLeft :size="22" />
      </button>
      <button class="media-viewer-side-control next" type="button" title="下一个媒体" aria-label="下一个媒体" @pointerdown.stop @click="shiftMedia(1)">
        <ChevronRight :size="22" />
      </button>

      <div v-if="loading" class="media-viewer-stage-message">正在读取 {{ currentName }}...</div>
      <div v-else-if="loadError" class="media-viewer-stage-message error">{{ loadError }}</div>
      <img
        v-else-if="currentIsImage && mediaDataUrl && !canvasReady && viewerMode === 'view'"
        ref="imageElement"
        :key="currentPath"
        class="media-viewer-image"
        :class="{ raster: currentIsRasterImage }"
        :src="mediaDataUrl"
        :alt="currentName"
        :style="imageStyle"
        v-show="mediaWidth > 0 && mediaHeight > 0"
        draggable="false"
        @load="handleImageLoad"
      >
      <div
        v-else-if="currentIsRasterImage && mediaDataUrl && (viewerMode === 'edit' || canvasReady)"
        class="media-viewer-canvas-wrap"
        :class="{ editing: viewerMode === 'edit', picking: eyedropperActive, cropping: cropMode }"
        :style="imageStyle"
        @pointerdown="beginCanvasInteraction"
        @pointermove="updateCanvasHover"
        @pointerleave="clearCanvasHover"
        @contextmenu.prevent
      >
        <canvas ref="checkerboardElement" class="media-viewer-checkerboard" aria-hidden="true" />
        <canvas ref="canvasElement" class="media-viewer-canvas" />
        <canvas v-if="viewerMode === 'edit' && selectionPreviewActive" ref="selectionOverlayElement" class="media-viewer-selection-overlay" aria-hidden="true" />
        <div
          v-if="viewerMode === 'edit' && cropMode && cropSelectionStyle"
          class="media-viewer-crop-selection"
          :style="cropSelectionStyle"
          aria-hidden="true"
        />
        <div
          v-if="viewerMode === 'edit' && !cropMode && !eyedropperActive && brushPreviewStyle"
          class="media-viewer-brush-preview"
          :style="brushPreviewStyle"
          aria-hidden="true"
        />
      </div>
      <video
        v-else-if="currentIsVideo && mediaDataUrl"
        ref="videoElement"
        :key="currentPath"
        class="media-viewer-video"
        :src="mediaDataUrl"
        controls
        preload="metadata"
        @loadedmetadata="handleVideoMetadata"
        @pointerdown.stop
      />

      <aside v-if="exportedPath" class="media-viewer-export-notice" role="status" @pointerdown.stop>
        <span>已导出，立即打开所在位置？</span>
        <div class="media-viewer-export-actions">
          <button type="button" title="打开位置" @click="openExportedFileLocation">
            <FolderOpen :size="13" />
            <span>打开位置</span>
          </button>
          <button type="button" title="稍后" @click="dismissExportNotice">稍后</button>
        </div>
      </aside>
      <div v-if="statusMessage" class="media-viewer-action-status" :class="statusTone" role="status">
        {{ statusMessage }}
      </div>
    </main>

    <div v-if="pendingAction" class="media-viewer-confirm-backdrop" role="presentation">
      <section class="media-viewer-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="media-viewer-confirm-title">
        <header class="media-viewer-confirm-titlebar">
          <span id="media-viewer-confirm-title">保存修改</span>
          <button type="button" title="取消" aria-label="取消" :disabled="saveBusy" @click="answerPendingAction('cancel')">
            <X :size="14" />
          </button>
        </header>
        <p>{{ pendingMessage }}</p>
        <div class="media-viewer-confirm-actions">
          <button type="button" class="primary" :disabled="saveBusy" @click="answerPendingAction('save')">
            <Save v-if="canSaveInPlace" :size="13" />
            <Download v-else :size="13" />
            <span>{{ pendingSaveLabel }}</span>
          </button>
          <button type="button" :disabled="saveBusy" @click="answerPendingAction('discard')">
            <X :size="13" />
            <span>不保存</span>
          </button>
          <button type="button" :disabled="saveBusy" @click="answerPendingAction('cancel')">
            <X :size="13" />
            <span>取消</span>
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.media-viewer {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: 34px auto minmax(0, 1fr);
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  user-select: none;
}

.media-viewer.has-color-panel {
  grid-template-rows: 34px auto auto minmax(0, 1fr);
}

.media-viewer-titlebar {
  min-width: 0;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  -webkit-app-region: drag;
  cursor: move;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.media-viewer-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  font-size: 12px;
}

.media-viewer-title > svg {
  flex: 0 0 auto;
  color: var(--color-accent-blue);
}

.media-viewer-brand {
  flex: 0 0 auto;
  font-weight: 600;
}

.media-viewer-file {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-viewer-dirty-status {
  flex: 0 0 auto;
  color: var(--color-accent-red);
  font-size: 11px;
  white-space: nowrap;
}

.media-viewer-window-controls {
  flex: 0 0 auto;
  display: flex;
}

.media-viewer-window-controls button {
  width: 42px;
  height: 33px;
  display: grid;
  place-items: center;
  border: 0;
  border-left: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-secondary);
  -webkit-app-region: no-drag;
  box-shadow: none;
}

.media-viewer-window-controls button:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.media-viewer-window-controls button.close:hover {
  background: var(--surface-danger-soft);
  color: var(--color-accent-red);
}

.media-viewer-toolbar {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 5px 8px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  scrollbar-width: thin;
}

.media-viewer-tool-group {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 3px;
}

.media-viewer-tool-group + .media-viewer-tool-group {
  padding-left: 8px;
  border-left: 1px solid var(--color-border);
}

.media-viewer-tool-group.copy-actions {
  margin-left: auto;
}

.media-viewer-toolbar button {
  height: 28px;
  min-width: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  box-shadow: none;
}

.media-viewer-toolbar button:hover:not(:disabled),
.media-viewer-toolbar button.active {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
  color: var(--color-text-primary);
}

.media-viewer-toolbar button:disabled {
  opacity: 0.45;
}

.media-viewer-tool-group.navigation button {
  padding: 0;
}

.media-viewer-position {
  min-width: 48px;
  color: var(--color-text-secondary);
  font-size: 11px;
  text-align: center;
}

.media-viewer-color-input {
  width: 28px;
  height: 28px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  cursor: pointer;
}

.media-viewer-number-input {
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-input-bg);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  text-align: center;
}

.media-viewer-number-input.brush-size {
  width: 48px;
}

.media-viewer-number-input.dimension {
  width: 56px;
}

.media-viewer-dimension-separator {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.media-viewer-color-panel {
  min-width: 0;
  display: grid;
  grid-template-rows: minmax(146px, 184px) 34px;
  gap: 5px;
  padding: 7px 8px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.media-viewer-palette {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  grid-auto-rows: 32px;
  align-content: start;
  gap: 4px;
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.media-viewer-palette-item {
  min-width: 0;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto 26px;
  align-items: center;
  gap: 6px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-secondary);
}

.media-viewer-palette-item.source {
  border-color: var(--surface-accent-blue-border);
}

.media-viewer-palette-item.target {
  box-shadow: inset -2px 0 0 var(--color-accent-green);
}

.media-viewer-palette-swatch {
  width: 28px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 2px;
  box-shadow: none;
}

.media-viewer-palette-swatch:hover,
.media-viewer-palette-swatch:focus-visible {
  border-color: var(--color-text-primary);
  outline: none;
}

.media-viewer-palette-item code,
.media-viewer-selected-color code {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-viewer-palette-item > span {
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.media-viewer-palette-item > button,
.media-viewer-selected-color > button {
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-secondary);
  box-shadow: none;
}

.media-viewer-palette-item > button:not(.media-viewer-palette-swatch):hover,
.media-viewer-selected-color > button:hover {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
  color: var(--color-text-primary);
}

.media-viewer-replace-row {
  position: relative;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 5px;
}

.media-viewer-selected-color {
  min-width: 0;
  height: 34px;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 26px;
  align-items: center;
  gap: 5px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
}

.media-viewer-selected-color.source {
  border-color: var(--surface-accent-blue-border);
}

.media-viewer-selected-color.target {
  border-color: var(--surface-success-border);
}

.media-viewer-selected-color > div {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.media-viewer-selected-color > div > span {
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 1;
}

.media-viewer-replace-arrow {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
}

.media-viewer-replace-action {
  position: relative;
  margin-left: auto;
}

.media-viewer-replace-action > button {
  height: 34px;
}

.media-viewer-replace-popover {
  position: absolute;
  z-index: 4;
  right: 0;
  bottom: calc(100% + 5px);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--surface-panel-strong);
}

.media-viewer-replace-popover > button {
  height: 28px;
}

.media-viewer-range-input {
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.media-viewer-range-input input {
  width: 48px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: center;
}

.media-viewer-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--color-bg-tertiary);
  touch-action: none;
}

.media-viewer-stage.pannable {
  cursor: grab;
}

.media-viewer-stage.panning {
  cursor: grabbing;
}

.media-viewer-stage.editing {
  cursor: crosshair;
}

.media-viewer-image,
.media-viewer-canvas-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  display: block;
  max-width: none;
  max-height: none;
  transform-origin: center;
  image-rendering: pixelated;
  will-change: transform;
}

.media-viewer-image {
  pointer-events: none;
}

.media-viewer-canvas {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: block;
  image-rendering: pixelated;
  pointer-events: auto;
}

.media-viewer-canvas-wrap.editing {
  cursor: crosshair;
}

.media-viewer-checkerboard {
  position: absolute;
  z-index: 0;
  inset: 0;
  width: 100%;
  height: 100%;
  display: none;
  image-rendering: pixelated;
  pointer-events: none;
}

.media-viewer-canvas-wrap.editing .media-viewer-checkerboard {
  display: block;
}

.media-viewer-canvas-wrap.picking {
  cursor: copy;
}

.media-viewer-canvas-wrap.cropping {
  cursor: crosshair;
}

.media-viewer-selection-overlay,
.media-viewer-crop-selection,
.media-viewer-brush-preview {
  position: absolute;
  pointer-events: none;
}

.media-viewer-selection-overlay {
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}

.media-viewer-crop-selection {
  z-index: 3;
  box-sizing: border-box;
  border: 1px solid var(--color-accent-blue);
  background: var(--surface-accent-blue-fade);
}

.media-viewer-brush-preview {
  z-index: 4;
  box-sizing: border-box;
  border: 1px solid var(--color-text-primary);
  opacity: 0.65;
}

.media-viewer-video {
  width: auto;
  height: auto;
  max-width: calc(100% - 96px);
  max-height: calc(100% - 48px);
  background: var(--color-bg-primary);
  outline: none;
  box-shadow: none;
}

.media-viewer-video:fullscreen {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  object-fit: contain;
  background: var(--color-bg-primary);
}

.media-viewer.is-window-fullscreen .media-viewer-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  max-width: none;
  max-height: none;
  object-fit: cover;
}

.media-viewer-stage-message {
  max-width: min(560px, calc(100% - 120px));
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.media-viewer-stage-message.error {
  color: var(--color-accent-red);
}

.media-viewer-side-control {
  position: absolute;
  z-index: 2;
  top: 50%;
  width: 34px;
  height: 52px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--surface-panel-strong);
  color: var(--color-text-secondary);
  transform: translateY(-50%);
  box-shadow: none;
}

.media-viewer-side-control:hover {
  border-color: var(--surface-accent-blue-border);
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.media-viewer-side-control.previous {
  left: 12px;
}

.media-viewer-side-control.next {
  right: 12px;
}

.media-viewer-export-notice {
  position: absolute;
  z-index: 3;
  right: 14px;
  bottom: 14px;
  width: min(310px, calc(100% - 28px));
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--surface-success-border);
  border-radius: 4px;
  background: var(--surface-panel-strong);
  color: var(--color-text-primary);
  font-size: 12px;
}

.media-viewer-export-actions {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
}

.media-viewer-export-actions button,
.media-viewer-confirm-actions button,
.media-viewer-confirm-titlebar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  box-shadow: none;
}

.media-viewer-export-actions button:hover,
.media-viewer-confirm-actions button:hover:not(:disabled),
.media-viewer-confirm-titlebar button:hover:not(:disabled) {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
  color: var(--color-text-primary);
}

.media-viewer-action-status {
  position: absolute;
  z-index: 3;
  top: 12px;
  right: 12px;
  max-width: min(520px, calc(100% - 24px));
  padding: 6px 8px;
  border: 1px solid var(--surface-success-border);
  border-radius: 4px;
  background: var(--surface-panel-strong);
  color: var(--color-accent-green);
  font-size: 11px;
}

.media-viewer-action-status.error {
  border-color: var(--surface-danger-border);
  color: var(--color-accent-red);
}

.media-viewer-confirm-backdrop {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: var(--surface-overlay);
}

.media-viewer-confirm-dialog {
  width: min(390px, 100%);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--surface-dialog);
}

.media-viewer-confirm-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 7px 0 10px;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  font-weight: 600;
}

.media-viewer-confirm-titlebar button {
  width: 26px;
  min-height: 26px;
  padding: 0;
}

.media-viewer-confirm-dialog p {
  margin: 0;
  padding: 16px 12px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.media-viewer-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding: 0 10px 10px;
}

.media-viewer-confirm-actions button.primary {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
  color: var(--color-text-primary);
}

.media-viewer-confirm-actions button:disabled,
.media-viewer-confirm-titlebar button:disabled {
  opacity: 0.45;
}

@media (max-width: 720px) {
  .media-viewer-brand,
  .media-viewer-tool-group.copy-actions span {
    display: none;
  }

  .media-viewer-tool-group.copy-actions {
    margin-left: 0;
  }

  .media-viewer-toolbar button {
    padding: 0 6px;
  }
}
</style>
