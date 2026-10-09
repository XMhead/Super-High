import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DragonCorePreviewWindow from './DragonCorePreviewWindow.vue'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('./PreviewPane.vue', () => ({
  default: defineComponent({
    name: 'PreviewPaneStub',
    render: () => h('div', { 'data-testid': 'preview-pane' }, 'PreviewPane'),
  }),
}))

function pointerEvent(type: string, init: MouseEventInit = {}) {
  return new MouseEvent(type, init)
}

function mountWindow(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(DragonCorePreviewWindow) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('DragonCorePreviewWindow', () => {
  let pinia: Pinia

  beforeEach(() => {
    document.body.innerHTML = ''
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('stays hidden when DragonCore mode is open outside the Minecraft surface', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceSurface = 'project'
    store.dragonCoreModeOpen = true
    const { app, root } = mountWindow(pinia)
    await nextTick()

    expect(root.querySelector('[data-testid="dragoncore-preview-window"]')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('renders PreviewPane with a close button when DragonCore mode is open', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceSurface = 'minecraft'
    store.dragonCoreModeOpen = true
    store.closeDragonCoreMode = vi.fn()
    const { app, root } = mountWindow(pinia)
    await nextTick()

    expect(root.querySelector('[data-testid="dragoncore-preview-window"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="preview-pane"]')).toBeTruthy()

    root.querySelector<HTMLButtonElement>('[data-testid="dragoncore-preview-close"]')!.click()
    await nextTick()

    expect(store.closeDragonCoreMode).toHaveBeenCalledOnce()

    app.unmount()
    root.remove()
  })

  it('supports pointer dragging and free-edge resizing', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceSurface = 'minecraft'
    store.dragonCoreModeOpen = true
    const { app, root } = mountWindow(pinia)
    await nextTick()

    const windowElement = root.querySelector<HTMLElement>('[data-testid="dragoncore-preview-window"]')!
    root.querySelector<HTMLElement>('[data-testid="dragoncore-preview-drag"]')!.dispatchEvent(pointerEvent('pointerdown', {
      clientX: 100,
      clientY: 120,
      bubbles: true,
    }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 150 }))
    window.dispatchEvent(pointerEvent('pointerup'))
    await nextTick()

    expect(windowElement.style.left).toBe('1000px')
    expect(windowElement.style.top).toBe('94px')
    expect(root.querySelectorAll('.dragoncore-preview-resize')).toHaveLength(8)

    root.querySelector<HTMLElement>('[data-testid="dragoncore-preview-resize-se"]')!.dispatchEvent(pointerEvent('pointerdown', {
      clientX: 100,
      clientY: 120,
      bubbles: true,
    }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 180, clientY: 190 }))
    window.dispatchEvent(pointerEvent('pointerup'))
    await nextTick()

    expect(windowElement.style.width).toBe('600px')
    expect(windowElement.style.height).toBe('650px')

    root.querySelector<HTMLElement>('[data-testid="dragoncore-preview-resize-nw"]')!.dispatchEvent(pointerEvent('pointerdown', {
      clientX: 100,
      clientY: 120,
      bubbles: true,
    }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 170 }))
    window.dispatchEvent(pointerEvent('pointerup'))
    await nextTick()

    expect(windowElement.style.left).toBe('1060px')
    expect(windowElement.style.top).toBe('144px')
    expect(windowElement.style.width).toBe('540px')
    expect(windowElement.style.height).toBe('600px')

    app.unmount()
    root.remove()
  })
})
