import { createApp, h, nextTick, reactive } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import CliChatChanges from './CliChatChanges.vue'
import type { CliChatTurn } from '@/lib/tauri'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), openChange: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => ({ openTerminalFileLink: mocks.open, openChatChangePreview: mocks.openChange }) }))
vi.mock('./GitDiffViewer.vue', () => ({ default: { props: ['oldText', 'newText'], template: '<div class="diff-stub">{{ oldText }} → {{ newText }}</div>' } }))
let app: ReturnType<typeof createApp> | undefined
let host: HTMLElement | undefined
afterEach(() => { app?.unmount(); host?.remove(); localStorage.clear(); vi.clearAllMocks() })
const turn = { id: 't', changes: [{ path: 'src/a.ts', kind: 'update', hunks: [{ before: 'old', after: 'new' }], added: 1, removed: 1, supported: true }] } as CliChatTurn
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick() }
function mount() {
  const state = reactive({ session: { id: 'one', cwd: 'D:/one' }, turns: [turn] })
  host = document.createElement('div'); document.body.append(host)
  app = createApp({ setup: () => () => h(CliChatChanges, state) }); app.mount(host)
  return state
}
function button(text: string) { return [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text)! }

it('keeps native changes locally without modifying files or losing per-turn totals', async () => {
  const state = mount()
  button('全部保留').click(); await nextTick()
  expect(host!.querySelector('.chat-changes')).toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem('superhigh.chat-changes.one')!)).toEqual(['t:0'])
  state.turns = [{ ...turn, changes: [...turn.changes!, { ...turn.changes![0], path: 'b.ts' }] }]
  await nextTick()
  expect(host!.textContent).toContain('1 个文件')
})

it('opens changed files in the shared code preview without a chat overlay', async () => {
  mount()
  host!.querySelector<HTMLButtonElement>('.changes-title')!.click(); await nextTick()
  button('a.ts').click(); await flush()
  expect(mocks.openChange).toHaveBeenCalledWith('D:/one/src/a.ts', 'D:/one', turn.changes)
  expect(document.querySelector('.changes-overlay')).toBeNull()
  expect(host!.textContent).toContain('全部保留')
  expect(host!.textContent).toContain('全部撤销')
})

it('does not apply a preview or continue undo after the user switches sessions', async () => {
  let finish!: (result: object) => void
  mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const state = mount()
  button('全部撤销').click(); await flush()
  expect(mocks.invoke).toHaveBeenCalledWith('chat_edit_preview_command', expect.objectContaining({ cwd: 'D:/one' }))
  state.session = { id: 'two', cwd: 'D:/two' }; await nextTick()
  finish({ oldText: 'old', newText: 'new', canUndo: true, reason: '' }); await flush()
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem('superhigh.chat-changes.two')).toBeNull()
  expect(host!.textContent).toContain('1 个文件')
})
