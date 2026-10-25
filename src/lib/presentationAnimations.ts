export type PresentationEffect = {
  target: string
  kind: 'appear' | 'fade' | 'fly' | 'wipe' | 'zoom' | 'spin' | 'motion'
  mode: 'entrance' | 'exit' | 'emphasis'
  duration: number
  delay: number
  direction: string
  amount?: number
  scale?: [number, number]
  path?: string
  reverse: boolean
  iterations: number
}
export type PresentationAnimationPlan = {
  groups: { automatic: boolean; effects: PresentationEffect[] }[]
  transition?: { kind: 'fade' | 'push' | 'wipe'; duration: number; direction: string }
  unsupported: number
}
export type PresentationAnimationState = { step: number; total: number; playing: boolean; paused: boolean; unsupported: number }
export type AnimationShape = { id: string; hidden?: boolean; position: { x: number; y: number }; size: { w: number; h: number } }

const elements = (node: ParentNode, name: string) => Array.from(node.querySelectorAll('*')).filter(item => item.localName === name)
const child = (node: Element, name: string) => Array.from(node.children).find(item => item.localName === name)
const milliseconds = (value: string | null | undefined, fallback = 0) => value != null && /^\d+(\.\d+)?$/.test(value) ? Math.min(60_000, Number(value)) : fallback

/** Read the authored timing tree, keeping click groups and their with/after delays. */
export function parsePresentationAnimations(xml: string): PresentationAnimationPlan {
  const plan: PresentationAnimationPlan = { groups: [], unsupported: 0 }
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.querySelector('parsererror')) return plan
  let previousStart = 0
  let previousEnd = 0
  const timing = elements(document, 'timing')[0]
  if (timing) for (const node of elements(timing, 'cTn')) {
    const trigger = node.getAttribute('nodeType')
    if (!['clickEffect', 'withEffect', 'afterEffect'].includes(trigger ?? '')) continue
    if (trigger === 'clickEffect' || !plan.groups.length) {
      plan.groups.push({ automatic: trigger !== 'clickEffect', effects: [] })
      previousStart = previousEnd = 0
    }
    const behaviors = elements(node, 'cBhvr')
    const target = behaviors.flatMap(behavior => elements(behavior, 'spTgt'))[0]
    // Interactive triggers and text-run builds need their own targeting model.
    let ancestor = node.parentElement
    let interactive = false
    while (ancestor && ancestor !== timing) {
      if (ancestor.getAttribute('nodeType') === 'interactiveSeq') interactive = true
      ancestor = ancestor.parentElement
    }
    if (!target || target.children.length || interactive) { plan.unsupported++; continue }
    const targetId = target.getAttribute('spid')
    if (!targetId) { plan.unsupported++; continue }
    const preset = node.getAttribute('presetID')
    const presetClass = node.getAttribute('presetClass')
    const filterNode = elements(node, 'animEffect')[0]
    const filter = filterNode?.getAttribute('filter')?.toLowerCase() ?? ''
    const motion = elements(node, 'animMotion')[0]
    const rotation = elements(node, 'animRot')[0]
    const scaling = elements(node, 'animScale')[0]
    const mode = presetClass === 'exit' || filterNode?.getAttribute('transition') === 'out' ? 'exit'
      : presetClass === 'emph' || motion || rotation ? 'emphasis' : 'entrance'
    const kind: PresentationEffect['kind'] | undefined = motion ? 'motion' : rotation ? 'spin'
      : filter.startsWith('fade') || !filter && preset === '10' && presetClass !== 'emph' ? 'fade'
        : filter.startsWith('wipe') || !filter && preset === '22' ? 'wipe'
          : preset === '2' ? 'fly' : scaling || preset === '23' ? 'zoom'
            : preset === '1' || !filter && behaviors.length === 1 && behaviors[0].parentElement?.localName === 'set' ? 'appear' : undefined
    const path = motion?.getAttribute('path')?.replace(/\s*E\s*$/i, '').trim()
    // Bound and validate the SVG subset before handing it to the browser path API.
    if (!kind || kind === 'motion' && (!path || path.length > 8192 || /[^MLCQHVZmlcqhvz0-9eE.,+\s-]/.test(path)
      || motion?.getAttribute('origin') === 'parent')) { plan.unsupported++; continue }
    const numericDurations = behaviors.map(behavior => milliseconds(child(behavior, 'cTn')?.getAttribute('dur')))
    const durations = [...numericDurations, milliseconds(node.getAttribute('dur'))].filter(value => value > 0)
    const duration = kind === 'appear' ? 1 : durations.length ? Math.max(...durations) : 500
    const ownDelay = milliseconds(child(node, 'stCondLst')?.firstElementChild?.getAttribute('delay'))
    const delay = (trigger === 'afterEffect' ? previousEnd : trigger === 'withEffect' ? previousStart : 0) + ownDelay
    const reverse = node.getAttribute('autoRev') === '1' || node.getAttribute('autoRev') === 'true'
    const repeats = Number(node.getAttribute('repeatCount') ?? 1000) / 1000
    const iterations = Math.max(1, Math.min(20, Number.isFinite(repeats) ? repeats : 1)) * (reverse ? 2 : 1)
    const effect: PresentationEffect = {
      target: targetId, kind, mode, duration, delay, reverse, iterations,
      direction: filter.match(/\(([^)]+)\)/)?.[1] ?? node.getAttribute('presetSubtype') ?? '8',
    }
    if (path) effect.path = path
    if (rotation) effect.amount = Number(rotation.getAttribute('by') ?? rotation.getAttribute('to') ?? 21_600_000) / 60_000
    const scale = scaling && (child(scaling, 'by') ?? child(scaling, 'to'))
    if (scale) effect.scale = [Number(scale.getAttribute('x') ?? 100000) / 100000, Number(scale.getAttribute('y') ?? 100000) / 100000]
    plan.groups.at(-1)!.effects.push(effect)
    previousStart = delay
    previousEnd = delay + duration * iterations
  }
  const transition = elements(document, 'transition')[0]
  if (transition) {
    const type = Array.from(transition.children).find(item => !['sndAc', 'extLst'].includes(item.localName))
    if (type && ['fade', 'push', 'wipe'].includes(type.localName)) {
      const durationAttribute = Array.from(transition.attributes).find(attribute => attribute.localName === 'dur')?.value
      plan.transition = { kind: type.localName as 'fade' | 'push' | 'wipe', direction: type.getAttribute('dir') ?? 'r',
        duration: milliseconds(durationAttribute, transition.getAttribute('spd') === 'slow' ? 1000 : transition.getAttribute('spd') === 'fast' ? 350 : 700) }
    } else if (type && type.localName !== 'cut') plan.unsupported++
  }
  return plan
}

/** Match the renderer's top-level slide objects by geometry, without changing the original file. */
export function matchPresentationShapes(root: HTMLElement, nodes: readonly AnimationShape[]): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>()
  const available = Array.from(root.children).filter((element): element is HTMLElement => element instanceof HTMLElement)
  for (const node of [...nodes].reverse()) {
    if (node.hidden) continue
    let index = available.length - 1
    for (; index >= 0; index--) {
      const element = available[index]
      if ([[element.style.left, node.position.x], [element.style.top, node.position.y],
        [element.style.width, node.size.w], [element.style.height, node.size.h],
      ].every(([value, expected]) => Math.abs(parseFloat(String(value)) - Number(expected)) < 0.1)) break
    }
    if (index < 0) continue
    const [element] = available.splice(index, 1)
    element.dataset.animationShape = node.id
    result.set(node.id, element)
  }
  return result
}

function wipeStart(direction: string) {
  if (['left', 'l'].includes(direction)) return 'inset(0 0 0 100%)'
  if (['up', 'u'].includes(direction)) return 'inset(100% 0 0 0)'
  if (['down', 'd'].includes(direction)) return 'inset(0 0 100% 0)'
  return 'inset(0 100% 0 0)'
}

export function presentationEffectFrames(effect: PresentationEffect, target: HTMLElement, width: number, height: number): Keyframe[] {
  const transform = target.style.transform || ''
  const opacity = target.dataset.animationOpacity || '1'
  let frames: Keyframe[]
  if (effect.kind === 'motion') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', effect.path ?? '')
    const length = path.getTotalLength()
    const start = path.getPointAtLength(0)
    frames = Array.from({ length: 33 }, (_, index) => {
      const point = path.getPointAtLength(length * index / 32)
      return { transform: `translate(${(point.x - start.x) * width}px, ${(point.y - start.y) * height}px) ${transform}`, offset: index / 32 }
    })
  } else if (effect.kind === 'spin') frames = [{ transform }, { transform: `${transform} rotate(${effect.amount ?? 360}deg)` }]
  else if (effect.kind === 'zoom' && effect.mode === 'emphasis') {
    const [x, y] = effect.scale ?? [1.5, 1.5]
    frames = [{ transform }, { transform: `${transform} scale(${x}, ${y})` }]
  } else if (effect.kind === 'zoom') frames = [{ transform: `${transform} scale(0.01)`, opacity: 0 }, { transform, opacity }]
  else if (effect.kind === 'fly') {
    const direction = Number(effect.direction)
    const x = direction & 8 ? -width : direction & 2 ? width : 0
    const y = direction & 1 ? -height : direction & 4 ? height : 0
    frames = [{ transform: `translate(${x}px, ${y}px) ${transform}`, opacity: 0 }, { transform, opacity }]
  } else if (effect.kind === 'wipe') frames = [{ clipPath: wipeStart(effect.direction), opacity }, { clipPath: 'inset(0)', opacity }]
  else frames = [{ opacity: 0 }, { opacity }]
  return effect.mode === 'exit' ? frames.reverse() : frames
}

/** Owns every animation and restores object styles when the tab, slide, or reading mode changes. */
export class PresentationAnimationPlayer {
  private active = new Set<Animation>()
  private originals = new Map<HTMLElement, string | null>()
  private step = 0
  private epoch = 0
  private paused = false
  private automatic = false
  private inFlight: Promise<void> | null = null
  private loop: Promise<void> | null = null
  private missing = 0
  constructor(private root: HTMLElement, private shapes: Map<string, HTMLElement>, private plan: PresentationAnimationPlan,
    private width: number, private height: number, private changed: (state: PresentationAnimationState) => void) {
    for (const target of new Set(shapes.values())) {
      this.originals.set(target, target.getAttribute('style'))
      target.dataset.animationOpacity = target.style.opacity || '1'
    }
    this.missing = plan.groups.flatMap(group => group.effects).filter(effect => !shapes.has(effect.target)).length
    this.reset()
  }
  private emit() {
    this.changed({ step: this.step, total: this.plan.groups.length, playing: this.active.size > 0 && !this.paused,
      paused: this.paused, unsupported: this.plan.unsupported + this.missing })
  }
  private restore() {
    for (const [target, style] of this.originals) {
      if (style == null) target.removeAttribute('style')
      else target.setAttribute('style', style)
    }
  }
  reset() {
    this.epoch++
    this.automatic = false
    this.paused = false
    for (const animation of this.active) animation.cancel()
    this.active.clear()
    this.inFlight = this.loop = null
    this.restore()
    this.step = 0
    const seen = new Set<string>()
    for (const effect of this.plan.groups.flatMap(group => group.effects)) {
      if (seen.has(effect.target)) continue
      seen.add(effect.target)
      const target = this.shapes.get(effect.target)
      if (target && effect.mode === 'entrance') target.style.opacity = '0'
    }
    this.emit()
  }
  startEntry() {
    if (this.plan.transition && typeof this.root.animate === 'function') {
      const transition = this.plan.transition
      const frames = transition.kind === 'fade' ? [{ opacity: 0 }, { opacity: 1 }]
        : transition.kind === 'wipe' ? [{ clipPath: wipeStart(transition.direction) }, { clipPath: 'inset(0)' }]
          : [{ translate: `${['l', 'r'].includes(transition.direction) ? (transition.direction === 'r' ? -100 : 100) : 0}% ${['u', 'd'].includes(transition.direction) ? (transition.direction === 'd' ? -100 : 100) : 0}%` }, { translate: '0% 0%' }]
      const animation = this.root.animate(frames, { duration: transition.duration, easing: 'ease-out' })
      this.active.add(animation)
      this.emit()
      void animation.finished.catch(() => {}).finally(() => { this.active.delete(animation); this.emit() })
    }
    if (this.plan.groups[0]?.automatic) void this.runGroup()
  }
  next() {
    this.automatic = false
    if (this.active.size) { for (const animation of this.active) animation.finish(); return }
    void this.runGroup()
  }
  pause() {
    this.paused = true
    for (const animation of this.active) animation.pause()
    this.emit()
  }
  play() {
    this.automatic = true
    this.paused = false
    for (const animation of this.active) animation.play()
    this.emit()
    if (this.loop) return
    const epoch = this.epoch
    this.loop = (async () => {
      if (this.inFlight) await this.inFlight
      while (this.automatic && epoch === this.epoch && this.step < this.plan.groups.length) await this.runGroup()
    })().finally(() => { if (epoch === this.epoch) { this.loop = null; this.automatic = false; this.emit() } })
  }
  private runGroup(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const group = this.plan.groups[this.step]
    if (!group) return Promise.resolve()
    const epoch = this.epoch
    const animations: Animation[] = []
    for (const effect of group.effects) {
      const target = this.shapes.get(effect.target)
      if (!target) continue
      try {
        const animation = target.animate(presentationEffectFrames(effect, target, this.width, this.height), {
          duration: effect.duration, delay: effect.delay, iterations: effect.iterations,
          direction: effect.reverse ? 'alternate' : 'normal', fill: 'both', easing: 'linear',
        })
        this.active.add(animation)
        animations.push(animation)
      } catch { this.missing++; target.style.opacity = target.dataset.animationOpacity || '1' }
    }
    this.emit()
    this.inFlight = Promise.all(animations.map(async animation => {
      try {
        await animation.finished
        if (epoch !== this.epoch) return
        animation.commitStyles()
      } catch { /* Cancellation belongs to slide/preview lifecycle. */ }
      finally { this.active.delete(animation); animation.cancel() }
    })).then(() => {
      if (epoch === this.epoch) { this.step++; this.paused = false; this.inFlight = null; this.emit() }
    })
    return this.inFlight
  }
  dispose() {
    this.reset()
    this.restore()
    for (const target of this.originals.keys()) delete target.dataset.animationOpacity
  }
}
