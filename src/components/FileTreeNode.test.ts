import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FileTreeNode from './FileTreeNode.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DirectoryListing, FileEntry } from '@/types'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
  },
  isTauri: mocks.isTauri,
  onTerminalExit: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function directory(path: string): FileEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'directory',
  }
}

function file(path: string): FileEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'file',
    extension: `.${path.split('.').pop() ?? ''}`,
    size: 2048,
  }
}

function mountNode(pinia: Pinia, entry: FileEntry) {
  const root = document.createElement('div')
  root.className = 'explorer-body'
  document.body.appendChild(root)
  const app = createApp(defineComponent({
    render: () => h(FileTreeNode, {
      entry,
      depth: 0,
      contextMenuPath: null,
    }),
  }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

async function flushPromises() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
}

describe('FileTreeNode', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mocks.isTauri.mockReset()
    mocks.listDirectory.mockReset()
    mocks.isTauri.mockReturnValue(false)
  })

  it('keeps the explorer scroll position when a folder opens after loading', async () => {
    const store = useWorkspaceStore()
    const entry = directory('D:/One/src')
    const listing: DirectoryListing = {
      path: entry.path,
      entries: [directory('D:/One/src/components')],
    }
    mocks.listDirectory.mockImplementation(async () => {
      document.querySelector<HTMLElement>('.explorer-body')!.scrollTop = 0
      return listing
    })

    const { app, root } = mountNode(pinia, entry)
    root.scrollTop = 120

    root.querySelector<HTMLButtonElement>('.tree-entry')!.click()
    await nextTick()
    await flushPromises()
    await nextTick()

    expect(root.scrollTop).toBe(120)
    expect(store.expandedPaths).toContain(entry.path)

    app.unmount()
  })

  it('keeps cached children stable while their directory refreshes in the background', async () => {
    const store = useWorkspaceStore()
    const entry = directory('D:/One/ExampleTools')
    store.expandedPaths = [entry.path]
    store.loadingDirectories = [entry.path]
    store.directoryCache = {
      [entry.path]: {
        path: entry.path,
        entries: [file('D:/One/ExampleTools/config.yml')],
      },
    }

    const { app, root } = mountNode(pinia, entry)
    await nextTick()

    expect(root.textContent).toContain('config.yml')
    expect(root.textContent).not.toContain('读取中...')
    expect(root.textContent).not.toContain('空目录')

    app.unmount()
  })

  it('distinguishes an initial directory load from a confirmed empty directory', async () => {
    const store = useWorkspaceStore()
    const entry = directory('D:/One/pets')
    store.expandedPaths = [entry.path]
    store.loadingDirectories = [entry.path]

    const { app, root } = mountNode(pinia, entry)
    await nextTick()

    expect(root.textContent).toContain('读取中...')
    expect(root.textContent).not.toContain('空目录')

    store.directoryCache[entry.path] = { path: entry.path, entries: [] }
    store.loadingDirectories = []
    await nextTick()

    expect(root.textContent).not.toContain('读取中...')
    expect(root.textContent).toContain('空目录')

    app.unmount()
  })

  it('uses compact markers, hides file sizes, and varies file icons in the explorer tree', async () => {
    const store = useWorkspaceStore()
    const entry = directory('D:/One/Gui')
    store.expandedPaths = [entry.path, 'D:/One/Gui/宝箱界面']
    store.directoryCache = {
      [entry.path]: {
        path: entry.path,
        entries: [
          directory('D:/One/Gui/宝箱界面'),
          directory('D:/One/Gui/OtherDir'),
          file('D:/One/Gui/App.vue'),
          file('D:/One/Gui/settings.yml'),
          file('D:/One/Gui/README.md'),
          file('D:/One/Gui/logo.png'),
          file('D:/One/Gui/notes.bin'),
        ],
      },
      'D:/One/Gui/宝箱界面': {
        path: 'D:/One/Gui/宝箱界面',
        entries: [file('D:/One/Gui/宝箱界面/宝箱界面.yml')],
      },
    }

    const { app, root } = mountNode(pinia, entry)
    await nextTick()

    const rows = Array.from(root.querySelectorAll<HTMLElement>('.tree-entry'))
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      '▼Gui',
      '▼宝箱界面',
      '宝箱界面.yml',
      '▶OtherDir',
      'App.vue',
      'settings.yml',
      'README.md',
      'logo.png',
      'notes.bin',
    ])
    expect(rows.some((row) => row.textContent?.includes('2.0K'))).toBe(false)
    expect(root.querySelector('.tree-kind-icon.folder')).toBeNull()
    expect(rows[1].style.paddingLeft).toBe('22px')
    expect(rows[2].querySelector('.tree-disclosure')).toBeNull()
    expect(rows[2].querySelector('.tree-kind-icon')?.classList.contains('data')).toBe(true)
    expect(rows[4].querySelector('.tree-kind-icon')?.classList.contains('code')).toBe(true)
    expect(rows[5].querySelector('.tree-kind-icon')?.classList.contains('data')).toBe(true)
    expect(rows[6].querySelector('.tree-kind-icon')?.classList.contains('document')).toBe(true)
    expect(rows[7].querySelector('.tree-kind-icon')?.classList.contains('image')).toBe(true)
    expect(rows[8].querySelector('.tree-kind-icon')?.classList.contains('file')).toBe(true)

    app.unmount()
  })
})
