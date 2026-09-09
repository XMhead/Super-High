import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EditorPane from './EditorPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EditorTab, FileEntry, Workspace } from '@/types'

const monacoTestState = vi.hoisted(() => ({ current: null as any }))

vi.mock('@/lib/monaco', () => ({
  loadMonaco: vi.fn(async () => monacoTestState.current ?? ({
    editor: {
      create: vi.fn(() => ({
        addCommand: vi.fn(),
        createDecorationsCollection: vi.fn(() => ({ clear: vi.fn(), set: vi.fn() })),
        dispose: vi.fn(),
        getModel: vi.fn(() => null),
        getSelection: vi.fn(() => null),
        getValue: vi.fn(() => ''),
        onDidChangeCursorSelection: vi.fn(),
        onDidChangeModelContent: vi.fn(),
        onMouseDown: vi.fn(),
        updateOptions: vi.fn(),
      })),
      defineTheme: vi.fn(),
      setModelMarkers: vi.fn(),
    },
    KeyCode: { KeyS: 49 },
    KeyMod: { CtrlCmd: 2048 },
    languages: {
      registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  })),
  getMonaco: vi.fn(() => monacoTestState.current),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    saveSettings: vi.fn(async (settings) => settings),
    readFile: vi.fn(async (path: string) => (
      path.endsWith('/.superhigh/editor/editor.json')
        ? JSON.stringify({ version: 1, pages: [{ id: 'items', entry: 'items.html', codePreviewRoot: 'plugins/Items' }] })
        : JSON.stringify({ version: 1, mainSource: 'mm' })
    )),
  },
  isTauri: vi.fn(() => false),
  onTerminalExit: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(async () => vi.fn()),
}))

function workspace(rootPath: string): Workspace {
  return {
    id: rootPath,
    name: rootPath.split('/').pop() ?? rootPath,
    displayName: rootPath.split('/').pop() ?? rootPath,
    rootPath,
    openedAt: '2026-07-16T00:00:00Z',
  }
}

function tab(path: string): EditorTab {
  return {
    id: 'tab-1',
    path,
    name: path.split('/').pop() ?? path,
    content: 'name: value\n',
    contentType: 'text',
    language: 'yaml',
    isDirty: false,
  }
}

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
  }
}

function mountEditorPane(pinia: Pinia, props: Record<string, unknown> = {}) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(EditorPane, props) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

async function flushPromises() {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve()
  }
}

describe('EditorPane compact breadcrumbs', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('updates the Monaco model when the active file is reloaded from disk', async () => {
    let modelValue = 'before CLI edit\n'
    const model = {
      getValue: vi.fn(() => modelValue),
      setValue: vi.fn((value: string) => { modelValue = value }),
    }
    const editor = {
      addCommand: vi.fn(),
      createDecorationsCollection: vi.fn(() => ({ clear: vi.fn(), set: vi.fn() })),
      dispose: vi.fn(),
      getModel: vi.fn(() => model),
      getSelection: vi.fn(() => null),
      getValue: vi.fn(() => modelValue),
      onDidChangeCursorSelection: vi.fn(),
      onDidChangeModelContent: vi.fn(),
      onMouseDown: vi.fn(),
      restoreViewState: vi.fn(),
      saveViewState: vi.fn(() => null),
      updateOptions: vi.fn(),
    }
    monacoTestState.current = {
      editor: {
        create: vi.fn(() => editor),
        defineTheme: vi.fn(),
        setModelLanguage: vi.fn(),
        setModelMarkers: vi.fn(),
        setTheme: vi.fn(),
      },
      KeyCode: { KeyS: 49 },
      KeyMod: { CtrlCmd: 2048 },
      MarkerSeverity: { Error: 8 },
      languages: {
        registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
      },
    }

    try {
      const pinia = createPinia()
      setActivePinia(pinia)
      const store = useWorkspaceStore()
      store.workspace = workspace('D:/Project')
      store.tabs = [{ ...tab('D:/Project/cli-output.txt'), content: modelValue, language: 'plaintext' }]
      store.activeTabId = 'tab-1'

      const { app, root } = mountEditorPane(pinia)
      await flushPromises()
      await nextTick()
      model.setValue.mockClear()

      store.tabs[0].content = 'after CLI edit\n'
      await nextTick()

      expect(model.setValue).toHaveBeenCalledWith('after CLI edit\n')
      expect(modelValue).toBe('after CLI edit\n')
      app.unmount()
      root.remove()
    } finally {
      monacoTestState.current = null
    }
  })

  it('renders file tabs above compact workspace-relative breadcrumbs', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [tab('D:/Project/plugins/Orryx/buffs.yml')]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const tabs = root.querySelector('.tabs-strip')
    const breadcrumbs = root.querySelector('.editor-breadcrumb-strip')

    expect(tabs).not.toBeNull()
    expect(breadcrumbs).not.toBeNull()
    expect(tabs!.compareDocumentPosition(breadcrumbs!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(Array.from(root.querySelectorAll('.editor-breadcrumb-inner .breadcrumb-segment')).map((item) => item.textContent?.trim())).toEqual([
      'Orryx',
      'buffs.yml',
    ])
    expect(root.querySelector('.editor-breadcrumb-inner .breadcrumb-sep')?.textContent).toBe('›')
    expect(root.querySelector('.editor-breadcrumb-inner')?.textContent).not.toContain('D:')

    app.unmount()
    root.remove()
  })

  it('shows the persistent HTML preview toggle immediately before file actions', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const htmlTab = {
      ...tab('D:/Project/index.html'),
      content: '<main>HTML preview</main>',
      language: 'html',
    }
    store.tabs = [htmlTab]
    store.activeTabId = htmlTab.id

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const toggle = root.querySelector('.tabs-html-preview-button') as HTMLButtonElement
    const fileActions = root.querySelector('.tabs-more-button') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.nextElementSibling).toBe(fileActions)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const previewSrcdoc = root.querySelector<HTMLIFrameElement>('.html-preview-frame')?.srcdoc ?? ''
    expect(previewSrcdoc).toContain('<main>HTML preview</main>')
    expect(previewSrcdoc).toContain('superhigh-external-link-bridge')

    toggle.click()
    await flushPromises()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(root.querySelector('.html-preview-frame')).toBeNull()
    expect(root.querySelector('.editor-host-shell .monaco-host')).not.toBeNull()

    app.unmount()
    root.remove()
  })

  it('pans a zoomed image by dragging it inside the preview stage', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.tabs = [{
      ...tab('D:/Project/assets/panel.png'),
      content: 'data:image/png;base64,preview',
      contentType: 'image',
      language: 'image',
    }]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const stage = root.querySelector('.image-preview-stage') as HTMLDivElement
    const image = root.querySelector('.image-preview-img') as HTMLImageElement
    stage.scrollLeft = 180
    stage.scrollTop = 120

    image.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 300,
      clientY: 240,
    }))
    window.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 260,
      clientY: 210,
    }))
    await nextTick()

    expect(stage.scrollLeft).toBe(220)
    expect(stage.scrollTop).toBe(150)
    expect(stage.classList.contains('dragging')).toBe(true)

    window.dispatchEvent(new MouseEvent('pointerup'))
    await nextTick()
    expect(stage.classList.contains('dragging')).toBe(false)

    app.unmount()
    root.remove()
  })

  it('zooms the image preview from wheel events inside the stage', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.tabs = [{
      ...tab('D:/Project/assets/panel.png'),
      content: 'data:image/png;base64,preview',
      contentType: 'image',
      language: 'image',
    }]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const stage = root.querySelector('.image-preview-stage') as HTMLDivElement
    const image = root.querySelector('.image-preview-img') as HTMLImageElement
    image.width = 200
    image.height = 150
    image.dispatchEvent(new Event('load'))
    await nextTick()

    const wheelUp = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 })
    stage.dispatchEvent(wheelUp)
    await nextTick()
    expect(wheelUp.defaultPrevented).toBe(true)
    expect(image.style.width).toBe('220px')
    expect(image.style.height).toBe('165px')

    const wheelDown = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    stage.dispatchEvent(wheelDown)
    await nextTick()
    expect(image.style.width).toBe('200px')
    expect(image.style.height).toBe('150px')

    app.unmount()
    root.remove()
  })
  it('runs SuperHigh editor HTML opened from the file explorer with its runtime bridge', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const htmlTab = {
      ...tab('D:/Project/.superhigh/editor/items.html'),
      content: '<!doctype html><html><head></head><body><button>物品编辑器</button></body></html>',
      language: 'html',
    }
    store.workspace = workspace('D:/Project')
    store.tabs = [htmlTab]
    store.activeTabId = htmlTab.id

    const { app, root } = mountEditorPane(pinia)
    await flushPromises()
    await nextTick()

    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')
    expect(frame).not.toBeNull()
    expect(frame!.srcdoc).toContain('superhigh-editor-preview-bridge')
    expect(frame!.srcdoc).toContain('--color-bg-primary')
    expect(frame!.srcdoc).toContain('物品编辑器')

    app.unmount()
    root.remove()
  })

  it('opens a tab context menu for copying paths and adding the relative path to chat', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const filePath = 'D:/Project/docs/guide/shop.yml'
    const relativePath = 'docs/guide/shop.yml'
    store.workspace = workspace('D:/Project')
    store.tabs = [tab(filePath)]
    store.activeTabId = 'tab-1'

    const added: Array<{ text?: string; insertMode?: string }> = []
    window.addEventListener('superhigh:add-selection-to-chat', ((event: Event) => {
      added.push((event as CustomEvent).detail)
    }) as EventListener)

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    root.querySelector('.editor-tab')?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 42,
      clientY: 24,
    }))
    await nextTick()

    expect(root.querySelector('.tab-context-menu')?.textContent).toContain('复制相对路径')
    ;(root.querySelector('[data-testid="tab-copy-relative-path"]') as HTMLButtonElement).click()
    await nextTick()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(relativePath)

    root.querySelector('.editor-tab')?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 42,
      clientY: 24,
    }))
    await nextTick()
    ;(root.querySelector('[data-testid="tab-add-relative-path-to-chat"]') as HTMLButtonElement).click()
    await nextTick()

    expect(added.at(-1)).toMatchObject({
      text: relativePath,
      insertMode: 'plain',
    })

    app.unmount()
    root.remove()
  })

  it('uses VS Code-style sibling breadcrumb menus with tree expand and collapse', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const rootPath = 'D:/Project/plugins'
    const docsPath = `${rootPath}/docs`
    const guidePath = `${docsPath}/guide`
    const headPath = `${docsPath}/head`
    const activeFilePath = `${guidePath}/guide.yml`
    store.workspace = workspace(rootPath)
    store.tabs = [tab(activeFilePath)]
    store.activeTabId = 'tab-1'
    store.directoryCache = {
      [docsPath]: {
        path: docsPath,
        entries: [
          directory(`${docsPath}/components`),
          directory(`${docsPath}/styles`),
          directory(`${docsPath}/scripts`),
          directory(guidePath),
          directory(headPath),
          file(`${docsPath}/open-all.bat`),
        ],
      },
      [guidePath]: {
        path: guidePath,
        entries: [
          file(`${guidePath}/profile.yml`),
          file(`${guidePath}/pets.yml`),
          file(`${guidePath}/pets-bag.yml`),
          file(activeFilePath),
          file(`${guidePath}/dungeon.yml`),
        ],
      },
      [headPath]: {
        path: headPath,
        entries: [
          file(`${headPath}/header.yml`),
        ],
      },
    }
    const loadDirectory = vi.spyOn(store, 'loadDirectory').mockResolvedValue(undefined)
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const crumbs = Array.from(root.querySelectorAll<HTMLButtonElement>('.editor-breadcrumb-inner .breadcrumb-segment'))
    expect(crumbs.map((item) => item.textContent?.trim())).toEqual([
      'docs',
      'guide',
      'guide.yml',
    ])

    crumbs[1].click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenLastCalledWith(docsPath, true)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'components',
      'guide',
      'head',
      'scripts',
      'styles',
      'open-all.bat',
    ])
    expect(root.querySelector('.breadcrumb-picker-row.active .breadcrumb-picker-name')?.textContent?.trim()).toBe('guide')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    const loadCountBeforeGuide = loadDirectory.mock.calls.length
    Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('guide'),
    )?.click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenCalledTimes(loadCountBeforeGuide)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'components',
      'guide',
      'dungeon.yml',
      'guide.yml',
      'pets-bag.yml',
      'pets.yml',
      'profile.yml',
      'head',
      'scripts',
      'styles',
      'open-all.bat',
    ])
    let directoryRows = Array.from(root.querySelectorAll<HTMLElement>('.breadcrumb-dropdown .breadcrumb-picker-row'))
    expect(directoryRows[1].style.paddingLeft).toBe('8px')
    expect(directoryRows[2].style.paddingLeft).toBe('16px')
    expect(directoryRows[9].style.paddingLeft).toBe('8px')
    expect(directoryRows[10].style.paddingLeft).toBe('8px')
    expect(root.querySelector('.breadcrumb-picker-row.active .breadcrumb-picker-name')?.textContent?.trim()).toBe('guide')

    Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('guide'),
    )?.click()
    await flushPromises()
    await nextTick()

    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'components',
      'guide',
      'head',
      'scripts',
      'styles',
      'open-all.bat',
    ])

    const loadCountBeforeHead = loadDirectory.mock.calls.length
    const headRow = Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('head'),
    )
    headRow?.click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenCalledTimes(loadCountBeforeHead)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'components',
      'guide',
      'head',
      'header.yml',
      'scripts',
      'styles',
      'open-all.bat',
    ])
    const headRows = Array.from(root.querySelectorAll<HTMLElement>('.breadcrumb-dropdown .breadcrumb-picker-row'))
    expect(headRows[2].style.paddingLeft).toBe('8px')
    expect(headRows[3].style.paddingLeft).toBe('16px')
    expect(headRows[6].style.paddingLeft).toBe('8px')

    Object.defineProperty(crumbs[2], 'offsetLeft', {
      configurable: true,
      value: 228,
    })
    crumbs[2].click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenLastCalledWith(guidePath, true)
    expect((root.querySelector('.breadcrumb-dropdown') as HTMLElement | null)?.style.left).toBe('236px')
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'dungeon.yml',
      'guide.yml',
      'pets-bag.yml',
      'pets.yml',
      'profile.yml',
    ])
    expect((root.querySelector('.breadcrumb-dropdown .breadcrumb-picker-row') as HTMLElement | null)?.style.paddingLeft).toBe('8px')
    expect((root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-row')[1] as HTMLElement | null)?.style.paddingLeft).toBe('8px')
    expect(root.querySelector('.breadcrumb-picker-row.active .breadcrumb-picker-name')?.textContent?.trim()).toBe('guide.yml')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(root.querySelector('.breadcrumb-dropdown')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('delegates breadcrumb file selection when a scoped preview callback is provided', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const rootPath = 'D:/Project/plugins'
    const craftXPath = `${rootPath}/CraftX/function`
    const activeFilePath = `${craftXPath}/first.yml`
    const selectedFilePath = `${craftXPath}/second.yml`
    const onBreadcrumbFileOpen = vi.fn()
    store.workspace = workspace(rootPath)
    store.tabs = [tab(activeFilePath)]
    store.activeTabId = 'tab-1'
    store.directoryCache = {
      [craftXPath]: {
        path: craftXPath,
        entries: [file(activeFilePath), file(selectedFilePath)],
      },
    }
    vi.spyOn(store, 'loadDirectory').mockResolvedValue(undefined)

    const { app, root } = mountEditorPane(pinia, { onBreadcrumbFileOpen })
    await nextTick()

    const crumbs = Array.from(root.querySelectorAll<HTMLButtonElement>('.editor-breadcrumb-inner .breadcrumb-segment'))
    crumbs.at(-1)?.click()
    await flushPromises()
    Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('second.yml'),
    )?.click()
    await flushPromises()

    expect(onBreadcrumbFileOpen).toHaveBeenCalledWith(selectedFilePath)
    expect(store.activeTab?.path).toBe(activeFilePath)
    expect(root.querySelector('.breadcrumb-dropdown')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('keeps breadcrumb dropdown scroll position while expanding a directory', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const rootPath = 'D:/Project/plugins'
    const docsPath = `${rootPath}/docs`
    const headPath = `${docsPath}/head`
    store.workspace = workspace(rootPath)
    store.tabs = [tab(`${docsPath}/guide/guide.yml`)]
    store.activeTabId = 'tab-1'
    store.directoryCache = {
      [docsPath]: {
        path: docsPath,
        entries: [
          ...Array.from({ length: 20 }, (_, index) => directory(`${docsPath}/Section${String(index).padStart(2, '0')}`)),
          directory(headPath),
          file(`${docsPath}/open-all.bat`),
        ],
      },
    }
    let resolveheadLoad!: () => void
    const headLoad = new Promise<void>((resolve) => {
      resolveheadLoad = resolve
    })
    const loadDirectory = vi.spyOn(store, 'loadDirectory').mockImplementation(async (path: string) => {
      if (path === headPath) {
        await headLoad
        store.directoryCache[headPath] = {
          path: headPath,
          entries: [file(`${headPath}/header.yml`)],
        }
      }
    })

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const crumbs = Array.from(root.querySelectorAll<HTMLButtonElement>('.editor-breadcrumb-inner .breadcrumb-segment'))
    crumbs[1].click()
    await flushPromises()
    await nextTick()

    const dropdown = root.querySelector('.breadcrumb-dropdown') as HTMLElement
    dropdown.scrollTop = 144

    Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('head'),
    )?.click()
    await nextTick()

    expect(loadDirectory).toHaveBeenLastCalledWith(headPath)
    expect(dropdown.scrollTop).toBe(144)
    expect(root.querySelector('.breadcrumb-dropdown-empty')).toBeNull()
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toContain('head')

    resolveheadLoad()
    await flushPromises()
    await nextTick()

    expect(dropdown.scrollTop).toBe(144)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toContain('header.yml')

    app.unmount()
    root.remove()
  })

  it('keeps the YAML top-level panel inside the code preview and toggles it by left click', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [{
      ...tab('D:/Project/plugins/docs/guide/menu.yml'),
      content: 'title: 菜单\nlayout:\n  rows: 6\n',
    }]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const panel = root.querySelector('.editor-code-region > .yaml-top-level-panel') as HTMLElement | null
    expect(panel).not.toBeNull()
    expect(document.body.querySelector(':scope > .yaml-top-level-panel')).toBeNull()
    expect(panel!.classList.contains('collapsed')).toBe(true)
    expect(panel!.querySelector('.yaml-top-level-list')).toBeNull()

    const toggle = panel!.querySelector('.yaml-top-level-drag-handle') as HTMLButtonElement
    toggle.click()
    await nextTick()

    expect(panel!.classList.contains('collapsed')).toBe(false)
    expect(Array.from(panel!.querySelectorAll('.yaml-top-level-key')).map((item) => item.textContent?.trim())).toEqual([
      'title',
      'layout',
    ])

    toggle.click()
    await nextTick()

    expect(panel!.classList.contains('collapsed')).toBe(true)
    expect(panel!.querySelector('.yaml-top-level-list')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('drags the YAML top-level panel from the panel body', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [{
      ...tab('D:/Project/plugins/docs/guide/menu.yml'),
      content: 'title: 菜单\nlayout:\n  rows: 6\n',
    }]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const panel = root.querySelector('.editor-code-region > .yaml-top-level-panel') as HTMLElement | null
    expect(panel).not.toBeNull()

    const toggle = panel!.querySelector('.yaml-top-level-drag-handle') as HTMLButtonElement
    toggle.click()
    await nextTick()

    panel!.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 80,
    }))
    window.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 152,
      clientY: 103,
    }))
    window.dispatchEvent(new MouseEvent('pointerup', {
      bubbles: true,
      clientX: 152,
      clientY: 103,
    }))
    await nextTick()

    expect(panel!.style.transform).toBe('translate(32px, 23px)')

    app.unmount()
    root.remove()
  })
})
