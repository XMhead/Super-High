import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EditorPane from './EditorPane.vue'
import { openExternalLinkFromClick } from '@/lib/externalLinks'
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
    readEditorFile: vi.fn(async (path: string) => ({
      content: path.endsWith('/.superhigh/editor/editor.json')
        ? JSON.stringify({ version: 1, pages: [{ id: 'items', entry: 'items.html', codePreviewRoot: 'plugins/Items' }] })
        : JSON.stringify({ version: 1, mainSource: 'mm' }),
      encoding: 'utf-8',
    })),
    writeEditorFile: vi.fn(async () => undefined),
    executeProjectRconCommand: vi.fn(async () => ({ output: 'ok' })),
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
  it('shows the file encoding and offers encoding-specific reopen and save actions', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.tabs = [{ ...tab('D:/workspace/restart.log'), encoding: 'gbk' }]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const encodingButton = root.querySelector<HTMLButtonElement>('.editor-encoding-button')!
    expect(encodingButton.textContent).toBe('GBK')
    encodingButton.click()
    await nextTick()
    expect(root.querySelector('.editor-encoding-menu-actions')?.textContent).toContain('重新打开')
    expect(root.querySelector('.editor-encoding-menu-actions')?.textContent).toContain('按编码保存')

    app.unmount()
    root.remove()
  })

  it('cycles between visible file tabs with A/D and arrow keys from the preview', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const first = tab('D:/workspace/first.yml')
    const second = { ...tab('D:/workspace/second.yml'), id: 'tab-2' }
    const third = { ...tab('D:/workspace/third.yml'), id: 'tab-3' }
    store.tabs = [first, second, third]
    store.activeTabId = second.id
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      const tabButton = root.querySelector<HTMLButtonElement>('.editor-tab-main')!
      tabButton.focus()
      tabButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await nextTick()
      expect(store.activeTabId).toBe(third.id)
      tabButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
      await nextTick()
      expect(store.activeTabId).toBe(second.id)
      tabButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      await nextTick()
      expect(store.activeTabId).toBe(first.id)
      tabButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
      await nextTick()
      expect(store.activeTabId).toBe(third.id)
      tabButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
      await nextTick()
      expect(store.activeTabId).toBe(first.id)
      expect(root.querySelector('[aria-label="Markdown 渲染模式"]')).toBeNull()
    } finally {
      app.unmount()
      root.remove()
    }
  })

  it('opens a list of open files and activates the selected tab', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const first = tab('D:/workspace/a-long-file-name-that-remains-complete.yml')
    const second = { ...tab('D:/workspace/second.yml'), id: 'tab-2' }
    store.tabs = [first, second]
    store.activeTabId = first.id
    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      root.querySelector<HTMLButtonElement>('[aria-label="打开文件标签列表"]')!.click()
      await nextTick()
      expect(root.querySelector('.editor-breadcrumb-actions .tabs-open-list-button')).not.toBeNull()
      expect(root.querySelector('.tabs-actions .tabs-open-list-button')).toBeNull()
      expect(Array.from(document.body.querySelectorAll('.tabs-open-list-name')).map((item) => item.textContent)).toEqual([
        first.name,
        second.name,
      ])
      expect(document.body.querySelector('.tabs-open-list-item .tree-kind-icon.data')).not.toBeNull()
      document.body.querySelectorAll<HTMLButtonElement>('.tabs-open-list-item')[1].click()
      await nextTick()
      expect(store.activeTabId).toBe(second.id)
      expect(document.body.querySelector('.tabs-open-list-menu')).toBeNull()
    } finally {
      app.unmount()
      root.remove()
    }
  })

  it('hides the encoding badge for plain UTF-8 text and offers encoding from the more menu', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.tabs = [tab('D:/workspace/notes.log')]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      expect(root.querySelector('.editor-encoding-button')).toBeNull()

      root.querySelector<HTMLButtonElement>('.tabs-more-button')!.click()
      await nextTick()
      const encodingItem = Array.from(root.querySelectorAll<HTMLButtonElement>('.tabs-more-menu .menu-item'))
        .find((item) => item.textContent?.includes('文件编码'))!
      encodingItem.click()
      await nextTick()
      expect(root.querySelector('.editor-encoding-menu')).not.toBeNull()
    } finally {
      app.unmount()
      root.remove()
    }
  })

  it('puts Markdown rendering and key-value panel toggles under one MD配置 dropdown', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.tabs = [{ ...tab('D:/workspace/readme.md'), language: 'markdown' }]
    store.activeTabId = 'tab-1'
    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      expect(root.querySelector('.editor-mode-switch')).toBeNull()
      const configButton = root.querySelector<HTMLButtonElement>('.editor-md-config-button')!
      expect(configButton).not.toBeNull()
      configButton.click()
      await nextTick()
      const items = Array.from(root.querySelectorAll<HTMLButtonElement>('.editor-md-config-item'))
      expect(items.map((item) => item.textContent?.trim())).toEqual(['渲染', '键值'])

      const before = store.markdownPreviewEnabled
      items[0].click()
      await nextTick()
      expect(store.markdownPreviewEnabled).toBe(!before)
      expect(root.querySelector('.editor-md-config-menu')).not.toBeNull()
    } finally {
      app.unmount()
      root.remove()
    }
  })

  it('preserves Markdown reading progress when switching between source and rendered modes', async () => {
    const editor = {
      addCommand: vi.fn(),
      createDecorationsCollection: vi.fn(() => ({ clear: vi.fn(), set: vi.fn() })),
      dispose: vi.fn(),
      getLayoutInfo: vi.fn(() => ({ height: 400 })),
      getModel: vi.fn(() => null),
      getScrollHeight: vi.fn(() => 1000),
      getScrollTop: vi.fn(() => 300),
      getSelection: vi.fn(() => null),
      getValue: vi.fn(() => ''),
      onDidChangeCursorSelection: vi.fn(),
      onDidChangeModelContent: vi.fn(),
      onMouseDown: vi.fn(),
      restoreViewState: vi.fn(),
      saveViewState: vi.fn(() => null),
      setScrollTop: vi.fn(),
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
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return this.classList.contains('markdown-preview') ? 1000 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return this.classList.contains('markdown-preview') ? 500 : 0 },
    })

    try {
      const pinia = createPinia()
      setActivePinia(pinia)
      const store = useWorkspaceStore()
      const markdown = {
        ...tab('D:/workspace/readme.md'),
        language: 'markdown',
        content: Array.from({ length: 60 }, (_, index) => `## Heading ${index}\n\nReading text ${index}.`).join('\n\n'),
      }
      store.tabs = [markdown]
      store.activeTabId = markdown.id
      store.markdownPreviewEnabled = false
      const { app, root } = mountEditorPane(pinia)
      await flushPromises()
      await nextTick()

      store.toggleMarkdownPreview()
      await flushPromises()
      await nextTick()
      expect((root.querySelector('.markdown-preview') as HTMLElement).scrollTop).toBe(250)

      store.toggleMarkdownPreview()
      await flushPromises()
      await nextTick()
      expect(editor.setScrollTop).toHaveBeenLastCalledWith(300)
      app.unmount()
      root.remove()
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
      else delete (HTMLElement.prototype as any).scrollHeight
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      else delete (HTMLElement.prototype as any).clientHeight
      monacoTestState.current = null
    }
  })

  it('opens Markdown file links relative to the source without sending them to the browser', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const source = tab('D:/workspace/.skillshare/skills/demo/SKILL.md')
    source.language = 'markdown'
    source.content = '[参考](references/action%20guide.md#build)\n[上级](../other.md)\n[网页](https://example.com/docs)'
    store.tabs = [source]
    store.activeTabId = source.id
    store.markdownPreviewEnabled = true
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    const openUrl = vi.fn()
    const capture = (event: MouseEvent) => { openExternalLinkFromClick(event, openUrl) }
    window.addEventListener('click', capture, true)
    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      const links = root.querySelectorAll('.markdown-preview a')
      for (const link of links) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await flushPromises()
      expect(openFile.mock.calls).toEqual([
        ['D:/workspace/.skillshare/skills/demo/references/action guide.md'],
        ['D:/workspace/.skillshare/skills/other.md'],
      ])
      expect(openUrl.mock.calls).toEqual([['https://example.com/docs']])
    } finally {
      window.removeEventListener('click', capture, true)
      app.unmount()
      root.remove()
    }
  })
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

  it('shows SuperHigh editor HTML in the code preview and switches to source', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project')
    store.tabs = [{ ...tab('D:/Project/.superhigh/editor/items.html'), content: '<main>Items</main>', language: 'html' }]
    store.activeTabId = 'tab-1'
    store.settings.htmlPreviewEnabled = true
    const { app, root } = mountEditorPane(pinia)
    try {
      await flushPromises()
      await nextTick()
      expect(root.querySelector('iframe[title="SuperHigh HTML 预览"]')).not.toBeNull()

      root.querySelector<HTMLButtonElement>('.tabs-html-preview-button')!.click()
      await nextTick()
      expect(store.settings.htmlPreviewEnabled).toBe(false)
      expect(root.querySelector('iframe[title="SuperHigh HTML 预览"]')).toBeNull()
      expect(root.querySelector('.editor-host-shell')).not.toBeNull()
    } finally {
      app.unmount()
      root.remove()
    }
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

  it('keeps the originating editor page tab visible while a scoped code preview is active', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [
      { ...tab('D:/Project/plugins/.superhigh/editor/items.html'), id: 'origin', language: 'html' },
      { ...tab('D:/Project/plugins/NeigeItems/Items/a.yml'), id: 'target' },
      { ...tab('D:/Project/plugins/Other/b.yml'), id: 'other' },
    ]
    store.activeTabId = 'target'
    store.codePreviewScopePath = 'D:/Project/plugins/NeigeItems'
    store.codePreviewOriginPath = 'D:/Project/plugins/.superhigh/editor/items.html'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    expect(Array.from(root.querySelectorAll('.editor-tab .tab-name')).map((item) => item.textContent)).toEqual(['items.html', 'a.yml'])

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
    expect(previewSrcdoc).toContain('application/x-superhigh-script')
    expect(previewSrcdoc).toContain('html-preview-bootstrap.js')

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

    window.dispatchEvent(new MessageEvent('message', {
      source: frame!.contentWindow,
      data: { type: 'superhigh-editor:rcon', requestId: 'rcon-1', command: 'list' },
    }))
    await flushPromises()

    const { backend } = await import('@/lib/tauri')
    expect(backend.executeProjectRconCommand).toHaveBeenCalledWith('D:/Project', 'list')

    app.unmount()
    root.remove()
  })

  it('shows the DragonCore quick CLI button after file actions only in Minecraft DragonCore mode', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [tab('D:/Project/plugins/DragonCore/Gui/menu.yml')]
    store.activeTabId = 'tab-1'
    store.activeWorkspaceSurface = 'project'
    store.dragonCoreModeOpen = true

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    expect(root.querySelector('[data-testid="dragoncore-quick-cli-button"]')).toBeNull()

    store.activeWorkspaceSurface = 'minecraft'
    await nextTick()

    const fileActions = root.querySelector('.tabs-more-button') as HTMLButtonElement
    const cliButton = root.querySelector('[data-testid="dragoncore-quick-cli-button"]') as HTMLButtonElement
    expect(cliButton).not.toBeNull()
    expect(fileActions.nextElementSibling).toBe(cliButton)

    const openEvents: Event[] = []
    const listener = (event: Event) => openEvents.push(event)
    window.addEventListener('superhigh:open-dragoncore-cli-dialog', listener)
    cliButton.click()
    window.removeEventListener('superhigh:open-dragoncore-cli-dialog', listener)

    expect(openEvents).toHaveLength(1)

    store.dragonCoreModeOpen = false
    await nextTick()
    expect(root.querySelector('[data-testid="dragoncore-quick-cli-button"]')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('opens a tab context menu for copying paths and adding the relative path to chat', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const filePath = 'D:/Project/plugins/DragonCore/Gui/s商店-交易行-交易/SystemShop-在线币.yml'
    const relativePath = 'DragonCore/Gui/s商店-交易行-交易/SystemShop-在线币.yml'
    store.workspace = workspace('D:/Project/plugins')
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

  it('opens the tab path itself in Explorer for files outside the active workspace', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const externalPath = 'E:\\Cli Sessions\\outside-workspace.yml'
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [tab(externalPath)]
    store.activeTabId = 'tab-1'
    const openPath = vi.spyOn(store, 'openPath').mockResolvedValue(undefined)

    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      root.querySelector('.editor-tab')?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 42,
        clientY: 24,
      }))
      await nextTick()

      ;(root.querySelector('[data-testid="tab-open-in-explorer"]') as HTMLButtonElement).click()
      await nextTick()

      expect(openPath).toHaveBeenCalledWith('E:/Cli Sessions/outside-workspace.yml')
    } finally {
      app.unmount()
      root.remove()
    }
  })

  it('uses VS Code-style sibling breadcrumb menus with tree expand and collapse', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const rootPath = 'D:/Project/plugins'
    const dragonCorePath = `${rootPath}/DragonCore`
    const guiPath = `${dragonCorePath}/Gui`
    const headTagPath = `${dragonCorePath}/HeadTag`
    const activeFilePath = `${guiPath}/魂宠仓库.yml`
    store.workspace = workspace(rootPath)
    store.tabs = [tab(activeFilePath)]
    store.activeTabId = 'tab-1'
    store.directoryCache = {
      [dragonCorePath]: {
        path: dragonCorePath,
        entries: [
          directory(`${dragonCorePath}/BlockModel`),
          directory(`${dragonCorePath}/EntityModel`),
          directory(`${dragonCorePath}/FontConfig`),
          directory(guiPath),
          directory(headTagPath),
          file(`${dragonCorePath}/打开所有yml配置的.bat`),
        ],
      },
      [guiPath]: {
        path: guiPath,
        entries: [
          file(`${guiPath}/个人属性.yml`),
          file(`${guiPath}/魂宠.yml`),
          file(`${guiPath}/魂宠背包.yml`),
          file(activeFilePath),
          file(`${guiPath}/基础副本界面.yml`),
        ],
      },
      [headTagPath]: {
        path: headTagPath,
        entries: [
          file(`${headTagPath}/头顶名称.yml`),
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
      'DragonCore',
      'Gui',
      '魂宠仓库.yml',
    ])

    crumbs[1].click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenLastCalledWith(dragonCorePath, true)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'BlockModel',
      'EntityModel',
      'FontConfig',
      'Gui',
      'HeadTag',
      '打开所有yml配置的.bat',
    ])
    expect(root.querySelector('.breadcrumb-picker-row.active .breadcrumb-picker-name')?.textContent?.trim()).toBe('Gui')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    const loadCountBeforeGui = loadDirectory.mock.calls.length
    Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('Gui'),
    )?.click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenCalledTimes(loadCountBeforeGui)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'BlockModel',
      'EntityModel',
      'FontConfig',
      'Gui',
      '个人属性.yml',
      '魂宠.yml',
      '魂宠背包.yml',
      '魂宠仓库.yml',
      '基础副本界面.yml',
      'HeadTag',
      '打开所有yml配置的.bat',
    ])
    let directoryRows = Array.from(root.querySelectorAll<HTMLElement>('.breadcrumb-dropdown .breadcrumb-picker-row'))
    expect(directoryRows[3].style.paddingLeft).toBe('8px')
    expect(directoryRows[4].style.paddingLeft).toBe('16px')
    expect(directoryRows[9].style.paddingLeft).toBe('8px')
    expect(root.querySelector('.breadcrumb-picker-row.active .breadcrumb-picker-name')?.textContent?.trim()).toBe('Gui')

    Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('Gui'),
    )?.click()
    await flushPromises()
    await nextTick()

    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'BlockModel',
      'EntityModel',
      'FontConfig',
      'Gui',
      'HeadTag',
      '打开所有yml配置的.bat',
    ])

    const loadCountBeforeHeadTag = loadDirectory.mock.calls.length
    const headTagRow = Array.from(root.querySelectorAll<HTMLButtonElement>('.breadcrumb-dropdown .breadcrumb-picker-row')).find(
      (item) => item.textContent?.includes('HeadTag'),
    )
    headTagRow?.click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenCalledTimes(loadCountBeforeHeadTag)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      'BlockModel',
      'EntityModel',
      'FontConfig',
      'Gui',
      'HeadTag',
      '头顶名称.yml',
      '打开所有yml配置的.bat',
    ])
    const headTagRows = Array.from(root.querySelectorAll<HTMLElement>('.breadcrumb-dropdown .breadcrumb-picker-row'))
    expect(headTagRows[4].style.paddingLeft).toBe('8px')
    expect(headTagRows[5].style.paddingLeft).toBe('16px')
    expect(headTagRows[6].style.paddingLeft).toBe('8px')

    Object.defineProperty(crumbs[2], 'offsetLeft', {
      configurable: true,
      value: 228,
    })
    crumbs[2].click()
    await flushPromises()
    await nextTick()

    expect(loadDirectory).toHaveBeenLastCalledWith(guiPath, true)
    expect((root.querySelector('.breadcrumb-dropdown') as HTMLElement | null)?.style.left).toBe('236px')
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toEqual([
      '个人属性.yml',
      '魂宠.yml',
      '魂宠背包.yml',
      '魂宠仓库.yml',
      '基础副本界面.yml',
    ])
    expect((root.querySelector('.breadcrumb-dropdown .breadcrumb-picker-row') as HTMLElement | null)?.style.paddingLeft).toBe('8px')
    expect((root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-row')[1] as HTMLElement | null)?.style.paddingLeft).toBe('8px')
    expect(root.querySelector('.breadcrumb-picker-row.active .breadcrumb-picker-name')?.textContent?.trim()).toBe('魂宠仓库.yml')

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
    const dragonCorePath = `${rootPath}/DragonCore`
    const headTagPath = `${dragonCorePath}/HeadTag`
    store.workspace = workspace(rootPath)
    store.tabs = [tab(`${dragonCorePath}/Gui/魂宠仓库.yml`)]
    store.activeTabId = 'tab-1'
    store.directoryCache = {
      [dragonCorePath]: {
        path: dragonCorePath,
        entries: [
          ...Array.from({ length: 20 }, (_, index) => directory(`${dragonCorePath}/Plugin${String(index).padStart(2, '0')}`)),
          directory(headTagPath),
          file(`${dragonCorePath}/打开所有yml配置的.bat`),
        ],
      },
    }
    let resolveHeadTagLoad!: () => void
    const headTagLoad = new Promise<void>((resolve) => {
      resolveHeadTagLoad = resolve
    })
    const loadDirectory = vi.spyOn(store, 'loadDirectory').mockImplementation(async (path: string) => {
      if (path === headTagPath) {
        await headTagLoad
        store.directoryCache[headTagPath] = {
          path: headTagPath,
          entries: [file(`${headTagPath}/头顶名称.yml`)],
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
      (item) => item.textContent?.includes('HeadTag'),
    )?.click()
    await nextTick()

    expect(loadDirectory).toHaveBeenLastCalledWith(headTagPath)
    expect(dropdown.scrollTop).toBe(144)
    expect(root.querySelector('.breadcrumb-dropdown-empty')).toBeNull()
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toContain('HeadTag')

    resolveHeadTagLoad()
    await flushPromises()
    await nextTick()

    expect(dropdown.scrollTop).toBe(144)
    expect(Array.from(root.querySelectorAll('.breadcrumb-dropdown .breadcrumb-picker-name')).map((item) => item.textContent?.trim())).toContain('头顶名称.yml')

    app.unmount()
    root.remove()
  })

  it('keeps the YAML top-level panel inside the code preview and toggles it by left click', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.workspace = workspace('D:/Project/plugins')
    store.tabs = [{
      ...tab('D:/Project/plugins/DragonCore/Gui/menu.yml'),
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
      ...tab('D:/Project/plugins/DragonCore/Gui/menu.yml'),
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
