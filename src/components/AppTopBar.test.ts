import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorTab, FileEntry } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import AppTopBar from './AppTopBar.vue'

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
    openPath: mocks.openPath,
  },
  isTauri: vi.fn(() => false),
  onProjectServiceStatus: vi.fn(),
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
}))

let app: App<Element> | null = null

async function mountTopBar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(AppTopBar)
  app.use(pinia)
  app.mount(root)
  await nextTick()
  return { root, store }
}

async function settle() {
  await Promise.resolve()
  await nextTick()
}

describe('AppTopBar', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    mocks.listDirectory.mockReset()
    mocks.openPath.mockReset()
  })

  afterEach(() => {
    app?.unmount()
    app = null
  })

  it('opens a historical workspace from the file menu submenu', async () => {
    const { root, store } = await mountTopBar()
    store.recentProjects = [{
      path: 'D:/Historical',
      name: 'Historical',
      lastOpenedAt: '2026-08-01T12:00:00Z',
    }]
    const openProject = vi.spyOn(store, 'openProject').mockResolvedValue(true)
    await nextTick()

    root.querySelector<HTMLButtonElement>('.menu-button')!.click()
    await nextTick()
    const historicalWorkspace = root.querySelector<HTMLButtonElement>('.workspace-history-item')!

    expect(historicalWorkspace.textContent).toContain('Historical')
    expect(historicalWorkspace.textContent).toContain('D:/Historical')
    historicalWorkspace.click()
    expect(openProject).toHaveBeenCalledWith('D:/Historical')
  })

  it('reveals a breadcrumb dropdown entry in Windows Explorer from its context menu', async () => {
    const entry: FileEntry = {
      path: 'D:/Project/src/App.vue',
      name: 'App.vue',
      type: 'file',
    }
    mocks.listDirectory.mockResolvedValue({ path: 'D:/Project/src', entries: [entry] })
    mocks.openPath.mockResolvedValue(undefined)
    const { root, store } = await mountTopBar()
    const tab: EditorTab = {
      id: 'app',
      path: entry.path,
      name: entry.name,
      content: '',
      contentType: 'text',
      language: 'vue',
      isDirty: false,
    }
    store.workspace = {
      id: 'project',
      name: 'Project',
      displayName: 'Project',
      rootPath: 'D:/Project',
      openedAt: '2026-08-02T12:00:00Z',
    }
    store.tabs = [tab]
    store.activeTabId = tab.id
    store.directoryCache['D:/Project/src'] = { path: 'D:/Project/src', entries: [entry] }
    vi.spyOn(store, 'loadDirectory').mockResolvedValue(undefined)
    await nextTick()

    const srcBreadcrumb = Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-button'))
      .find((button) => button.textContent?.trim() === 'src')!
    srcBreadcrumb.click()
    await settle()

    const entryRow = root.querySelector<HTMLButtonElement>('.breadcrumb-picker-row')!
    entryRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 90 }))
    await nextTick()
    root.querySelector<HTMLButtonElement>('.breadcrumb-context-menu .file-context-item')!.click()
    await settle()

    expect(mocks.openPath).toHaveBeenCalledWith(entry.path)
  })

  it('toggles the memo window from the preview tool strip', async () => {
    const { root, store } = await mountTopBar()
    store.workspace = {
      id: 'project',
      name: 'Project',
      displayName: 'Project',
      rootPath: 'D:/Project',
      openedAt: '2026-08-10T12:00:00Z',
    }
    await nextTick()

    const memoButton = Array.from(root.querySelectorAll<HTMLButtonElement>('.preview-mode-strip .mode-button'))
      .find((button) => button.textContent?.trim() === '备忘录')!
    memoButton.click()
    await nextTick()

    expect(store.memoWindowOpen).toBe(true)
    expect(memoButton.classList.contains('active')).toBe(true)
  })
})
