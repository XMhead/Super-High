import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DesktopOnboarding from './DesktopOnboarding.vue'

let app: App | undefined
const key = 'superhigh.desktop-onboarding.dismissed'
async function mount() {
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp(DesktopOnboarding)
  app.mount(root)
  await nextTick()
  return root.querySelector('dialog')!
}
async function press(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  document.querySelector('dialog')!.dispatchEvent(event)
  await nextTick()
  return event
}
beforeEach(() => {
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => { app?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks() })

describe('desktop onboarding', () => {
  it('opens once, bounds arrow navigation, and shields the workspace keyboard handler', async () => {
    const dialog = await mount()
    expect(dialog.open).toBe(true)
    const underlying = vi.fn()
    document.addEventListener('keydown', underlying)
    await press('ArrowLeft')
    expect(dialog.textContent).toContain('日常使用 · 1 / 6')
    expect((await press('ArrowRight')).defaultPrevented).toBe(true)
    expect(dialog.textContent).toContain('日常使用 · 2 / 6')
    for (let i = 0; i < 8; i++) await press('ArrowRight')
    expect(dialog.textContent).toContain('日常使用 · 6 / 6')
    await press('Escape')
    expect(dialog.open).toBe(false)
    expect(localStorage.getItem(key)).toBe('true')
    expect(underlying).not.toHaveBeenCalled()
    document.removeEventListener('keydown', underlying)
  })
  it('stays closed after remount and replays from the beginning on demand', async () => {
    localStorage.setItem(key, 'true')
    const dialog = await mount()
    expect(dialog.open).toBe(false)
    window.dispatchEvent(new Event('superhigh:replay-onboarding'))
    await nextTick()
    expect(dialog.open).toBe(true)
    await press('ArrowRight')
    await press('Escape')
    window.dispatchEvent(new Event('superhigh:replay-onboarding'))
    await nextTick()
    expect(dialog.textContent).toContain('日常使用 · 1 / 6')
    for (let i = 0; i < 5; i++) await press('ArrowRight')
    const finish = [...dialog.querySelectorAll('button')].find(b => b.textContent?.includes('完成教程'))!
    finish.click()
    expect(dialog.open).toBe(false)
    app?.unmount()
    expect((await mount()).open).toBe(false)
  })
})
