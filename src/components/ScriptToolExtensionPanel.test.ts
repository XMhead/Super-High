import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import ScriptToolExtensionPanel from './ScriptToolExtensionPanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({ run: vi.fn(), stream: vi.fn() }))
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn(() => null) }))
vi.mock('@/lib/tauri', () => ({ backend: {
  readFile: vi.fn(async () => `<button id="go">Generate</button><pre id="result"></pre><script>
    document.getElementById('go').onclick = async () => {
      const result = await window.superhighScriptTool.runStreaming({count:20}, event => {
        document.getElementById('result').textContent += event.chunk;
      });
      document.getElementById('result').dataset.exitCode = result.exitCode;
    };
  </script>`),
  runProjectScriptTool: mocks.run,
  runProjectScriptToolStreaming: mocks.stream,
} }))

it('renders progress while execution is pending and retains the final result', async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  let complete!: (value: unknown) => void
  mocks.stream.mockImplementation((_root, _id, _values, progress) => {
    progress({ stream: 'stderr', chunk: '10/20\n' })
    return new Promise(resolve => { complete = resolve })
  })
  const pinia = createPinia()
  useWorkspaceStore(pinia).workspace = { rootPath: 'D:/Project' } as any
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(ScriptToolExtensionPanel, { tool: { id: 'overview', uiPath: 'tool.html', displayName: 'Overview' } as any })
  app.use(pinia)
  try {
    app.mount(root)
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    const shadow = root.querySelector('.script-tool-extension-host')!.shadowRoot!
    shadow.querySelector<HTMLButtonElement>('#go')!.click()
    expect(shadow.querySelector('#result')!.textContent).toBe('10/20\n')
    expect(mocks.stream).toHaveBeenCalledWith('D:/Project', 'overview', { count: '20' }, expect.any(Function))
    complete({ exitCode: 0 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shadow.querySelector<HTMLElement>('#result')!.dataset.exitCode).toBe('0')
    expect(mocks.run).not.toHaveBeenCalled()
  } finally { app.unmount(); root.remove(); vi.unstubAllGlobals() }
})
