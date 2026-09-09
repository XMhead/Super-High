import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ActivityBar from './ActivityBar.vue'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function mountActivityBar(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(ActivityBar) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('ActivityBar surfaces', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('opens the file manager surface from the activity bar', async () => {
    const store = useWorkspaceStore()
    store.workspace = {
      id: 'D:/One',
      name: 'One',
      displayName: 'One',
      rootPath: 'D:/One',
      openedAt: '2026-07-17T00:00:00Z',
    }
    const { app, root } = mountActivityBar(pinia)
    await nextTick()

    ;(root.querySelector('[data-testid="files-activity"]') as HTMLButtonElement).click()
    await nextTick()

    expect(store.activeWorkspaceSurface).toBe('files')

    app.unmount()
    root.remove()
  })
})
