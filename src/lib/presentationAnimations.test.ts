import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchPresentationShapes, parsePresentationAnimations, PresentationAnimationPlayer, presentationEffectFrames,
  type PresentationAnimationState, type PresentationEffect } from './presentationAnimations'

const wrap = (body: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:timing><p:tnLst>${body}</p:tnLst></p:timing></p:sld>`
const effectXml = (id: string, trigger = 'clickEffect', filter = 'fade', delay = 0) => `<p:par><p:cTn nodeType="${trigger}" presetClass="entr" presetID="10"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst><p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn dur="300"/><p:tgtEl><p:spTgt spid="${id}"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par>`
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('authored PowerPoint animation timing', () => {
  it('keeps click groups, simultaneous effects and after-previous delays', () => {
    const plan = parsePresentationAnimations(wrap(effectXml('2') + effectXml('3', 'withEffect', 'fade', 50)
      + effectXml('4', 'afterEffect', 'fade', 75) + effectXml('5')))
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups[0].effects.map(effect => ({ target: effect.target, delay: effect.delay, duration: effect.duration })))
      .toEqual([{ target: '2', delay: 0, duration: 300 }, { target: '3', delay: 50, duration: 300 }, { target: '4', delay: 425, duration: 300 }])
    expect(plan.unsupported).toBe(0)
  })

  it('preserves a click boundary for an unsupported effect and reports it', () => {
    const unsupported = effectXml('3').replace('presetID="10"', 'presetID="999"').replace('filter="fade"', 'filter="unknown"')
    const plan = parsePresentationAnimations(wrap(effectXml('2') + unsupported + effectXml('4', 'withEffect')))
    expect(plan.unsupported).toBe(1)
    expect(plan.groups[1].effects.map(effect => effect.target)).toEqual(['4'])
    expect(parsePresentationAnimations('<invalid')).toMatchObject({ groups: [], unsupported: 0 })
  })

  it('matches slide shape IDs without including master or background elements', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div style="left:0px;top:0px;width:960px;height:540px"></div><div style="left:20px;top:30px;width:100px;height:40px"></div>'
    const shapes = matchPresentationShapes(root, [{ id: '7', position: { x: 20, y: 30 }, size: { w: 100, h: 40 } }])
    expect(shapes.get('7')).toBe(root.lastElementChild)
    expect(shapes.size).toBe(1)
  })

  it('retains shape transforms and reverses exit keyframes', () => {
    const target = document.createElement('div')
    target.style.transform = 'rotate(15deg)'
    const effect: PresentationEffect = { target: '2', kind: 'fly', mode: 'entrance', duration: 500, delay: 0, direction: '8', reverse: false, iterations: 1 }
    const frames = presentationEffectFrames(effect, target, 960, 540)
    expect(frames[0].transform).toBe('translate(-960px, 0px) rotate(15deg)')
    expect(presentationEffectFrames({ ...effect, mode: 'exit' }, target, 960, 540)).toEqual([...frames].reverse())
  })
})

describe('PowerPoint playback lifecycle', () => {
  it('plays real steps, pauses, resumes, replays and restores static content on disposal', async () => {
    const root = document.createElement('div')
    const target = document.createElement('div')
    target.style.opacity = '0.8'
    root.append(target)
    const original = target.getAttribute('style')
    const animations: any[] = []
    const animate = vi.fn((frames: Keyframe[]) => {
      let done!: () => void
      let cancelled!: (error: Error) => void
      const animation = { finished: new Promise<void>((resolve, reject) => { done = resolve; cancelled = reject }),
        pause: vi.fn(), play: vi.fn(), finish: vi.fn(() => done()), cancel: vi.fn(() => cancelled(new Error('cancelled'))),
        commitStyles: vi.fn(() => { target.style.opacity = String(frames.at(-1)!.opacity) }) }
      animations.push(animation)
      return animation as unknown as Animation
    })
    target.animate = animate as typeof target.animate
    let status!: PresentationAnimationState
    const player = new PresentationAnimationPlayer(root, new Map([['2', target]]), parsePresentationAnimations(wrap(effectXml('2'))), 960, 540, value => { status = value })
    expect(target.style.opacity).toBe('0')
    player.play()
    expect(status.playing).toBe(true)
    player.pause()
    expect(status.paused).toBe(true)
    expect(animations[0].pause).toHaveBeenCalled()
    player.play()
    expect(animations[0].play).toHaveBeenCalled()
    animations[0].finish()
    await vi.waitFor(() => expect(status.step).toBe(1))
    expect(target.style.opacity).toBe('0.8')
    player.reset()
    expect(target.style.opacity).toBe('0')
    expect(status.step).toBe(0)
    player.next()
    expect(animate).toHaveBeenCalledTimes(2)
    player.dispose()
    expect(target.getAttribute('style')).toBe(original)
    await Promise.resolve()
    expect(status.step).toBe(0)
  })
})
