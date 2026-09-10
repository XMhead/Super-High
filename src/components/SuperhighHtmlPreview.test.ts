import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorTab } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'

const mocks = vi.hoisted(() => ({
  loadMainSource: vi.fn<() => Promise<'ni' | 'mm' | null>>(async () => null),
  scriptToolRunner: vi.fn(async () => ({
    toolId: 'bbmodel-ai',
    title: 'BBModel AI',
    exitCode: 0,
    stdout: 'preview-runner-ok',
    stderr: '',
  })),
}))

vi.mock('@/lib/itemLibraryConfig', () => ({
  loadProjectItemLibraryMainSource: mocks.loadMainSource,
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    readFile: vi.fn(async (path: string) => path.endsWith('/editor.json')
      ? JSON.stringify({ version: 1, pages: [{ id: 'bbmodel-ai', entry: 'bbmodel-ai-editor.html', codePreviewRoot: '.superhigh/bbmodel-ai' }] })
      : ''),
    runProjectScriptTool: mocks.scriptToolRunner,
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
    mocks.loadMainSource.mockReset()
    mocks.loadMainSource.mockResolvedValue(null)
    mocks.scriptToolRunner.mockClear()
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

  it('waits for the final preview context before creating the iframe', async () => {
    let resolveMainSource!: (source: 'mm') => void
    mocks.loadMainSource.mockImplementation(() => new Promise<'mm'>((resolve) => {
      resolveMainSource = resolve
    }))
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(SuperhighHtmlPreview, { tab: tab() })
    app.use(pinia)
    app.mount(root)
    apps.push(app)
    await nextTick()

    expect(root.querySelector('.html-preview-frame')).toBeNull()

    resolveMainSource('mm')
    await settle()

    expect(root.querySelectorAll('.html-preview-frame')).toHaveLength(1)
    expect((root.querySelector('.html-preview-frame') as HTMLIFrameElement).srcdoc).toContain('mainItemLibrarySource:"mm"')
  })
})
