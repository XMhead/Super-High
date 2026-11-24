export interface NativeVideoRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeVideoBounds extends NativeVideoRect {
  scale: number
  visible: boolean
  occlusions: NativeVideoRect[]
}

export function nativeVideoOcclusions(surface: HTMLElement, rect: DOMRect): NativeVideoRect[] {
  const blockers = new Set<Element>()
  for (const x of [rect.left + 1, rect.left + rect.width / 2, rect.right - 1]) {
    for (const y of [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1]) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || surface.contains(hit)) continue
      if (hit.contains(surface)) return [{ x: 0, y: 0, width: rect.width, height: rect.height }]
      let element: Element = hit
      let area = element.getBoundingClientRect()
      while (element.parentElement && !element.parentElement.contains(surface)) {
        const parent: HTMLElement = element.parentElement
        const outer = parent.getBoundingClientRect()
        if (outer.left > area.left || outer.top > area.top || outer.right < area.right || outer.bottom < area.bottom) break
        element = parent
        area = outer
      }
      blockers.add(element)
    }
  }
  return [...blockers].flatMap(element => {
    const area = element.getBoundingClientRect()
    const left = Math.max(rect.left, area.left)
    const top = Math.max(rect.top, area.top)
    const right = Math.min(rect.right, area.right)
    const bottom = Math.min(rect.bottom, area.bottom)
    return right > left && bottom > top
      ? [{ x: left - rect.left, y: top - rect.top, width: right - left, height: bottom - top }]
      : []
  })
}

export interface NativeVideoStatus {
  position: number
  duration: number
  paused: boolean
  ended: boolean
  width: number
  height: number
  ready: boolean
  volume: number
}

export type NativeVideoAction =
  | { type: 'open'; path: string; bounds: NativeVideoBounds }
  | { type: 'bounds'; bounds: NativeVideoBounds }
  | { type: 'status' }
  | { type: 'pause'; paused: boolean }
  | { type: 'seek'; seconds: number }
  | { type: 'volume'; volume: number }
  | { type: 'screenshot' }
  | { type: 'close' }
