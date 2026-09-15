import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FileManagerPanel from './FileManagerPanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DirectoryListing, Workspace } from '@/types'

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  openPath: vi.fn(),
  readMediaAsDataUrl: vi.fn(),
  selectDirectory: vi.fn(),
  selectFiles: vi.fn(),
  copyPathsToDirectory: vi.fn(),
  movePathsToDirectory: vi.fn(),
  copyFilesToClipboard: vi.fn(),
  replaceImageFromClipboard: vi.fn(),
  searchProjectFiles: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
    openPath: mocks.openPath,
    readMediaAsDataUrl: mocks.readMediaAsDataUrl,
    selectDirectory: mocks.selectDirectory,
    selectFiles: mocks.selectFiles,
    copyPathsToDirectory: mocks.copyPathsToDirectory,
    movePathsToDirectory: mocks.movePathsToDirectory,
    copyFilesToClipboard: mocks.copyFilesToClipboard,
    replaceImageFromClipboard: mocks.replaceImageFromClipboard,
    searchProjectFiles: mocks.searchProjectFiles,
  },
  isTauri: vi.fn(() => false),
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
  loadMonaco: vi.fn(),
}))

vi.mock('./EditorPane.vue', () => ({
  default: { template: '<section data-testid="editor-stub"></section>' },
}))

function workspace(rootPath: string): Workspace {
  return {
    id: rootPath,
    name: rootPath.split('/').pop() ?? rootPath,
    displayName: rootPath.split('/').pop() ?? rootPath,
    rootPath,
    openedAt: '2026-07-17T00:00:00Z',
  }
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

function mountPanel(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(FileManagerPanel) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('FileManagerPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    mocks.listDirectory.mockReset()
    mocks.openPath.mockReset()
    mocks.readMediaAsDataUrl.mockReset()
    mocks.selectDirectory.mockReset()
    mocks.selectFiles.mockReset()
    mocks.copyPathsToDirectory.mockReset()
    mocks.movePathsToDirectory.mockReset()
    mocks.copyFilesToClipboard.mockReset()
    mocks.replaceImageFromClipboard.mockReset()
    mocks.searchProjectFiles.mockReset()
    mocks.readMediaAsDataUrl.mockResolvedValue('data:image/png;base64,AA==')
    mocks.selectFiles.mockResolvedValue([])
    mocks.copyPathsToDirectory.mockResolvedValue([])
    mocks.movePathsToDirectory.mockResolvedValue([])
    mocks.listDirectory.mockImplementation(async (path: string): Promise<DirectoryListing> => {
      if (path === 'D:/One/assets') {
        return {
          path,
          entries: [
            { name: 'icon.png', path: 'D:/One/assets/icon.png', type: 'file', extension: '.png', size: 2048, isHidden: false },
          ],
        }
      }
      if (path === 'E:/Assets') {
        return {
          path,
          entries: [
            { name: 'remote.png', path: 'E:/Assets/remote.png', type: 'file', extension: '.png', size: 4096, isHidden: false },
          ],
        }
      }
      return {
        path,
        entries: [
          { name: 'assets', path: 'D:/One/assets', type: 'directory', isHidden: false },
          { name: 'config.yml', path: 'D:/One/config.yml', type: 'file', extension: '.yml', size: 128, isHidden: false },
        ],
      }
    })
  })

  it('renders the workspace directory and navigates into folders', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    const { app, root } = mountPanel(pinia)
    await flushPromises()
    await nextTick()

    expect(root.querySelector('[data-testid="file-manager-entry-assets"]')).not.toBeNull()
    expect(root.textContent).toContain('config.yml')

    ;(root.querySelector('[data-testid="file-manager-entry-assets"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()

    expect(mocks.listDirectory).toHaveBeenCalledWith('D:/One/assets')
    expect(root.textContent).toContain('icon.png')

    app.unmount()
    root.remove()
  })

  it('opens an arbitrary directory in the shared explorer and grid', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    mocks.selectDirectory.mockResolvedValue('E:/Assets')
    const { app, root } = mountPanel(pinia)
    await flushPromises()
    await nextTick()

    ;(root.querySelector('[aria-label="选择目录"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()

    expect(mocks.selectDirectory).toHaveBeenCalledWith('D:/One')
    expect(mocks.listDirectory).toHaveBeenCalledWith('E:/Assets')
    expect(root.textContent).toContain('remote.png')
    expect(root.querySelector('.explorer-body [data-path="E:/Assets/remote.png"]')).not.toBeNull()

    app.unmount()
    root.remove()
  })

  it('navigates from the shared tree and opens a file without leaving the file manager', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    store.activeWorkspaceSurface = 'files'
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    const { app, root } = mountPanel(pinia)
    await flushPromises()
    await nextTick()

    ;(root.querySelector('.explorer-body [data-path="D:/One/assets"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()
    expect(store.expandedPaths).toContain('D:/One/assets')
    expect(root.querySelector('[data-testid="file-manager-entry-icon.png"]')).not.toBeNull()

    ;(root.querySelector('.explorer-body [data-path="D:/One/config.yml"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()
    expect(openFile).toHaveBeenCalledWith('D:/One/config.yml')
    expect(store.activeWorkspaceSurface).toBe('files')
    expect(root.querySelector('[data-testid="file-manager-entry-config.yml"]')).not.toBeNull()

    app.unmount()
    root.remove()
  })

  it('copies selected entries into the current directory', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One')
    mocks.copyPathsToDirectory.mockResolvedValue([
      { sourcePath: 'D:/One/config.yml', targetPath: 'D:/One/config_copy1.yml', ok: true, error: null },
    ])
    const { app, root } = mountPanel(pinia)
    await flushPromises()
    await nextTick()

    ;(root.querySelector('[data-testid="file-manager-entry-config.yml"] .file-manager-entry-check') as HTMLElement).click()
    await nextTick()
    ;(root.querySelector('[aria-label="复制选中项"]') as HTMLButtonElement).click()
    await nextTick()
    ;(root.querySelector('[aria-label="粘贴到当前目录"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()

    expect(mocks.copyPathsToDirectory).toHaveBeenCalledWith(['D:/One/config.yml'], 'D:/One')

    app.unmount()
    root.remove()
  })

  it('zooms media from wheel events inside the preview stage', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One/assets')
    const { app, root } = mountPanel(pinia)
    await openImagePreview(root)

    const stage = root.querySelector('.file-manager-media-stage') as HTMLElement
    const image = stage.querySelector('img') as HTMLImageElement
    expect(image.style.transform).toContain('translate(0px, 0px)')
    expect(image.style.transform).toContain('scale(1)')

    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }))
    await nextTick()

    expect(image.style.transform).toContain('translate(0px, 0px)')
    expect(image.style.transform).toContain('scale(1.1)')

    app.unmount()
    root.remove()
  })

  it('pans media with pointer drag inside the preview stage', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/One/assets')
    const { app, root } = mountPanel(pinia)
    await openImagePreview(root)

    const stage = root.querySelector('.file-manager-media-stage') as HTMLElement
    const image = stage.querySelector('img') as HTMLImageElement

    dispatchPointer(image, 'pointerdown', { pointerId: 7, clientX: 120, clientY: 80, button: 0, buttons: 1 })
    dispatchPointer(window, 'pointermove', { pointerId: 7, clientX: 152, clientY: 136, buttons: 1 })
    await nextTick()

    expect(image.style.transform).toContain('translate(32px, 56px)')
    expect(image.style.transform).toContain('scale(1)')

    dispatchPointer(window, 'pointerup', { pointerId: 7, clientX: 152, clientY: 136, button: 0 })

    app.unmount()
    root.remove()
  })
})

async function openImagePreview(root: HTMLElement) {
  let entry = root.querySelector('[data-testid="file-manager-entry-icon.png"]') as HTMLButtonElement | null
  for (let index = 0; index < 6 && !entry; index += 1) {
    await flushPromises()
    await nextTick()
    entry = root.querySelector('[data-testid="file-manager-entry-icon.png"]') as HTMLButtonElement | null
  }
  if (!entry) throw new Error('media entry did not render')
  entry.click()
  for (let index = 0; index < 6; index += 1) {
    await flushPromises()
    await nextTick()
    if (root.querySelector('.file-manager-media-stage img')) return
  }
  throw new Error('media preview image did not render')
}

function dispatchPointer(target: EventTarget, type: string, init: PointerEventInit & { buttons?: number } = {}) {
  const hasPointerEvent = typeof window.PointerEvent === 'function'
  const event = hasPointerEvent
    ? new window.PointerEvent(type, { bubbles: true, cancelable: true, ...init })
    : new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: init.clientX,
        clientY: init.clientY,
        button: init.button ?? 0,
        buttons: init.buttons ?? 0,
      })

  if (!hasPointerEvent) {
    Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
    Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' })
  }

  target.dispatchEvent(event)
}
