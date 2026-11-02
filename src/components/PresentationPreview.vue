<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PptxViewer } from '@aiden0z/pptx-renderer'
import { backend } from '@/lib/tauri'
import { matchPresentationShapes, parsePresentationAnimations, PresentationAnimationPlayer,
  type PresentationAnimationState } from '@/lib/presentationAnimations'
import FileOpenActions from './FileOpenActions.vue'

const props = defineProps<{ path: string; content: string }>()
const host = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const loading = ref(true)
const rendering = ref(false)
const error = ref('')
const incompleteObjects = ref(0)
const totalPages = ref(0)
const pageNumber = ref(1)
const pageInput = ref('1')
const zoom = ref('fit')
const expanded = ref(false)
const animationEnabled = ref(true)
const animationState = ref<PresentationAnimationState>({ step: 0, total: 0, playing: false, paused: false, unsupported: 0 })
const hasNextStep = computed(() => animationState.value.step < animationState.value.total)
let animationPlayer: PresentationAnimationPlayer | null = null
let slideElement: HTMLElement | null = null
let slideSources = new Map<string, string>()
let viewer: PptxViewer | null = null
let controller: AbortController | null = null
let generation = 0

function disposeViewer() {
  animationPlayer?.dispose()
  animationPlayer = null
  slideElement = null
  slideSources.clear()
  controller?.abort()
  controller = null
  viewer?.destroy()
  viewer = null
}

async function loadPresentation() {
  const current = ++generation
  disposeViewer()
  loading.value = true
  rendering.value = false
  error.value = ''
  incompleteObjects.value = 0
  animationState.value = { step: 0, total: 0, playing: false, paused: false, unsupported: 0 }
  totalPages.value = 0
  pageNumber.value = 1
  pageInput.value = '1'
  zoom.value = 'fit'
  try {
    const bytes = Uint8Array.from(atob(props.content), character => character.charCodeAt(0))
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
      throw new Error('这是旧版二进制 PPT（或加密的 PowerPoint 文件）。内置预览支持未加密的 .pptx，请先将旧格式另存为 .pptx。')
    }
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS, parseZipLazyMedia, buildPresentation } = await import('@aiden0z/pptx-renderer')
    if (current !== generation || !host.value) return
    const shadow = host.value.shadowRoot ?? host.value.attachShadow({ mode: 'open' })
    const styles = document.createElement('style')
    styles.textContent = ':host { display: block; min-width: 0; font-family: var(--font-content); font-weight: var(--font-content-weight); color-scheme: light; }'
    const content = document.createElement('div')
    shadow.replaceChildren(styles, content)
    shadow.addEventListener('click', handleLink, { capture: true })
    const localController = new AbortController()
    controller = localController
    const local = new PptxViewer(content, {
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      externalMedia: 'block',
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
      onSlideChange(index) {
        if (current !== generation) return
        pageNumber.value = index + 1
        pageInput.value = String(index + 1)
      },
      onRenderStart() {
        if (current !== generation) return
        rendering.value = true
        incompleteObjects.value = 0
      },
      onRenderComplete() { if (current === generation) rendering.value = false },
      onSlideRendered(_index, element) {
        if (current !== generation) return
        animationPlayer?.dispose()
        animationPlayer = null
        slideElement = element
        prepareAnimations()
      },
      onSlideError() { if (current === generation) error.value = '此页渲染失败，可以尝试翻到其他页。' },
      onNodeError() { if (current === generation) incompleteObjects.value++ },
    })
    viewer = local
    const files = await parseZipLazyMedia(bytes.buffer, RECOMMENDED_ZIP_LIMITS)
    if (current !== generation || localController.signal.aborted) return
    slideSources = files.slides
    local.load(buildPresentation(files, { lazySlides: true }))
    totalPages.value = local.slideCount
    if (!totalPages.value) throw new Error('文件中没有可显示的幻灯片。')
    await local.renderSlide(0)
  } catch (cause) {
    if (current === generation) {
      error.value = `无法预览此演示文稿。${cause instanceof Error ? ` ${cause.message}` : ''}`
      disposeViewer()
    }
  } finally {
    if (current === generation) loading.value = rendering.value = false
  }
}

function prepareAnimations() {
  animationPlayer?.dispose()
  animationPlayer = null
  const local = viewer
  const slide = local?.presentationData?.slides[local.currentSlideIndex]
  animationState.value = { step: 0, total: 0, playing: false, paused: false, unsupported: 0 }
  if (!animationEnabled.value || !local || !slideElement || !slide) return
  const plan = parsePresentationAnimations(slideSources.get(slide.slidePath) ?? '')
  const current = generation
  animationPlayer = new PresentationAnimationPlayer(slideElement, matchPresentationShapes(slideElement, slide.nodes), plan,
    local.slideWidth, local.slideHeight, state => { if (current === generation) animationState.value = state })
  animationPlayer.startEntry()
}

function advance() {
  if (loading.value || rendering.value) return
  if (animationEnabled.value && (hasNextStep.value || animationState.value.playing || animationState.value.paused)) animationPlayer?.next()
  else if (pageNumber.value < totalPages.value) void goToPage(pageNumber.value + 1)
}

function playAnimations() {
  if (animationState.value.playing) animationPlayer?.pause()
  else animationPlayer?.play()
}

function replayAnimations() { animationPlayer?.reset(); animationPlayer?.startEntry(); animationPlayer?.play() }

async function goToPage(number: number) {
  const local = viewer
  if (!local || loading.value || rendering.value || !totalPages.value) return
  const index = Math.max(0, Math.min(totalPages.value - 1, Math.trunc(number) - 1))
  if (index === local.currentSlideIndex) { pageInput.value = String(index + 1); return }
  error.value = ''
  try {
    await local.goToSlide(index)
    if (local !== viewer) return
    pageNumber.value = index + 1
    pageInput.value = String(index + 1)
    if (stage.value) stage.value.scrollTop = stage.value.scrollLeft = 0
  } catch (cause) {
    if (local === viewer) error.value = `此页渲染失败。${cause instanceof Error ? cause.message : ''}`
  }
}

function jumpToPage() {
  const number = Number(pageInput.value)
  if (Number.isFinite(number)) void goToPage(number)
  else pageInput.value = String(pageNumber.value)
}

async function updateZoom() {
  const local = viewer
  if (!local || loading.value) return
  try {
    await local.setFitMode(zoom.value === 'fit' ? 'contain' : 'none')
    if (local === viewer) await local.setZoom(zoom.value === 'fit' ? 100 : Number(zoom.value))
  } catch (cause) {
    if (local === viewer) error.value = `缩放失败。${cause instanceof Error ? cause.message : ''}`
  }
}

function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { expanded.value = false; return }
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  if (event.composedPath().some(target => target instanceof HTMLElement && (target.matches('input, select, textarea, audio, video') || target.isContentEditable))) return
  if (event.key === ' ' && event.composedPath().some(target => target instanceof HTMLButtonElement)) return
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); advance(); return }
  const number = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key) ? pageNumber.value - 1
      : event.key === 'Home' ? 1 : event.key === 'End' ? totalPages.value : null
  if (number != null) { event.preventDefault(); void goToPage(number) }
}

function handleStageClick(event: MouseEvent) {
  if (event.composedPath().some(target => target instanceof HTMLElement && target.matches('a, button, input, audio, video'))) return
  stage.value?.focus({ preventScroll: true })
  if (animationEnabled.value && (hasNextStep.value || expanded.value)) advance()
}

function handleLink(event: Event) {
  const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  if (!anchor) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) {
    void backend.openUrl(href).catch(() => { error.value = '无法打开演示文稿中的链接。' })
  }
}

watch(() => [props.path, props.content], loadPresentation)
watch(zoom, updateZoom)
watch(animationEnabled, prepareAnimations)
onMounted(loadPresentation)
onBeforeUnmount(() => { generation++; disposeViewer() })
</script>

<template>
  <section class="presentation-preview" :class="{ 'presentation-expanded': expanded }" aria-label="PowerPoint 预览"
    :aria-busy="loading || rendering" @keydown="handleKey">
    <div class="presentation-toolbar">
      <span>PowerPoint · 只读</span>
      <button type="button" :aria-pressed="expanded" @click="expanded = !expanded">{{ expanded ? '收起阅读' : '展开阅读' }}</button>
      <button type="button" :disabled="pageNumber <= 1 || loading || rendering || !totalPages" @click="goToPage(pageNumber - 1)">上一页</button>
      <form class="presentation-page-input" @submit.prevent="jumpToPage">
        <input v-model="pageInput" inputmode="numeric" aria-label="幻灯片页码" :disabled="loading || rendering || !totalPages" @change="jumpToPage" />
        <span>/ {{ totalPages }}</span>
      </form>
      <button type="button" :disabled="pageNumber >= totalPages || loading || rendering" @click="goToPage(pageNumber + 1)">下一页</button>
      <select v-model="zoom" aria-label="幻灯片缩放" :disabled="loading || rendering || !totalPages">
        <option value="fit">适应宽度</option>
        <option value="50">50%</option><option value="100">100%</option>
        <option value="150">150%</option><option value="200">200%</option><option value="400">400%</option>
      </select>
      <button type="button" :aria-pressed="animationEnabled" @click="animationEnabled = !animationEnabled">动画{{ animationEnabled ? '开' : '关' }}</button>
      <button type="button" :disabled="loading || rendering || !animationEnabled || !animationState.total || (!hasNextStep && !animationState.playing && !animationState.paused)" @click="playAnimations">{{ animationState.playing ? '暂停' : animationState.paused ? '继续播放' : '播放本页' }}</button>
      <button type="button" :disabled="loading || rendering || !animationEnabled || !hasNextStep" @click="advance">下一步</button>
      <button type="button" :disabled="loading || rendering || !animationEnabled || !animationState.total" @click="replayAnimations">重播</button>
      <span v-if="animationEnabled && animationState.total">动画 {{ animationState.step }}/{{ animationState.total }}</span>
    </div>
    <div v-if="error" class="presentation-message" role="alert">{{ error }}<FileOpenActions :path="path" /></div>
    <div v-if="incompleteObjects" class="presentation-message" role="status">此页有 {{ incompleteObjects }} 个对象未能完整显示。</div>
    <div v-if="animationEnabled && animationState.unsupported" class="presentation-message" role="status">此页有 {{ animationState.unsupported }} 个动画或切换效果暂不兼容，相关内容按静态方式显示。</div>
    <div ref="stage" class="presentation-stage" tabindex="0" aria-label="幻灯片，点击或空格播放下一步，方向键翻页" @click="handleStageClick">
      <div v-if="loading" class="presentation-message" role="status">正在解析演示文稿…</div>
      <div v-else-if="rendering" class="presentation-message" role="status">正在渲染…</div>
      <div ref="host" class="presentation-host" />
    </div>
  </section>
</template>

<style scoped>
.presentation-preview { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; background: var(--color-bg-primary); }
.presentation-preview.presentation-expanded { position: fixed; inset: 40px 8px 8px; z-index: 2000; height: auto; border: 1px solid var(--color-border); }
.presentation-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; min-height: 36px; padding: 4px 8px; overflow-x: auto; white-space: nowrap; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); color: var(--color-text-secondary); font-size: 12px; }
.presentation-toolbar button, .presentation-toolbar select, .presentation-toolbar input { flex-shrink: 0; height: 26px; padding: 2px 7px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-input-bg); color: var(--color-text-primary); font: inherit; box-shadow: none; }
.presentation-toolbar button { cursor: pointer; }
.presentation-toolbar button:hover { border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.presentation-toolbar :disabled { opacity: .45; cursor: default; }
.presentation-page-input { display: flex; align-items: center; gap: 5px; }
.presentation-page-input input { width: 46px; text-align: center; }
.presentation-stage { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.presentation-host { min-width: 0; }
.presentation-message { padding: 10px 12px; color: var(--color-text-secondary); font: inherit; font-size: 12px; }
</style>
