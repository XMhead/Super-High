import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorTab } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import { embeddedFontFaceCss } from '@/lib/fontStyles'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'
import { requestMobileHtml } from '@/lib/mobileHtmlBridge'

const mocks = vi.hoisted(() => ({
  scriptToolList: vi.fn(async () => ({ tools: [{ id: 'internal', hidden: true, output: { format: 'json' } }] })),
  codePreviewRoot: '.superhigh/bbmodel-ai',
  scriptToolRunner: vi.fn(async () => ({
    toolId: 'bbmodel-ai',
    title: 'BBModel AI',
    exitCode: 0,
    stdout: 'preview-runner-ok',
    stderr: '',
  })),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
}))

vi.mock('@/lib/fontStyles', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/fontStyles')>(),
  embeddedFontFaceCss: vi.fn(async () => '@font-face{font-family:"Preview Font";src:url("data:font/woff2;base64,AA==")}'),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    readFile: vi.fn(async (path: string) => path.endsWith('/editor.json')
      ? JSON.stringify({ version: 1, pages: [{ id: 'bbmodel-ai', entry: 'bbmodel-ai-editor.html', codePreviewRoot: mocks.codePreviewRoot }] })
      : ''),
    runProjectScriptTool: mocks.scriptToolRunner,
    listProjectScriptTools: mocks.scriptToolList,
  },
  onWorkspaceFilesChanged: vi.fn(async () => vi.fn()),
}))

function tab(): EditorTab {
  return {
    id: 'bbmodel-ai-editor',
    path: 'D:/Project/.superhigh/editor/bbmodel-ai-editor.html',
    name: 'bbmodel-ai-editor.html',
    content: '<main>BBModel</main>',
    contentType: 'text',
    language: 'html',
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

describe('SuperhighHtmlPreview script-tool bridge', () => {
  let apps: App[]
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    apps = []
    mocks.scriptToolRunner.mockClear()
    vi.mocked(embeddedFontFaceCss).mockClear()
    mocks.codePreviewRoot = '.superhigh/bbmodel-ai'
    pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceStore(pinia)
    store.workspace = { rootPath: 'D:/Project' } as any
  })

  afterEach(() => {
    for (const app of apps) app.unmount()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('shares the initialized document and bound content without remounting the desktop iframe', async () => {
    const store = useWorkspaceStore(pinia)
    const origin = tab()
    store.tabs = [origin, { ...origin, id: 'bound', path: 'D:/Project/.superhigh/bbmodel-ai/model.json', content: '{"current":true}', isDirty: true }]
    store.projectEditorBindings[origin.path.toLowerCase()] = { path: store.tabs[1].path, rootPath: 'D:/Project/.superhigh/bbmodel-ai' } as any
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp(SuperhighHtmlPreview, { tab: origin })
    app.use(pinia); app.mount(root); apps.push(app)
    await settle()
    const originalFrame = root.querySelector('iframe')
    const shared = await requestMobileHtml({ path: origin.path, operation: 'html-document' }) as { document: string; contextMessages: unknown[] }
    await settle()
    expect(root.querySelector('iframe')).toBe(originalFrame)
    expect(shared.document).toContain('/mobile/html-preview-bootstrap.js')
    expect(shared.contextMessages).toContainEqual({ type: 'superhigh-editor:code-preview-content', path: '.superhigh/bbmodel-ai/model.json', content: '{"current":true}', isDirty: true })
  })

  it('embeds font resources and role weights in the sandbox document, including after a font change', async () => {
    const store = useWorkspaceStore(pinia)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()

    const previewDocument = new DOMParser().parseFromString(root.querySelector<HTMLIFrameElement>('iframe')!.srcdoc, 'text/html')
    expect(previewDocument.querySelector('#superhigh-editor-fonts')?.textContent).toContain('data:font/woff2;base64,AA==')
    expect(previewDocument.querySelector('#superhigh-editor-base')?.textContent).toContain('html{font-family:var(--font-ui);font-weight:var(--font-ui-weight)}')
    expect(previewDocument.querySelector('#superhigh-editor-base')?.textContent).toContain('font-weight:var(--font-mono-weight)')

    vi.mocked(embeddedFontFaceCss).mockResolvedValueOnce('@font-face{font-family:"Imported Font";src:url("data:font/woff2;base64,AQ==")}')
    store.settings.fontStyleId = 'imported'
    await settle()
    expect(embeddedFontFaceCss).toHaveBeenLastCalledWith('imported', store.settings.customFonts, store.settings.customFontStyles)
    expect(root.querySelector<HTMLIFrameElement>('iframe')!.srcdoc).toContain('Imported Font')
  })

  it('accepts explorer toggles only from its own iframe', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()
    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')!
    const listener = vi.fn()
    window.addEventListener('superhigh:toggle-explorer', listener)
    try {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'superhigh-editor:toggle-explorer' }, source: window }))
      expect(listener).not.toHaveBeenCalled()
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'superhigh-editor:toggle-explorer' }, source: frame.contentWindow }))
      expect(listener).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('superhigh:toggle-explorer', listener)
    }
  })

  it('routes iframe script-tool requests through the runner and posts the result back', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()

    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')!
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'superhigh-editor:script-tool',
        requestId: 'request-1',
        toolId: 'bbmodel-ai',
        values: { action: 'batch-generate' },
      },
      source: frame.contentWindow,
    }))
    await settle()

    expect(mocks.scriptToolRunner).toHaveBeenCalledWith('D:/Project', 'bbmodel-ai', { action: 'batch-generate' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:script-tool-result',
      requestId: 'request-1',
      result: expect.objectContaining({ stdout: 'preview-runner-ok' }),
    }), '*')
  })

  it('discovers hidden tool contracts from its own iframe', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()
    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')!
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'superhigh-editor:script-tools', requestId: 'catalog',
    }, source: frame.contentWindow }))
    await settle()
    expect(mocks.scriptToolList).toHaveBeenCalledWith('D:/Project', true)
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:script-tools-result', requestId: 'catalog',
      result: { tools: [{ id: 'internal', hidden: true, output: { format: 'json' } }] },
    }), '*')
  })

  it('waits for the final preview context before creating the iframe', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await nextTick()

    expect(root.querySelector('.html-preview-frame')).toBeNull()

    await settle()

    expect(root.querySelectorAll('.html-preview-frame')).toHaveLength(1)
    expect((root.querySelector('.html-preview-frame') as HTMLIFrameElement).srcdoc).toContain('/html-preview-bootstrap.js')
    expect((root.querySelector('.html-preview-frame') as HTMLIFrameElement).srcdoc).toContain('superhigh-editor:resource')
    expect(root.querySelector('.html-preview-frame')?.getAttribute('sandbox')).toContain('allow-downloads')
    expect(root.querySelector('.html-preview-frame')?.getAttribute('sandbox')).toContain('allow-modals')
  })

  it('waits for the workspace before creating a bridge that can serve requests', async () => {
    const store = useWorkspaceStore(pinia)
    store.workspace = null as any
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()

    expect(root.querySelector('.html-preview-frame')).toBeNull()

    store.workspace = { rootPath: 'D:/Project' } as any
    await settle()

    expect(root.querySelectorAll('.html-preview-frame')).toHaveLength(1)
  })

  it('treats codePreviewRoot "." as the whole workspace and keeps the editor tab as origin', async () => {
    mocks.codePreviewRoot = '.'
    const store = useWorkspaceStore(pinia)
    const openScoped = vi.spyOn(store, 'openScopedCodePreview').mockResolvedValue(true)
    vi.spyOn(store, 'revealPathInExplorer').mockResolvedValue(undefined as any)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()

    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')!
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'superhigh-editor:code-preview', requestId: 'jump-1', path: 'MythicMobs/Items/a.yml', lineNumber: 12 },
      source: frame.contentWindow,
    }))
    await settle()

    expect(openScoped).toHaveBeenCalledWith('D:/Project/MythicMobs/Items/a.yml', 'D:/Project', {
      keepWorkspaceSurface: true,
      originPath: 'D:/Project/.superhigh/editor/bbmodel-ai-editor.html',
    })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'superhigh-editor:code-preview-result', requestId: 'jump-1' }), '*')
  })

  it('binds without navigating and forwards selected content, dirty edits, and remount context', async () => {
    const store = useWorkspaceStore(pinia)
    const config = { ...tab(), id: 'config', path: 'D:/Project/.superhigh/bbmodel-ai/a.json', content: '{"saved":true}' }
    store.tabs = [tab(), config]
    store.activeTabId = tab().id
    vi.spyOn(store, 'revealPathInExplorer').mockResolvedValue(undefined as any)
    vi.spyOn(store, 'recordFileOpen').mockImplementation(() => undefined)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()
    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')!
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'superhigh-editor:code-preview-bind', requestId: 'bind-1', path: '.superhigh/bbmodel-ai/a.json' },
      source: frame.contentWindow,
    }))
    await settle()
    expect(store.activeTabId).toBe(tab().id)
    expect(postMessage).toHaveBeenCalledWith({ type: 'superhigh-editor:code-preview-content', path: '.superhigh/bbmodel-ai/a.json', content: '{"saved":true}', isDirty: false }, '*')
    store.tabs[1]!.content = '{"draft":true}'
    store.tabs[1]!.isDirty = true
    await settle()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'superhigh-editor:code-preview-content', content: '{"draft":true}', isDirty: true }), '*')
    postMessage.mockClear()
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'superhigh-editor:preview-ready' }, source: frame.contentWindow }))
    await settle()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'superhigh-editor:code-preview-content', content: '{"draft":true}', isDirty: true }), '*')
  })

  it('still rejects paths outside a sub-directory codePreviewRoot', async () => {
    const store = useWorkspaceStore(pinia)
    const openScoped = vi.spyOn(store, 'openScopedCodePreview').mockResolvedValue(true)
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await settle()

    const frame = root.querySelector<HTMLIFrameElement>('.html-preview-frame')!
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'superhigh-editor:code-preview', requestId: 'jump-2', path: 'MythicMobs/Items/a.yml' },
      source: frame.contentWindow,
    }))
    await settle()

    expect(openScoped).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'superhigh-editor:code-preview-error', requestId: 'jump-2' }), '*')
  })
})
