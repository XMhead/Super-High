import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ExplorerPane from './ExplorerPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { FileEntry } from '@/types'

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
  },
  isTauri: vi.fn(() => false),
  onTerminalExit: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function file(name: string): FileEntry {
  return {
    name,
    path: `D:/One/${name}`,
    type: 'file',
  }
}

function directory(name: string): FileEntry {
  return {
    name,
    path: `D:/One/${name}`,
    type: 'directory',
  }
}

describe('ExplorerPane', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    mocks.listDirectory.mockReset()
  })

  it('keeps the visible file anchored when an external refresh inserts an earlier entry', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [file('b.txt'), file('c.txt'), file('d.txt')] },
    }

    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(defineComponent({
      render: () => h(ExplorerPane, { rootPath: 'D:/One' }),
    }))
    app.use(pinia)
    app.mount(root)
    await nextTick()

    const body = root.querySelector<HTMLElement>('.explorer-body')!
    body.scrollTop = 40
    body.getBoundingClientRect = () => ({ top: 0, bottom: 100 } as DOMRect)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const path = this.dataset?.path
      if (!path) return { top: 0, bottom: 0 } as DOMRect
      const index = Array.from(body.querySelectorAll<HTMLElement>('.tree-entry')).indexOf(this)
      const top = index * 20 - body.scrollTop
      return { top, bottom: top + 20 } as DOMRect
    })

    store.directoryCache['D:/One'] = {
      path: 'D:/One',
      entries: [file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt')],
    }
    await nextTick()
    await nextTick()

    expect(body.scrollTop).toBe(60)
    app.unmount()
  })

  it('collapses all expanded folders when the collapse button is clicked', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [directory('src'), file('a.txt')] },
      'D:/One/src': { path: 'D:/One/src', entries: [file('main.ts')] },
    }
    store.expandedPaths = ['D:/One', 'D:/One/src']

    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(defineComponent({
      render: () => h(ExplorerPane, { rootPath: 'D:/One' }),
    }))
    app.use(pinia)
    app.mount(root)
    await nextTick()

    const collapseButton = root.querySelector<HTMLButtonElement>('.explorer-collapse-button')!
    expect(collapseButton).not.toBeNull()
    expect(collapseButton.disabled).toBe(false)

    collapseButton.click()
    await nextTick()

    expect(store.expandedPaths).toEqual(['D:/One'])
    app.unmount()
  })
})
