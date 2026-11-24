import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SuperhighUiEditor from './SuperhighUiEditor.vue'

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => ({ workspace: { rootPath: 'D:/project' } }) }))
vi.mock('@/lib/tauri', () => ({ backend: { readFile: vi.fn(async () => '<p>editor</p>') } }))
vi.mock('./SuperhighHtmlPreview.vue', () => ({ default: { template: '<div>editor</div>' } }))

const mounted: Array<{ unmount(): void; root: HTMLElement }> = []
afterEach(() => { for (const entry of mounted.splice(0)) { entry.unmount(); entry.root.remove() } })
function mount(src: string) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(SuperhighUiEditor, { src })
  app.mount(root)
  mounted.push({ unmount: () => app.unmount(), root })
  return root
}

describe('IUI editor mobile live preview', () => {
  it('embeds the fixed local mobile preview with its own origin', () => {
    const frame = mount('http://127.0.0.1:1421/').querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe('http://127.0.0.1:1421/')
    expect(frame?.hasAttribute('sandbox')).toBe(false)
  })
  it('rejects other external addresses', async () => {
    const root = mount('http://127.0.0.1:1422/')
    await nextTick()
    expect(root.querySelector('iframe')).toBeNull()
    expect(root.textContent).toContain('Editor.src')
  })
})
