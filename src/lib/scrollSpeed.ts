import { onBeforeUnmount, onMounted } from 'vue'

export const SCROLL_SPEED_STEPS = [100, 125, 150, 175, 200, 225, 250] as const

export function normalizeScrollSpeed(value: unknown): number {
  return typeof value === 'number' && SCROLL_SPEED_STEPS.some(step => step === value) ? value : 100
}

export function scrollSpeedMultiplier(value: unknown): number {
  return normalizeScrollSpeed(value) / 100
}

export function useNativeScrollSpeed(readPercent: () => number): void {
  let dispose: (() => void) | undefined
  onMounted(() => { dispose = installNativeScrollSpeed(readPercent) })
  onBeforeUnmount(() => dispose?.())
}

/** Native scroll containers only. Monaco and xterm apply the multiplier themselves. */
export function installNativeScrollSpeed(readPercent: () => number, root: Document = document): () => void {
  const handleWheel = (event: WheelEvent) => {
    const multiplier = scrollSpeedMultiplier(readPercent())
    if (multiplier === 1 || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey) return
    const target = event.target instanceof Element ? event.target : null
    if (!target || target.closest('.monaco-editor, .xterm, .editor-tabs-list, .document-image-stage, .file-manager-media-stage, .memo-image-stage, .image-preview-stage, .media-viewer-stage')) return
    let deltaX = event.deltaX
    let deltaY = event.deltaY
    if (event.shiftKey && !deltaX) { deltaX = deltaY; deltaY = 0 }
    const findScroller = (delta: number, horizontal: boolean): HTMLElement | null => {
      if (!delta) return null
      for (let node: Element | null = target; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        const style = getComputedStyle(node)
        const overflow = horizontal ? style.overflowX : style.overflowY
        if (!/^(auto|scroll|overlay)$/.test(overflow)) continue
        const max = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight
        const position = horizontal ? node.scrollLeft : node.scrollTop
        if (max > 0 && (delta < 0 ? position > 0 : position < max)) return node
        if ((horizontal ? style.overscrollBehaviorX : style.overscrollBehaviorY).match(/contain|none/)) return node
      }
      return null
    }
    const x = findScroller(deltaX, true)
    const y = findScroller(deltaY, false)
    if (!x && !y) return
    event.preventDefault()
    const pixels = (node: HTMLElement, horizontal: boolean) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return horizontal ? node.clientWidth : node.clientHeight
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return parseFloat(getComputedStyle(node).lineHeight) || 16
      return 1
    }
    if (x) x.scrollLeft += deltaX * pixels(x, true) * multiplier
    if (y) y.scrollTop += deltaY * pixels(y, false) * multiplier
  }
  root.addEventListener('wheel', handleWheel, { capture: true, passive: false })
  return () => root.removeEventListener('wheel', handleWheel, true)
}

