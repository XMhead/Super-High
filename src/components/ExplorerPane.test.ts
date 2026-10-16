import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ExplorerPane from './ExplorerPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { FileEntry } from '@/types'
import { registerMemoCommandHandler } from '@/lib/memoCommands'

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  appConfirm: vi.fn(),
  writeText: vi.fn(),
  readEditorFile: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
    readEditorFile: mocks.readEditorFile,
  },
  isTauri: vi.fn(() => false),
  onTerminalExit: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('@/lib/appDialog', () => ({
  appConfirm: mocks.appConfirm,
  appPrompt: vi.fn(),
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

async function mountExplorer(entries: FileEntry[], children: FileEntry[] = []) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.directoryCache = {
    'D:/One': { path: 'D:/One', entries },
    'D:/One/src': { path: 'D:/One/src', entries: children },
  }
  if (children.length) store.expandedPaths = ['D:/One/src']
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(ExplorerPane, { rootPath: 'D:/One', customFileOpen: true })
  app.use(pinia)
  app.mount(root)
  await nextTick()
  const row = (name: string) => root.querySelector<HTMLButtonElement>(`.tree-entry[data-path="D:/One/${name}"]`)!
  const click = async (name: string, options: MouseEventInit = {}) => {
    row(name).dispatchEvent(new MouseEvent('click', { bubbles: true, ...options }))
    await nextTick()
  }
  const menu = async (name: string) => {
    row(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    await nextTick()
  }
  const action = (label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('.file-context-item')).find((button) => button.querySelector('span:nth-child(2)')?.textContent?.trim() === label)!
  const selected = () => Array.from(root.querySelectorAll<HTMLElement>('.tree-entry.selected')).map((entry) => entry.dataset.path)
  return { store, root, app, row, click, menu, action, selected }
}

describe('ExplorerPane', () => {
  it('imports decoded file content and disables directory and multi-selection imports', async () => {
    const run = vi.fn().mockResolvedValue({ id: 'imported' })
    const cleanup = registerMemoCommandHandler(run)
    const view = await mountExplorer([file('a.txt'), file('b.txt'), directory('src')])
    vi.spyOn(view.store, 'setMemoWindowOpen')
    mocks.readEditorFile.mockResolvedValue({ content: '中文正文\n第二行', encoding: 'gbk' })
    await view.menu('a.txt')
    view.action('导入内容到备忘录').click()
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ operation: 'memo.create', options: { title: 'a.txt', content: '中文正文\n第二行', category: '' } }))
    expect(view.store.setMemoWindowOpen).toHaveBeenCalledWith(true)
    await view.menu('src')
    expect(view.action('导入内容到备忘录').disabled).toBe(true)
    await view.click('a.txt')
    await view.click('b.txt', { ctrlKey: true })
    await view.menu('a.txt')
    expect(view.action('导入内容到备忘录').disabled).toBe(true)
    cleanup()
    view.app.unmount()
  })

  it('does not create a memo when reading the file fails', async () => {
    const run = vi.fn()
    const cleanup = registerMemoCommandHandler(run)
    const view = await mountExplorer([file('image.png')])
    const message = vi.spyOn(view.store, 'showActivityMessage')
    mocks.readEditorFile.mockRejectedValue(new Error('二进制内容'))
    await view.menu('image.png')
    view.action('导入内容到备忘录').click()
    await vi.waitFor(() => expect(message).toHaveBeenCalledWith('导入备忘录失败：二进制内容'))
    expect(run).not.toHaveBeenCalled()
    cleanup()
    view.app.unmount()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    mocks.listDirectory.mockReset()
    mocks.appConfirm.mockReset().mockResolvedValue(true)
    mocks.writeText.mockReset().mockResolvedValue(undefined)
    HTMLElement.prototype.scrollIntoView = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.writeText } })
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

  it('preserves the explorer scroll position after confirming a deletion', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.directoryCache = {
      'D:/One': { path: 'D:/One', entries: [file('a.txt'), file('b.txt'), file('c.txt')] },
    }
    vi.spyOn(store, 'deletePath').mockImplementation(async (path: string) => {
      store.directoryCache['D:/One'] = {
        path: 'D:/One',
        entries: store.directoryCache['D:/One'].entries.filter((entry) => entry.path !== path),
      }
      return true
    })

    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(defineComponent({
      render: () => h(ExplorerPane, { rootPath: 'D:/One' }),
    }))
    app.use(pinia)
    app.mount(root)
    await nextTick()

    const body = root.querySelector<HTMLElement>('.explorer-body')!
    body.scrollTop = 72
    const entry = root.querySelector<HTMLElement>('.tree-entry[data-path="D:/One/b.txt"]')!
    entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    await nextTick()
    root.querySelector<HTMLButtonElement>('.file-context-item.danger')!.click()
    await Promise.resolve()
    await nextTick()

    expect(mocks.appConfirm).toHaveBeenCalledOnce()
    expect(body.scrollTop).toBe(72)
    expect(root.querySelector('.tree-entry[data-path="D:/One/b.txt"]')).toBeNull()
    app.unmount()
    root.remove()
  })

  it('copies all mixed Ctrl-selected paths in tree order and keeps selection on right-click', async () => {
    const view = await mountExplorer([directory('src'), file('a.txt'), file('b.txt')])
    const toggle = vi.spyOn(view.store, 'toggleDirectory')
    await view.click('b.txt', { ctrlKey: true })
    await view.click('src', { ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()
    await view.menu('b.txt')
    expect(view.selected()).toEqual(['D:/One/src', 'D:/One/b.txt'])
    expect(view.action('重命名').disabled).toBe(true)
    view.action('复制相对路径').click()
    await nextTick()
    expect(mocks.writeText).toHaveBeenLastCalledWith('src\nb.txt')
    await view.menu('src')
    view.action('复制完整路径').click()
    await nextTick()
    expect(mocks.writeText).toHaveBeenLastCalledWith('D:/One/src\nD:/One/b.txt')
    await view.click('src', { ctrlKey: true })
    expect(view.selected()).toEqual(['D:/One/b.txt'])
    await view.menu('a.txt')
    expect(view.selected()).toEqual(['D:/One/a.txt'])
    expect(view.action('重命名').disabled).toBe(false)
    view.app.unmount()
  })

  it('selects visible ranges with Shift and supports keyboard selection', async () => {
    const view = await mountExplorer([directory('src'), file('a.txt'), file('b.txt')], [{ ...file('main.ts'), path: 'D:/One/src/main.ts' }])
    await view.click('src/main.ts')
    await view.click('b.txt', { shiftKey: true })
    expect(view.selected()).toEqual(['D:/One/src/main.ts', 'D:/One/a.txt', 'D:/One/b.txt'])
    const body = view.root.querySelector('.explorer-body')!
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }))
    await nextTick()
    expect(view.selected()).toEqual(['D:/One/src/main.ts', 'D:/One/a.txt'])
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    await nextTick()
    expect(view.selected()).toHaveLength(4)
    view.app.unmount()
  })

  it('confirms once and deletes a selected directory without deleting its child twice', async () => {
    const view = await mountExplorer([directory('src'), file('a.txt')], [{ ...file('main.ts'), path: 'D:/One/src/main.ts' }])
    const deletion = vi.spyOn(view.store, 'deletePath').mockResolvedValue(true)
    await view.click('src', { ctrlKey: true })
    await view.click('a.txt', { shiftKey: true })
    await view.menu('src/main.ts')
    view.action('删除 3 项').click()
    await vi.waitFor(() => expect(deletion).toHaveBeenCalledTimes(2))
    expect(mocks.appConfirm).toHaveBeenCalledOnce()
    expect(mocks.appConfirm.mock.calls[0][0]).toContain('共 3 项')
    expect(deletion.mock.calls.map(([path]) => path)).toEqual(['D:/One/src', 'D:/One/a.txt'])
    await nextTick()
    expect(view.selected()).toEqual([])
    view.app.unmount()
  })

  it('keeps failed items selected and reports earlier failures after later successes', async () => {
    const view = await mountExplorer([file('a.txt'), file('b.txt')])
    vi.spyOn(view.store, 'deletePath').mockImplementation(async (path) => {
      if (path.endsWith('a.txt')) {
        view.store.showErrorMessage('删除失败：a.txt\n拒绝访问')
        return false
      }
      view.store.showErrorMessage('')
      return true
    })
    await view.click('a.txt')
    await view.click('b.txt', { ctrlKey: true })
    await view.menu('a.txt')
    view.action('删除 2 项').click()
    await vi.waitFor(() => expect(view.selected()).toEqual(['D:/One/a.txt']))
    expect(view.store.errorMessage).toContain('拒绝访问')
    view.app.unmount()
  })

  it('does not delete or clear the selection when batch deletion is cancelled', async () => {
    const view = await mountExplorer([file('a.txt'), file('b.txt')])
    const deletion = vi.spyOn(view.store, 'deletePath').mockResolvedValue(true)
    mocks.appConfirm.mockResolvedValue(false)
    await view.click('a.txt')
    await view.click('b.txt', { ctrlKey: true })
    view.root.querySelector('.explorer-body')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    await nextTick()
    expect(mocks.appConfirm).toHaveBeenCalledOnce()
    expect(deletion).not.toHaveBeenCalled()
    expect(view.selected()).toEqual(['D:/One/a.txt', 'D:/One/b.txt'])
    view.app.unmount()
  })
})
