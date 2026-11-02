import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EditorPane from './EditorPane.vue'
import * as yamlPreview from '@/lib/yamlPreview'
import { backend } from '@/lib/tauri'
import { openExternalLinkFromClick } from '@/lib/externalLinks'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EditorTab, FileEntry, Workspace } from '@/types'

const monacoTestState = vi.hoisted(() => ({ current: null as any }))
function withModelLifecycle(monaco: any) {
  if (!monaco || monaco.editor.createModel) return monaco
  const instance = monaco.editor.create.mock?.results.at(-1)?.value ?? monaco.editor.create()
  const model = instance.getModel() ?? {
    getValue: () => '', setValue: vi.fn(), getLineCount: () => 1, getVersionId: () => 1,
    getLineContent: () => '', getLineMaxColumn: () => 1, getValueInRange: () => '',
  }
  if (model) {
    model.getValueLength ??= () => (model.getValue.getMockImplementation?.()?.() ?? model.getValue()).length
    model.dispose ??= vi.fn()
  }
  monaco.Uri = { from: (value: any) => value }
  monaco.editor.createModel = (text: string) => {
    if (model.getValue() !== text) model.setValue(text)
    return model
  }
  instance.setModel = vi.fn()
  return monaco
}


vi.mock('@/lib/yamlSyntax.worker?worker', () => ({
  default: class {
    onmessage: ((event: { data: unknown }) => void) | null = null
    terminate() {}
    postMessage({ id, text }: { id: number; text: string }) {
      this.onmessage?.({ data: { id, issues: yamlPreview.parseYamlSyntaxIssues(text) } })
    }
  },
}))

// These integration tests exercise the preview bridge, not network font loading.
vi.mock('@/lib/fontStyles', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/fontStyles')>(),
  embeddedFontFaceCss: vi.fn(async () => ''),
}))

vi.mock('@/lib/monaco', () => ({
  MONACO_UNICODE_HIGHLIGHT: { allowedLocales: { 'zh-hans': true, 'zh-hant': true } },
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
      setTheme: vi.fn(),
      setModelMarkers: vi.fn(),
    },
    KeyCode: { KeyS: 49 },
    KeyMod: { CtrlCmd: 2048 },
    languages: {
      registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  })),
  getMonaco: vi.fn(() => withModelLifecycle(monacoTestState.current)),
}))

vi.mock('./GitDiffViewer.vue', () => ({ __esModule: true, default: {
  props: ['path', 'oldText', 'newText', 'showUnchanged'],
  template: '<div class="test-change-diff" :data-expanded="showUnchanged">{{ oldText }} → {{ newText }}</div>',
} }))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listExtensionProjectRoots: vi.fn(async (root: string) => [root]),
    resolveTerminalPath: vi.fn(async (path: string) => ({ path, isFile: true })),
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
  it('shows a tab diff, expands context and switches to current source without replacing unsaved text', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.markdownPreviewEnabled = true
    store.tabs = [{ ...tab('D:/workspace/a.md'), language: 'markdown', content: 'unsaved', isDirty: true,
      changePreview: { requestId: 'request', showingDiff: true, loading: false, oldText: 'same\nold', newText: 'same\nnew', reason: '', error: '' } }]
    store.activeTabId = 'tab-1'
    const open = vi.spyOn(store, 'openTerminalFileLink').mockImplementation(async () => {
      store.activeTab!.changePreview!.showingDiff = false
      store.activeTab!.changePreview!.sourceOnly = true
      return true
    })
    const { app, root } = mountEditorPane(pinia)
    const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!
    try {
      for (let i = 0; i < 8; i++) { await flushPromises(); await nextTick() }
      expect(root.querySelector('.test-change-diff')?.textContent).toContain('old')
      expect(root.querySelector('.monaco-host')).toBeNull()
      button('展开全部代码').click(); await nextTick()
      expect(root.querySelector('.test-change-diff')?.getAttribute('data-expanded')).toBe('true')
      button('当前源码').click(); await flushPromises(); await nextTick()
      expect(open).toHaveBeenCalledWith('D:/workspace/a.md', 2, { preserveChangePreview: true })
      expect(root.querySelector('.editor-change-preview')).toBeNull()
      expect(root.querySelector('.markdown-preview')).toBeNull()
      expect(root.querySelector('.monaco-host')).not.toBeNull()
      expect(store.activeTab?.content).toBe('unsaved')
      button('改动差异').click(); await nextTick()
      expect(root.querySelector('.editor-change-preview')).not.toBeNull()
    } finally { app.unmount(); root.remove(); open.mockRestore() }
  })

  it('keeps IUI rendering, source and diff mutually exclusive when reviewing changes', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.tabs = [{ ...tab('D:/workspace/page.shui'), language: 'plaintext', content: 'root = Text("**界面正文**")',
      changePreview: { requestId: 'ui-review', showingDiff: false, sourceOnly: false, loading: false, oldText: '', newText: 'root = Text("**界面正文**")', reason: '', error: '' } }]
    store.activeTabId = 'tab-1'
    const open = vi.spyOn(store, 'openTerminalFileLink').mockImplementation(async () => {
      Object.assign(store.activeTab!.changePreview!, { showingDiff: false, sourceOnly: true })
      return true
    })
    const { app, root } = mountEditorPane(pinia)
    const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('.change-view-toolbar button')].find(item => item.textContent?.trim() === text)!
    try {
      await nextTick()
      expect(root.querySelector('.shui-root strong')?.textContent).toBe('界面正文')
      expect(root.querySelector('.monaco-host,.editor-change-preview')).toBeNull()
      button('改动差异').click()
      for (let i = 0; i < 8; i++) { await flushPromises(); await nextTick() }
      expect(root.querySelector('.test-change-diff')).not.toBeNull()
      expect(root.querySelector('.shui-root,.monaco-host')).toBeNull()
      button('当前源码').click(); await flushPromises(); await nextTick()
      expect(root.querySelector('.monaco-host')).not.toBeNull()
      expect(root.querySelector('.shui-root,.editor-change-preview')).toBeNull()
      button('界面预览').click(); await nextTick()
      expect(root.querySelector('.shui-root strong')?.textContent).toBe('界面正文')
      expect(root.querySelector('.monaco-host,.editor-change-preview')).toBeNull()
    } finally { app.unmount(); root.remove(); open.mockRestore() }
  })

  it('opens IUI rendered even when Markdown and HTML previews are disabled', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const first = { ...tab('D:/workspace/first.shui'), language: 'plaintext', content: 'root = Text("**方案内容**")' }
    const second = { ...first, id: 'tab-2', path: 'D:/workspace/second.shui', name: 'second.shui' }
    store.tabs = [first, second]
    store.activeTabId = first.id
    store.settings.htmlPreviewEnabled = false
    store.markdownPreviewEnabled = false
    const { app, root } = mountEditorPane(pinia)
    try {
      await nextTick()
      expect(root.querySelector('.shui-root strong')?.textContent).toBe('方案内容')
      const toggle = root.querySelector<HTMLButtonElement>('.tabs-html-preview-button')!
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      toggle.click()
      await nextTick()
      expect(root.querySelector('.shui-root')).toBeNull()
      expect(store.settings.htmlPreviewEnabled).toBe(false)
      root.querySelector<HTMLButtonElement>('[aria-label="打开文件标签列表"]')!.click()
      await nextTick()
      const menu = document.body.querySelector<HTMLElement>('.tabs-open-list-menu')!
      menu.querySelectorAll<HTMLElement>('.tabs-open-list-item')[1].dispatchEvent(new MouseEvent('mouseenter'))
      await nextTick()
      expect(root.querySelector('.shui-root strong')?.textContent).toBe('方案内容')
      menu.dispatchEvent(new MouseEvent('mouseleave'))
      await nextTick()
      expect(root.querySelector('.shui-root')).toBeNull()
      expect(store.superhighUiPreviewEnabled).toBe(false)
      root.querySelector<HTMLButtonElement>('[aria-label="打开文件标签列表"]')!.click()
      store.activeTabId = second.id
      await nextTick()
      expect(root.querySelector('.shui-root strong')?.textContent).toBe('方案内容')
    } finally {
      app.unmount()
      root.remove()
    }
  })

  it('keeps saves current while coalescing large YAML analysis and refreshing navigation before jumps', async () => {
    vi.useFakeTimers()
    const parse = vi.spyOn(yamlPreview, 'parseYamlSyntaxIssues')
    const scan = vi.spyOn(yamlPreview, 'scanYamlTopLevelKeys')
    let value = Array.from({ length: 2000 }, (_, i) => `key${i}: value`).join('\n')
    let version = 1
    let change: (event: any) => void = () => undefined
    let scroll: () => void = () => undefined
    let layout: () => void = () => undefined
    let visibleStart = 1
    const model = {
      getValue: vi.fn(() => value),
      getVersionId: () => version,
      getValueInRange: vi.fn((range: { startLineNumber: number; endLineNumber: number }) =>
        value.split('\n').slice(range.startLineNumber - 1, range.endLineNumber).join('\n')),
      getLineCount: () => value.split('\n').length,
      getLineContent: (line: number) => value.split('\n')[line - 1],
      getLineMaxColumn: (line: number) => value.split('\n')[line - 1].length + 1,
      setValue: vi.fn((text: string) => { value = text; version += 1 }),
    }
    const editor = {
      addCommand: vi.fn(),
      createDecorationsCollection: vi.fn(() => ({ clear: vi.fn(), set: vi.fn() })),
      dispose: vi.fn(), getModel: () => model,
      getValue: vi.fn(() => value), getSelection: () => null,
      getVisibleRanges: () => [{ startLineNumber: Math.min(visibleStart, model.getLineCount()), endLineNumber: Math.min(visibleStart + 19, model.getLineCount()) }],
      onDidScrollChange: (listener: () => void) => { scroll = listener },
      onDidLayoutChange: (listener: () => void) => { layout = listener },
      onDidChangeModelContent: (listener: typeof change) => { change = listener },
      onDidChangeCursorSelection: vi.fn(), onMouseDown: vi.fn(),
      updateOptions: vi.fn(), restoreViewState: vi.fn(), saveViewState: () => null,
      setPosition: vi.fn(), revealLineInCenter: vi.fn(), focus: vi.fn(),
    }
    monacoTestState.current = {
      Range: class {
        constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
      },
      editor: {
        create: () => editor, defineTheme: vi.fn(), setTheme: vi.fn(),
        setModelLanguage: vi.fn(), setModelMarkers: vi.fn(),
        TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
      },
      MarkerSeverity: { Error: 8 }, KeyCode: { KeyS: 49 }, KeyMod: { CtrlCmd: 2048 },
      languages: { registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })) },
    }
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.settings.autoSave = 'off'
    store.settings.renderColorCodes = false
    store.settings.yamlKeyValuePanelEnabled = true
    store.tabs = [{ ...tab('D:/workspace/large.yml'), content: value }]
    store.activeTabId = 'tab-1'
    const { app, root } = mountEditorPane(pinia)
    try {
      await flushPromises()
      await nextTick()
      parse.mockClear()
      scan.mockClear()
      editor.getValue.mockClear()
      model.getValue.mockClear()
      for (let index = 0; index < 30; index += 1) {
        const offset = value.length
        value += 'x'
        version += 1
        change({ changes: [{ rangeOffset: offset, rangeLength: 0, text: 'x' }] })
        await nextTick()
        vi.advanceTimersByTime(20)
      }
      expect(store.tabs[0].content).toBe(value)
      expect(store.tabs[0].isDirty).toBe(true)
      expect(parse.mock.calls.length).toBe(0)
      expect(scan.mock.calls.length).toBe(0)
      expect(editor.getValue).not.toHaveBeenCalled()
      expect(model.getValue).not.toHaveBeenCalled()
      await store.saveActiveTab()
      expect(backend.writeEditorFile).toHaveBeenLastCalledWith(expect.any(String), value, expect.any(String))
      vi.advanceTimersByTime(160)
      await nextTick()
      expect(parse).toHaveBeenCalledTimes(1)
      expect(scan).toHaveBeenCalledTimes(1)

      // The visible tree still has its previous positions until the trailing task.
      value = '\n' + value
      version += 1
      change({ changes: [{ rangeOffset: 0, rangeLength: 0, text: '\n' }] })
      await nextTick()
      root.querySelector<HTMLButtonElement>('.yaml-top-level-key')!.click()
      await flushPromises()
      await nextTick()
      expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 1 })
      expect(parse).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(160)
      expect(parse).toHaveBeenCalledTimes(2)

      store.settings.renderColorCodes = true
      await nextTick()
      expect(model.getValueInRange).toHaveBeenLastCalledWith(expect.objectContaining({ startLineNumber: 1, endLineNumber: 40 }))
      visibleStart = 1000
      scroll()
      vi.advanceTimersByTime(0)
      expect(model.getValueInRange).toHaveBeenLastCalledWith(expect.objectContaining({ startLineNumber: 980, endLineNumber: 1039 }))
      visibleStart = 1500
      layout()
      vi.advanceTimersByTime(0)
      expect(model.getValueInRange).toHaveBeenLastCalledWith(expect.objectContaining({ startLineNumber: 1480, endLineNumber: 1539 }))
      expect(parse).toHaveBeenCalledTimes(2)

      // A scalar starts far above the viewport; visible lines must remain text.
      store.tabs[0].content = 'root: |\n' + Array.from({ length: 2000 }, () => '  &cred').join('\n')
      await nextTick()
      const yamlCollection = editor.createDecorationsCollection.mock.results[0].value
      const decorations = yamlCollection.set.mock.calls.at(-1)![0] as any[]
      expect(decorations.length).toBe(60)
      expect(decorations.every(item => item.options.inlineClassName === 'yaml-preview-block-text')).toBe(true)
      expect(decorations[0].range.startLineNumber).toBe(1480)

      const firstContent = value + 'x'
      version += 1
      change({ changes: [{ rangeOffset: value.length, rangeLength: 0, text: 'x' }] })
      value = firstContent
      store.tabs.push({ ...tab('D:/workspace/second.yml'), id: 'tab-2', content: 'fresh: 1' })
      store.activeTabId = 'tab-2'
      await flushPromises()
      await nextTick()
      vi.advanceTimersByTime(160)
      expect(store.tabs[0].content).toBe(firstContent)
      expect(store.tabs[1].content).toBe('fresh: 1')
      expect(parse).toHaveBeenLastCalledWith('fresh: 1')
      expect(root.querySelector('.yaml-top-level-key')?.textContent?.trim()).toBe('fresh')
    } finally {
      app.unmount()
      root.remove()
      monacoTestState.current = null
      parse.mockRestore()
      scan.mockRestore()
      vi.useRealTimers()
    }
  })

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
      const listButton = root.querySelector<HTMLButtonElement>('[aria-label="打开文件标签列表"]')!
      for (const expanded of [true, false, true, false, true]) {
        listButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        listButton.click()
        await nextTick()
        expect(listButton.getAttribute('aria-expanded')).toBe(String(expanded))
        expect(Boolean(document.body.querySelector('.tabs-open-list-menu'))).toBe(expanded)
      }
      await nextTick()
      expect(root.querySelector('.editor-breadcrumb-actions .tabs-open-list-button')).not.toBeNull()
      expect(root.querySelector('.tabs-actions .tabs-open-list-button')).toBeNull()
      expect(Array.from(document.body.querySelectorAll('.tabs-open-list-item .tab-name')).map((item) => item.textContent)).toEqual([
        first.name,
        second.name,
      ])
      expect(document.body.querySelector('.tabs-open-list-item .tree-kind-icon.yaml')).not.toBeNull()
      const secondRow = document.body.querySelectorAll<HTMLElement>('.tabs-open-list-item')[1]
      secondRow.dispatchEvent(new MouseEvent('mouseenter'))
      await nextTick()
      expect(store.activeTabId).toBe(first.id)
      expect(root.querySelector('.editor-panel.is-tab-preview')).not.toBeNull()
      expect(root.querySelector('.editor-breadcrumb-inner')?.textContent).toContain(second.name)
      document.body.querySelector('.tabs-open-list-menu')!.dispatchEvent(new MouseEvent('mouseleave'))
      await nextTick()
      expect(root.querySelector('.editor-panel.is-tab-preview')).toBeNull()
      expect(root.querySelector('.editor-breadcrumb-inner')?.textContent).toContain(first.name)
      expect(store.activeTabId).toBe(first.id)
      secondRow.querySelector<HTMLButtonElement>('.editor-tab-main')!.click()
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
      store.settings.scrollSpeedPercent = 175
      const { app, root } = mountEditorPane(pinia)
      await flushPromises()
      await nextTick()

      expect(monacoTestState.current.editor.create.mock.calls.at(-1)?.[1].mouseWheelScrollSensitivity).toBe(1.75)
      await store.setScrollSpeedPercent(250)
      await nextTick()
      expect(editor.updateOptions).toHaveBeenLastCalledWith({ mouseWheelScrollSensitivity: 2.5 })

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
  it('links only existing Markdown paths and rechecks files and directories before opening', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const source = { ...tab('D:/workspace/docs/guide.md'), language: 'markdown', content: [
      '`E:\\client files\\Gui\\地图.yml`', '`E:\\client files`', '`./missing.yml`',
      '`E:\\client files\\C# guide 100%.md`', '`./relative.yml`', '```text\nE:\\client files\\fenced.yml\n```',
    ].join('\n\n') }
    store.tabs = [source]
    store.activeTabId = source.id
    store.markdownPreviewEnabled = true
    const resolve = vi.mocked(backend.resolveTerminalPath)
    resolve.mockImplementation(async path => path.includes('missing') ? null : { path, isFile: path !== 'E:\\client files' })
    const openFile = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    const openFolder = vi.spyOn(store, 'openPath').mockResolvedValue(undefined)
    const showError = vi.spyOn(store, 'showErrorMessage')
    const { app, root } = mountEditorPane(pinia)
    try {
      await vi.waitFor(() => expect(root.querySelectorAll('.markdown-preview a')).toHaveLength(4))
      expect(root.querySelector('pre a')).toBeNull()
      const links = root.querySelectorAll<HTMLAnchorElement>('.markdown-preview a')
      links[0].click()
      links[1].click()
      links[2].click()
      links[3].click()
      await flushPromises()
      expect(openFile.mock.calls).toEqual([['E:\\client files\\Gui\\地图.yml'], ['E:\\client files\\C# guide 100%.md'], ['D:\\workspace\\docs\\relative.yml']])
      expect(openFolder).toHaveBeenCalledWith('E:\\client files')
      resolve.mockResolvedValue(null)
      openFile.mockClear()
      links[0].click()
      await flushPromises()
      expect(openFile).not.toHaveBeenCalled()
      expect(showError).toHaveBeenCalledWith(expect.stringContaining('未找到路径'))
    } finally {
      resolve.mockImplementation(async path => ({ path, isFile: true }))
      app.unmount()
      root.remove()
    }
  })
  beforeEach(() => {
    HTMLDialogElement.prototype.close = function () { this.open = false }
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
  it.each(['D:/Project', 'D:/Shared'])('runs editor HTML from %s with its runtime bridge', async (sourceRoot) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    const htmlTab = {
      ...tab(`${sourceRoot}/.superhigh/editor/items.html`),
      content: '<!doctype html><html><head></head><body><button>物品编辑器</button></body></html>',
      language: 'html',
    }
    store.workspace = workspace('D:/Project')
    vi.mocked(backend.listExtensionProjectRoots).mockResolvedValueOnce(['D:/Project', sourceRoot])
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
    expect(backend.readFile).toHaveBeenCalledWith(`${sourceRoot}/.superhigh/editor/editor.json`)


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

  it('keeps the YAML top-level panel inside the code preview and filters keys by search', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.settings.yamlKeyValuePanelEnabled = true
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
    expect(Array.from(panel!.querySelectorAll('.yaml-top-level-key')).map((item) => item.textContent?.trim())).toEqual([
      'title',
      'layout',
    ])

    store.settings.yamlKeyValueCodexColors = true
    await nextTick()
    expect(panel!.querySelector('.yaml-top-level-key')?.getAttribute('style')).toContain('--memo-title-')

    const search = panel!.querySelector('.yaml-top-level-search input') as HTMLInputElement
    search.value = 'lay'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(Array.from(panel!.querySelectorAll('.yaml-top-level-key')).map((item) => item.textContent?.trim())).toEqual([
      'layout',
    ])

    store.tabs.push({ ...tab('D:/Project/plugins/other.yml'), id: 'tab-2', content: 'layout: other\ntitle: other\n' })
    store.activeTabId = 'tab-2'
    await nextTick()
    expect((root.querySelector('.yaml-top-level-search input') as HTMLInputElement).value).toBe('lay')
    expect(Array.from(root.querySelectorAll('.yaml-top-level-key')).map(item => item.textContent?.trim())).toEqual(['layout'])
    store.activeTabId = 'tab-1'
    await nextTick()
    expect((root.querySelector('.yaml-top-level-search input') as HTMLInputElement).value).toBe('lay')

    const restoredSearch = root.querySelector('.yaml-top-level-search input') as HTMLInputElement
    restoredSearch.value = 'missing'
    restoredSearch.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(root.querySelector('.yaml-top-level-empty')?.textContent?.trim()).toBe('无匹配项')

    app.unmount()
    root.remove()
  })

  it('colors Markdown panel headings from the RGBA title palette', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.settings.yamlKeyValuePanelEnabled = true
    store.settings.markdownHeadingColorsEnabled = true
    store.workspace = workspace('D:/Project')
    store.tabs = [{
      ...tab('D:/Project/notes.md'),
      content: '## Alpha\n\n### Beta\n',
      language: 'markdown',
    }]
    store.activeTabId = 'tab-1'

    const { app, root } = mountEditorPane(pinia)
    await nextTick()

    const keys = Array.from(root.querySelectorAll('.yaml-top-level-key'))
    expect(keys.map((item) => item.textContent?.trim())).toEqual(['Alpha', 'Beta'])
    expect(keys[0].getAttribute('style')).toContain('--memo-title-')

    store.settings.markdownHeadingColorsEnabled = false
    await nextTick()
    expect(keys[0].getAttribute('style')).not.toContain('--memo-title-')

    store.settings.markdownHeadingColorsEnabled = true
    await nextTick()
    expect(keys[0].getAttribute('style')).toContain('--memo-title-')

    app.unmount()
    root.remove()
  })

  it('drags the YAML top-level panel from the drag handle', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.settings.yamlKeyValuePanelEnabled = true
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

    const handle = panel!.querySelector('.yaml-top-level-drag-handle') as HTMLElement
    handle.dispatchEvent(new MouseEvent('pointerdown', {
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


describe('editor file model lifetime', () => {
  it('keeps each file model through tab switches, then releases closed files', async () => {
    const scan = vi.spyOn(yamlPreview, 'scanYamlTopLevelKeys')
    let current: any = null
    const models: any[] = []
    const editor = {
      addCommand: vi.fn(), createDecorationsCollection: () => ({ clear() {}, set() {} }),
      dispose: vi.fn(), getModel: () => current, setModel: (model: any) => { current = model },
      getValue: () => current?.getValue() ?? '', getSelection: () => null,
      onDidChangeCursorSelection() {}, onDidChangeModelContent() {}, onMouseDown() {},
      updateOptions: vi.fn(), saveViewState: () => ({ cursorState: [], file: current?.uri }), restoreViewState: vi.fn(),
    }
    monacoTestState.current = {
      editor: {
        create: vi.fn(() => {
          let selected: any = null
          return { ...editor, getModel: () => selected, setModel: (model: any) => { selected = current = model }, getValue: () => selected?.getValue() ?? '' }
        }), defineTheme: vi.fn(), setTheme: vi.fn(), setModelLanguage() {}, setModelMarkers() {},
        createModel: vi.fn((text: string, _language: string, uri: any) => {
          let value = text
          const model = { uri, getValue: vi.fn(() => value), getValueLength: () => value.length,
            setValue: vi.fn((text: string) => { value = text }), dispose: vi.fn(),
            getVersionId: () => 1, getLineCount: () => 1, getLineContent: () => value,
            getLineMaxColumn: () => value.length + 1, getValueInRange: () => value,
          }
          models.push(model)
          return model
        }),
      },
      Uri: { from: (value: any) => value }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 1 },
      languages: { registerInlineCompletionsProvider: () => ({ dispose() {} }) },
    }
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore()
    store.settings.renderColorCodes = false
    store.settings.yamlKeyValuePanelEnabled = true
    store.tabs = [
      { ...tab('D:/workspace/a.txt'), id: 'a', language: 'yaml', content: 'A' },
      { ...tab('D:/workspace/b.txt'), id: 'b', language: 'yaml', content: 'B' },
    ]
    store.activeTabId = 'a'
    const { app, root } = mountEditorPane(pinia)
    try {
      await flushPromises(); await nextTick(); await flushPromises()
      const first = current
      expect(first.getValue()).toBe('A')
      first.getValue.mockClear()
      store.activeTabId = 'b'
      await nextTick(); await flushPromises()
      expect(current.getValue()).toBe('B')
      expect(current).not.toBe(first)
      store.activeTabId = 'a'
      await nextTick(); await flushPromises()
      expect(current).toBe(first)
      expect(first.setValue).not.toHaveBeenCalled()
      expect(first.dispose).not.toHaveBeenCalled()
      expect(scan).toHaveBeenCalledTimes(2)
      expect(monacoTestState.current.editor.defineTheme).toHaveBeenCalledOnce()
      expect(first.getValue).not.toHaveBeenCalled()
      expect(editor.restoreViewState).toHaveBeenCalledWith(expect.objectContaining({ file: first.uri }))
      const listButton = root.querySelector<HTMLButtonElement>('[aria-label="打开文件标签列表"]')!
      listButton.click()
      await nextTick()
      editor.updateOptions.mockClear()
      document.body.querySelectorAll<HTMLElement>('.tabs-open-list-item')[0].dispatchEvent(new MouseEvent('mouseenter'))
      await nextTick(); await flushPromises()
      expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: true })
      expect(current).toBe(first)
      expect(first.getValue).not.toHaveBeenCalled()
      expect(store.activeTabId).toBe('a')
      const secondRow = document.body.querySelectorAll<HTMLElement>('.tabs-open-list-item')[1]
      secondRow.dispatchEvent(new MouseEvent('mouseenter'))
      await nextTick(); await flushPromises()
      expect(store.activeTabId).toBe('a')
      expect(current).toBe(models[1])
      expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: true })
      document.body.querySelector('.tabs-open-list-menu')!.dispatchEvent(new MouseEvent('mouseleave'))
      await nextTick(); await flushPromises()
      expect(current).toBe(first)
      expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: false })
      listButton.click()
      await nextTick()
      const peer = mountEditorPane(pinia)
      await nextTick(); await flushPromises()
      expect(monacoTestState.current.editor.defineTheme).toHaveBeenCalledOnce()
      expect(monacoTestState.current.editor.setTheme).toHaveBeenCalledOnce()
      expect(models[2].uri.path).toBe(first.uri.path)
      expect(models[2].uri.authority).not.toBe(first.uri.authority)
      peer.app.unmount(); peer.root.remove()
      expect(models[2].dispose).toHaveBeenCalledOnce()
      expect(first.dispose).not.toHaveBeenCalled()
      store.tabs.splice(1, 1)
      await nextTick(); await flushPromises()
      expect(models[1].dispose).toHaveBeenCalledOnce()
      expect(first.dispose).not.toHaveBeenCalled()
      store.tabs[0].path = 'D:/workspace/renamed.yml'
      await nextTick(); await flushPromises()
      expect(current).not.toBe(first)
      expect(current.uri.path).toContain('renamed.yml')
      expect(first.dispose).toHaveBeenCalledOnce()
    } finally { app.unmount(); root.remove(); monacoTestState.current = null; scan.mockRestore() }
    expect(models[0].dispose).toHaveBeenCalledOnce()
  })
})


it('keeps a file tab open if new input arrives while save-on-close is pending', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.settings.autoSave = 'off'
  store.tabs = [{ ...tab('D:/workspace/a.txt'), content: 'A', language: 'plaintext', isDirty: true }]
  store.activeTabId = 'tab-1'
  vi.spyOn(store, 'loadDirectory').mockResolvedValue(undefined)
  let finish!: () => void
  vi.mocked(backend.writeEditorFile).mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
  const { app, root } = mountEditorPane(pinia)
  try {
    await nextTick(); await flushPromises()
    window.dispatchEvent(new CustomEvent('superhigh:editor-close-current'))
    await nextTick()
    root.querySelector<HTMLButtonElement>('.save-dialog-button.primary')!.click()
    await nextTick(); await flushPromises()
    store.updateTabContent('tab-1', 'B')
    finish()
    await flushPromises(); await nextTick(); await flushPromises()
    expect(store.tabs).toHaveLength(1)
    expect(store.tabs[0]).toMatchObject({ content: 'B', isDirty: true, lastKnownDiskContent: 'A' })
  } finally { app.unmount(); root.remove() }
})
