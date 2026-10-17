import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorTab, FileEntry } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import AppTopBar from './AppTopBar.vue'

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  openPath: vi.fn(),
  saveSettings: vi.fn(async (settings) => settings),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listDirectory: mocks.listDirectory,
    openPath: mocks.openPath,
    saveSettings: mocks.saveSettings,
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
  it('uses shared file icons for search results, text matches, and open tabs', async () => {
    const { root, store } = await mountTopBar()
    store.searchQuery = 'asset'
    store.searchOpen = true
    store.searchResults = { files: [
      { name: 'plugin.JAR', path: 'D:/Project/plugin.JAR', relativePath: 'plugin.JAR' },
      { name: 'model.bbmodel', path: 'D:/Project/model.bbmodel', relativePath: 'model.bbmodel' },
    ], textMatches: [
      { path: 'D:/Project/config.yml', relativePath: 'config.yml', lineNumber: 1, column: 1, preview: 'asset: true' },
    ] }
    await nextTick()
    expect(root.querySelector('.search-result-row .tree-kind-icon.java img')).not.toBeNull()
    expect(root.querySelector('.search-result-row .tree-kind-icon.model img')).not.toBeNull()
    expect(root.querySelector('.search-result-row.text .tree-kind-icon.data svg')).not.toBeNull()
    store.tabs = [{ id: 'model', name: 'model.bbmodel', path: 'D:/Project/model.bbmodel', content: '{}', contentType: 'text', language: 'json', isDirty: false }]
    store.searchQuery = ''
    await nextTick()
    expect(root.querySelector('.search-result-row .tree-kind-icon.model img')).not.toBeNull()
    expect(root.querySelector('.search-result-kind')?.textContent).toBe('已打开')
  })

  it('sorts files by time and counts with one persisted selection', async () => {
    const { root, store } = await mountTopBar()
    store.workspace = { id: 'project', name: 'Project', displayName: 'Project', rootPath: 'D:/Project', openedAt: '' }
    store.searchQuery = 'file'
    store.searchOpen = true
    store.searchResults = { files: [
      { name: 'old.txt', path: 'D:/Project/old.txt', relativePath: 'old.txt', modified: 100 },
      { name: 'new.txt', path: 'D:/Project/new.txt', relativePath: 'new.txt', modified: 200 },
      { name: 'unknown.txt', path: 'D:/Project/unknown.txt', relativePath: 'unknown.txt' },
    ], textMatches: [] }
    store.settings.fileOpenCountsByWorkspace = { 'd:/project': { 'd:/project/old.txt': 3, 'd:/project/new.txt': 1 } }
    const names = () => Array.from(root.querySelectorAll('.search-result-main > span:first-child')).map((item) => item.textContent)
    store.settings.searchSortMode = 'newest'
    await nextTick()
    expect(names()).toEqual(['new.txt', 'old.txt', 'unknown.txt'])
    store.settings.searchSortMode = 'oldest'
    await nextTick()
    expect(names()).toEqual(['old.txt', 'new.txt', 'unknown.txt'])
    store.settings.searchSortMode = 'mostOpened'
    await nextTick()
    expect(names()).toEqual(['old.txt', 'new.txt', 'unknown.txt'])
    const select = root.querySelector<HTMLSelectElement>('[aria-label="搜索排序"]')!
    expect(select.multiple).toBe(false)
    store.searchQuery = ''
    select.value = 'newest'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ searchSortMode: 'newest' })))
  })

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
    expect(root.querySelector('[title="项目编辑器预览"]')).toBeNull()
  })
})
