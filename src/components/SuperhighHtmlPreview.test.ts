import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorTab } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import SuperhighHtmlPreview from './SuperhighHtmlPreview.vue'

const mocks = vi.hoisted(() => ({
  scriptToolRunner: vi.fn(async () => ({
    toolId: 'project-task',
    title: 'Project AI',
    exitCode: 0,
    stdout: 'preview-runner-ok',
    stderr: '',
  })),
}))


vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    readFile: vi.fn(async (path: string) => path.endsWith('/editor.json')
      ? JSON.stringify({ version: 1, pages: [{ id: 'project-task', entry: 'project-task-editor.html', codePreviewRoot: '.superhigh/project-task' }] })
      : ''),
    runProjectScriptTool: mocks.scriptToolRunner,
  },
  onWorkspaceFilesChanged: vi.fn(async () => vi.fn()),
}))

function tab(): EditorTab {
  return {
    id: 'project-task-editor',
    path: 'D:/Project/.superhigh/editor/project-task-editor.html',
    name: 'project-task-editor.html',
    content: '<main>Project</main>',
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
        toolId: 'project-task',
        values: { action: 'batch-generate' },
      },
      source: frame.contentWindow,
    }))
    await settle()

    expect(mocks.scriptToolRunner).toHaveBeenCalledWith('D:/Project', 'project-task', { action: 'batch-generate' })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:script-tool-result',
      requestId: 'request-1',
      result: expect.objectContaining({ stdout: 'preview-runner-ok' }),
    }), '*')
  })

})
