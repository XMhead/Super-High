import { createApp, defineComponent, h, nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import PreviewPane from './PreviewPane.vue'
import type { AgentTurnChanges, AgentFileDiff } from '@/types'

const mocks = vi.hoisted(() => ({ query: vi.fn(), diff: vi.fn(), listen: vi.fn(), openFile: vi.fn(), highlight: vi.fn(), editorMounts: 0, store: null as any }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => mocks.store }))
vi.mock('@/lib/tauri', () => ({ backend: { getAgentTurnChanges: mocks.query, getAgentTurnFileDiff: mocks.diff }, onAgentTurnChanges: mocks.listen }))
vi.mock('@/lib/codeHighlight', () => ({
  escapeCode: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  highlightCode: mocks.highlight,
}))
vi.mock('./EditorPane.vue', () => ({ default: defineComponent({ setup() { mocks.editorMounts++; return () => h('section', { class: 'editor-panel', 'data-testid': 'editor' }, [h('input', { value: 'dirty buffer' })]) } }) }))
vi.mock('./TerminalPane.vue', () => ({ default: defineComponent({ render: () => h('section', { 'data-testid': 'terminal' }) }) }))
vi.mock('./CliTerminalGrid.vue', () => ({ default: defineComponent({ render: () => h('section', { 'data-testid': 'terminal-grid' }) }) }))
const snapshot: AgentTurnChanges = { sessionId: 's1', providerKind: 'codex', nativeSessionId: 'native1', turnId: 't1', revision: 1, available: true, reason: null, completed: true, additions: 2, deletions: 1, files: [
  { path: 'src/a.ts', absolutePath: 'D:/Demo/src/a.ts', oldPath: null, status: 'modified', additions: 1, deletions: 1 },
  { path: 'src/a.test.ts', absolutePath: 'D:/Demo/src/a.test.ts', oldPath: null, status: 'added', additions: 1, deletions: 0 },
] }
const fileDiff: AgentFileDiff = { sessionId: 's1', turnId: 't1', revision: 1, available: true, reason: null, file: snapshot.files[0], rows: [
  { kind: 'context', oldLine: 1, newLine: 1, text: 'same' }, { kind: 'del', oldLine: 2, text: 'before' }, { kind: 'add', newLine: 2, text: 'after' },
] }
let handler: (value: AgentTurnChanges) => void
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
function mount() { const host = document.createElement('div'); document.body.append(host); const app = createApp(PreviewPane); app.mount(host); return { host, app } }
function click(host: HTMLElement, selector: string) { (host.querySelector(selector) as HTMLElement).click() }
async function openDiff(host: HTMLElement) { click(host, '.previewchanges-summary button'); await nextTick(); click(host, '.previewchanges-file button'); await flush() }

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.editorMounts = 0
  mocks.highlight.mockReset().mockImplementation(async (text: string) => `<span class="hljs-keyword">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`)
  mocks.store = reactive({ settings: { activePreviewMode: 'code', multiTerminalMode: false }, workspace: { rootPath: 'D:/Demo' }, activeCliTerminalSession: { id: 's1', cwd: 'D:/Demo', providerKind: 'codex' }, openTerminalFileLink: mocks.openFile })
  mocks.openFile.mockReset().mockResolvedValue(undefined)
  mocks.query.mockReset().mockResolvedValue(snapshot)
  mocks.diff.mockReset().mockResolvedValue(fileDiff)
  mocks.listen.mockReset().mockImplementation(async (callback) => { handler = callback; return () => {} })
})
describe('preview tool changes', () => {
  it('opens only by user action and keeps one editor instance and every file', async () => {
    const { host, app } = mount(); await flush()
    expect(host.querySelector('.previewchanges-viewer')).toBeNull()
    click(host, '.previewchanges-summary button'); await nextTick()
    expect(host.querySelectorAll('.previewchanges-file')).toHaveLength(2)
    click(host, '.previewchanges-file button'); await flush()
    const editor = host.querySelector('[data-testid="editor"]') as HTMLElement
    expect(editor.style.display).toBe('none')
    click(host, '[aria-label="返回文件预览"]'); await flush()
    expect(editor.style.display).not.toBe('none')
    expect((editor.querySelector('input') as HTMLInputElement).value).toBe('dirty buffer')
    expect(mocks.editorMounts).toBe(1)
    app.unmount()
  })
  it('keeps file tabs fixed above one diff and switches by tab', async () => {
    mocks.diff.mockImplementation(async (_session: string, _turn: string, path: string) => ({ ...fileDiff, file: snapshot.files.find(file => file.path === path)!, rows: [{ kind: 'add', newLine: 1, text: `body of ${path}` }] }))
    const { host, app } = mount(); await flush(); await openDiff(host)
    const viewer = host.querySelector('.previewchanges-viewer') as HTMLElement
    expect(viewer.querySelector(':scope > .tabs-strip .editor-tabs-list')).not.toBeNull()
    expect(host.querySelector('.previewchanges-scroll .editor-tabs-list')).toBeNull()
    expect([...viewer.querySelectorAll('.tab-name')].map(tab => tab.textContent)).toEqual(['a.ts', 'a.test.ts'])
    expect(viewer.querySelectorAll('.tree-kind-icon.code')).toHaveLength(2)
    expect(host.querySelectorAll('.previewchanges-file-section')).toHaveLength(1)
    expect(host.querySelector('.previewchanges-scroll')!.textContent).toContain('body of src/a.ts')
    ;(host.querySelectorAll('.editor-tab-main')[1] as HTMLElement).click(); await flush()
    expect(host.querySelectorAll('.previewchanges-file-section')).toHaveLength(1)
    expect(host.querySelector('.previewchanges-scroll')!.textContent).toContain('body of src/a.test.ts')
    expect(host.querySelector('.editor-tab.active .editor-tab-main')!.getAttribute('title')).toBe('src/a.test.ts (+1 -0)')
    expect(host.querySelector('.previewchanges-viewer')).not.toBeNull()
    expect((host.querySelector('[data-testid="editor"]') as HTMLElement).style.display).toBe('none')
    expect(mocks.openFile).not.toHaveBeenCalled()
    app.unmount()
  })
  it('closes and reopens diff tabs without changing turn totals or the editor buffer', async () => {
    const { host, app } = mount(); await flush(); await openDiff(host)
    click(host, '.tab-close'); await flush()
    expect(host.querySelector('.editor-tab.active .tab-name')!.textContent).toBe('a.test.ts')
    expect(host.querySelector('.previewchanges-title')!.textContent).toBe('2 个文件变更 +2 -1')
    expect(host.querySelector('.previewchanges-summary')!.textContent).toBe('2 个文件+2-1')
    click(host, '.previewchanges-summary button'); await nextTick()
    click(host, '.previewchanges-file button'); await flush()
    expect(host.querySelectorAll('.editor-tab')).toHaveLength(2)
    expect(host.querySelector('.editor-tab.active .tab-name')!.textContent).toBe('a.ts')
    host.querySelector('.editor-tab.active .editor-tab-main')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flush()
    expect(host.querySelector('.editor-tab.active .tab-name')!.textContent).toBe('a.test.ts')
    click(host, '.tab-close'); await flush()
    click(host, '.tab-close'); await flush()
    expect(host.querySelector('.previewchanges-viewer')).toBeNull()
    expect((host.querySelector('[data-testid="editor"] input') as HTMLInputElement).value).toBe('dirty buffer')
    expect(mocks.editorMounts).toBe(1)
    app.unmount()
  })
  it('reloads revision changes even when all counts match', async () => {
    const { host, app } = mount(); await flush(); await openDiff(host)
    mocks.diff.mockResolvedValue({ ...fileDiff, revision: 2, rows: [{ kind: 'add', newLine: 2, text: 'new revision' }] })
    handler({ ...snapshot, revision: 2 }); await flush()
    expect(mocks.diff).toHaveBeenCalledTimes(4)
    expect(host.textContent).toContain('new revision')
    app.unmount()
  })
  it('clears the previous turn and rejects its late diff', async () => {
    const { host, app } = mount(); await flush()
    let resolve!: (value: AgentFileDiff) => void
    mocks.diff.mockImplementation(() => new Promise(r => { resolve = r }))
    click(host, '.previewchanges-summary .previewchanges-add'); await flush()
    handler({ ...snapshot, turnId: 't2', revision: 2, files: [], additions: 0, deletions: 0 }); await flush()
    resolve(fileDiff); await flush()
    expect(host.textContent).toContain('本轮暂无改动')
    expect(host.textContent).not.toContain('before')
    expect(host.querySelector('.previewchanges-anchor')).toBeNull()
    app.unmount()
  })
  it('rejects late data after changing sessions and workspaces', async () => {
    let resolve!: (value: AgentTurnChanges) => void
    mocks.query.mockImplementation(() => new Promise(r => { resolve = r }))
    const { host, app } = mount(); await flush()
    mocks.store.activeCliTerminalSession = null; mocks.store.workspace.rootPath = 'D:/Other'; await flush()
    resolve(snapshot); handler(snapshot); await flush()
    expect(host.querySelector('.previewchanges-anchor')).toBeNull()
    app.unmount()
  })
  it('keeps diff reading in change mode when code or line numbers are clicked', async () => {
    const { host, app } = mount(); await flush(); await openDiff(host)
    click(host, '.previewchanges-row.del'); await flush()
    click(host, '.previewchanges-row.add .previewchanges-code'); await flush()
    click(host, '.previewchanges-row .previewchanges-line'); await flush()
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(host.querySelector('.previewchanges-viewer')).not.toBeNull()
    expect(host.querySelector('button.previewchanges-row')).toBeNull()
    expect((host.querySelector('[data-testid="editor"]') as HTMLElement).style.display).toBe('none')
    app.unmount()
  })
  it('does not open deleted files and count buttons locate the matching hunk', async () => {
    const scroll = vi.fn(); HTMLElement.prototype.scrollIntoView = scroll
    mocks.query.mockResolvedValue({ ...snapshot, files: [{ ...snapshot.files[0], status: 'deleted' }] })
    const { host, app } = mount(); await flush()
    click(host, '.previewchanges-summary .previewchanges-del'); await flush()
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(host.querySelector('button.previewchanges-row')).toBeNull()
    click(host, '.previewchanges-row.del'); await flush()
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(host.querySelector('.previewchanges-viewer')).not.toBeNull()
    app.unmount()
  })
  it('keeps changes out of local and grid terminals and removes the legacy terminal overlay', async () => {
    mocks.store.settings.activePreviewMode = 'terminal'
    const { host, app } = mount(); await flush()
    expect(host.querySelector('[data-testid="terminal"]')).not.toBeNull()
    expect(host.querySelector('.previewchanges')).toBeNull()
    mocks.store.settings.multiTerminalMode = true; await flush()
    expect(host.querySelector('[data-testid="terminal-grid"]')).not.toBeNull()
    expect(host.querySelector('.previewchanges')).toBeNull()
    expect(readFileSync('src/components/TerminalPane.vue', 'utf8')).not.toContain('CliChangesPanel')
    const css = readFileSync('src/styles.css', 'utf8')
    expect(css).toContain('.previewchanges-region { position: relative;')
    expect(css).toContain('width: min(420px, calc(100cqw - 12px))')
    app.unmount()
  })
  it('uses one source line column and rejects stale asynchronous syntax colour', async () => {
    const finishes: Array<(value: string) => void> = []
    mocks.highlight.mockImplementation(() => new Promise(resolve => { finishes.push(resolve) }))
    const { host, app } = mount(); await flush(); await openDiff(host)
    expect(host.querySelector('.previewchanges-row.del .previewchanges-line')?.textContent).toBe('2')
    expect(host.querySelectorAll('[data-path="src/a.ts"] .previewchanges-row.del .previewchanges-line')).toHaveLength(1)
    mocks.highlight.mockResolvedValue('<span class="hljs-keyword">fresh</span>')
    mocks.diff.mockResolvedValue({ ...fileDiff, revision: 2, rows: [{ kind: 'add', newLine: 2, text: '<script>unsafe</script>' }] })
    handler({ ...snapshot, revision: 2 }); await flush()
    finishes.forEach(finish => finish('<span class="hljs-keyword">old colour</span>')); await flush()
    expect(host.querySelector('.previewchanges-code .hljs-keyword')?.textContent).toBe('fresh')
    expect(host.textContent).not.toContain('old colour')
    expect(host.querySelector('.previewchanges-code script')).toBeNull()
    app.unmount()
  })
  it('closes only the anchored popup on Esc and on outside pointer input', async () => {
    const { host, app } = mount(); await flush()
    click(host, '.previewchanges-summary button'); await flush()
    host.querySelector('.previewchanges-summary button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(host.querySelector('.previewchanges-list')).toBeNull()
    expect(host.querySelector('.previewchanges-viewer')).toBeNull()
    expect((host.querySelector('[data-testid="editor"]') as HTMLElement).style.display).not.toBe('none')
    click(host, '.previewchanges-summary button'); await flush()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await flush()
    expect(host.querySelector('.previewchanges-list')).toBeNull()
    app.unmount()
  })

})
