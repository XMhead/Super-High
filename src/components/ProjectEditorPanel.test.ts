import { createApp, h, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorTab } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import ProjectEditorPanel from './ProjectEditorPanel.vue'

const mocks = vi.hoisted(() => ({
  manifest: {
    version: 1,
    pages: [{ id: 'docs', title: 'Docs', entry: 'docs.html', codePreviewRoot: 'docs/guide' }],
  } as Record<string, unknown>,
  pages: new Map<string, string>(),
  workspaceListener: null as ((event: any) => void) | null,
  scriptToolRunner: vi.fn(async () => ({
    toolId: 'project-task',
    title: 'Project task',
    exitCode: 0,
    stdout: 'runner-ok',
    stderr: '',
  })),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    readFile: vi.fn(async (path: string) => {
      if (path.endsWith('/editor.json')) return JSON.stringify(mocks.manifest)
      const name = path.split('/').pop() || ''
      const page = mocks.pages.get(name)
      if (page !== undefined) return page
      throw new Error(`missing ${path}`)
    }),
    listDirectory: vi.fn(async () => ({ entries: [] })),
    readMediaAsDataUrl: vi.fn(),
    writeFile: vi.fn(),
    createDirectory: vi.fn(),
    renamePath: vi.fn(),
    deletePath: vi.fn(),
    runProjectScriptTool: mocks.scriptToolRunner,
  },
  onWorkspaceFilesChanged: vi.fn(async (listener: (event: any) => void) => {
    mocks.workspaceListener = listener
    return vi.fn()
  }),
  isTauri: vi.fn(() => false),
  onProjectServiceStatus: vi.fn(async () => vi.fn()),
  onTerminalExit: vi.fn(async () => vi.fn()),
  onTerminalOutput: vi.fn(async () => vi.fn()),
}))

vi.mock('./EditorPane.vue', () => ({
  default: () => h('div', { class: 'editor-stub' }),
}))

vi.mock('./ExplorerPane.vue', () => ({
  default: (_props: unknown, { emit }: { emit: (event: string, payload: unknown) => void }) => h('button', {
    class: 'explorer-stub',
    type: 'button',
    onClick: () => emit('file-open', {
      path: 'D:/Project/docs/guide/b.yml',
      name: 'b.yml',
      type: 'file',
      extension: '.yml',
    }),
  }, 'open b'),
}))

function tab(name: string): EditorTab {
  return {
    id: name,
    path: `D:/Project/docs/guide/${name}.yml`,
    name: `${name}.yml`,
    content: `${name}:\n  type: texture\n`,
    contentType: 'text',
    language: 'yaml',
    isDirty: false,
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  await nextTick()
}

function pointerEvent(type: string, clientX = 0) {
  return new MouseEvent(type, { bubbles: true, clientX })
}

function mountPanel(pinia: ReturnType<typeof createPinia>) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(ProjectEditorPanel, { embedded: true })
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('ProjectEditorPanel compact editor layout', () => {
  let apps: App[]
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    apps = []
    ;(document as Document & { execCommand?: (command: string) => boolean }).execCommand = vi.fn(() => true)
    if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} })
    if (!globalThis.CSS.escape) globalThis.CSS.escape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
    mocks.manifest = {
      version: 1,
      pages: [{ id: 'docs', title: 'Docs', entry: 'docs.html', codePreviewRoot: 'docs/guide' }],
    }
    mocks.pages = new Map([[
      'docs.html',
      '<div id="canvas-path"></div><script>window.superhighEditor.onCodePreviewContent((path)=>{document.getElementById("canvas-path").textContent=path})</script>',
    ]])
    mocks.workspaceListener = null
    pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore(pinia)
    store.workspace = { rootPath: 'D:/Project' } as any
    store.tabs = [tab('a'), tab('b')]
    store.activeTabId = 'a'
    store.openScopedCodePreview = vi.fn(async (path: string) => {
      store.activeTabId = path.endsWith('/b.yml') ? 'b' : 'a'
      return true
    }) as any
    store.revealPathInExplorer = vi.fn(async () => undefined) as any
  })

  afterEach(() => {
    for (const app of apps) app.unmount()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('accepts an empty default registry without reporting a configuration error', async () => {
    mocks.manifest = { version: 1, pages: [] }
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()

    expect(mounted.root.textContent).toContain('尚未添加编辑器页面')
    expect(mounted.root.textContent).not.toContain('项目编辑器不可用')
    expect(mounted.root.querySelector('.project-editor-frame')).toBeNull()
  })

  it('uses explorer, Monaco, canvas order and omits the single-page refresh row', async () => {
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()

    expect(mounted.root.querySelector('.project-editor-tabs')).toBeNull()
    const body = mounted.root.querySelector('.project-editor-body')!
    expect([...body.children].map((element) => element.className)).toEqual([
      expect.stringContaining('project-editor-explorer'),
      'project-editor-resizer',
      'project-editor-code-preview',
      'project-editor-resizer',
      'project-editor-frame',
    ])
  })

  it('lets the embedded code preview shrink to half the previous minimum width', async () => {
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()
    const resizer = mounted.root.querySelectorAll<HTMLElement>('[aria-label="调整代码预览宽度"]')[0]!

    expect(resizer.getAttribute('aria-valuenow')).toBe('360')
    resizer.dispatchEvent(pointerEvent('pointerdown', 400))
    window.dispatchEvent(pointerEvent('pointermove', 0))
    window.dispatchEvent(pointerEvent('pointerup'))
    await nextTick()

    expect(resizer.getAttribute('aria-valuenow')).toBe('140')
    resizer.dispatchEvent(pointerEvent('pointerdown', 0))
    window.dispatchEvent(pointerEvent('pointermove', 120))
    window.dispatchEvent(pointerEvent('pointerup'))
    await nextTick()

    expect(resizer.getAttribute('aria-valuenow')).toBe('260')
  })

  it('keeps page tabs and an icon refresh button for multi-page editors', async () => {
    mocks.manifest = {
      version: 1,
      pages: [
        { id: 'one', title: 'One', entry: 'one.html' },
        { id: 'two', title: 'Two', entry: 'two.html' },
      ],
    }
    mocks.pages.set('one.html', '<div>one</div>')
    mocks.pages.set('two.html', '<div>two</div>')
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()

    expect(mounted.root.querySelectorAll('.project-editor-tab')).toHaveLength(2)
    const refresh = mounted.root.querySelector<HTMLButtonElement>('[aria-label="刷新页面"]')
    expect(refresh).not.toBeNull()
    expect(refresh?.textContent?.trim()).toBe('')
  })

  it('follows native resource-tree file switches in Monaco and the canvas', async () => {
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()
    const store = useWorkspaceStore()
    const frame = mounted.root.querySelector<HTMLElement>('.project-editor-frame')!

    expect(frame.shadowRoot?.querySelector('#canvas-path')?.textContent).toBe('docs/guide/a.yml')
    mounted.root.querySelector<HTMLButtonElement>('.explorer-stub')!.click()
    await settle()

    expect(store.activeTabId).toBe('b')
    expect(frame.shadowRoot?.querySelector('#canvas-path')?.textContent).toBe('docs/guide/b.yml')
  })

  it('routes embedded page script-tool requests through the runner', async () => {
    mocks.pages.set('docs.html', '<div id="runner-result"></div><script>window.superhighEditor.runScriptTool("project-task", { action: "batch-generate" }).then((result) => { document.getElementById("runner-result").textContent = result.stdout })</script>')
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()

    expect(mocks.scriptToolRunner).toHaveBeenCalledWith('D:/Project', 'project-task', { action: 'batch-generate' })
    const frame = mounted.root.querySelector<HTMLElement>('.project-editor-frame')!
    expect(frame.shadowRoot?.querySelector('#runner-result')?.textContent).toBe('runner-ok')
  })

  it('exposes browser timers to embedded pages for status polling', async () => {
    mocks.pages.set('docs.html', '<div id="timer-result"></div><script>window.setTimeout(() => { document.getElementById("timer-result").textContent = "timer-ok" }, 0)</script>')
    const mounted = mountPanel(pinia)
    apps.push(mounted.app)
    await settle()
    await new Promise((resolve) => window.setTimeout(resolve, 10))

    const frame = mounted.root.querySelector<HTMLElement>('.project-editor-frame')!
    expect(frame.shadowRoot?.querySelector('#timer-result')?.textContent).toBe('timer-ok')
  })
})
