import { createApp, h, nextTick, reactive } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import CliChatControls from './CliChatControls.vue'
import type { CliChatControls as Controls } from '@/lib/tauri'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ backend: { readTerminalChatControls: mocks.read } }))
let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined
const snapshot = (): Controls => ({ provider: 'codex', model: 'model-a', effort: 'high', canSelectModel: true,
  models: [{ id: 'model-a', label: 'Model A', description: '', defaultEffort: 'medium', efforts: [{ id: 'medium', label: 'Medium', description: '' }, { id: 'high', label: 'High', description: '' }] },
    { id: 'model-b', label: 'Model B', description: '', defaultEffort: null, efforts: [] }],
  context: { usedTokens: 357400, windowTokens: 200000, inputTokens: 350000, outputTokens: 7400, cachedTokens: 175000, cacheHitRate: .5, segments: [], source: 'codex' } })
async function mount(extra: Record<string, unknown> = {}) {
  host = document.createElement('div'); document.body.append(host)
  app = createApp(CliChatControls, { sessionId: 's1', visible: true, label: '选择模型', busy: false, learnedModels: [], ...extra })
  app.mount(host)
  await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled())
  await nextTick()
}
afterEach(() => { app?.unmount(); host?.remove(); document.querySelectorAll('.chat-control-panel').forEach(panel => panel.remove()); vi.clearAllMocks(); vi.useRealTimers() })

it('opens the cached catalog on pointer down and reuses its submenu without native input', async () => {
  mocks.read.mockResolvedValue(snapshot())
  const select = vi.fn(); const fallback = vi.fn()
  await mount({ onSelect: select, onFallback: fallback })
  host!.querySelector('button')!.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  await nextTick(); await nextTick()
  const menu = document.querySelector('.chat-model-menu')!
  expect(menu.textContent).toContain('Model A')
  const row = menu.querySelector('button')!
  row.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }))
  await nextTick()
  const submenu = document.querySelector('.chat-model-submenu')!
  expect(submenu.textContent).toContain('High')
  const high = [...submenu.querySelectorAll('button')].find(button => button.textContent?.includes('High'))!
  high.click()
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'model-a' }), 'high')
  expect(fallback).not.toHaveBeenCalled()
  expect(mocks.read).toHaveBeenCalledTimes(1)
})

it('shows the native context ratio above 100% while clamping the ring and retaining cache statistics', async () => {
  mocks.read.mockResolvedValue(snapshot())
  await mount()
  host!.querySelector<HTMLButtonElement>('.chat-context-button')!.click()
  await nextTick()
  const panel = document.querySelector('.chat-context-panel')!
  expect(panel.textContent).toContain('179%')
  expect(panel.textContent).toContain('缓存命中 50%')
  expect(host!.querySelector('.context-fill')?.getAttribute('stroke-dasharray')).toBe('100 100')
})

it('checks only the current native selection when an older usage snapshot names another model', async () => {
  mocks.read.mockResolvedValue(snapshot())
  await mount({ label: 'model-b high' })
  host!.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await nextTick()
  expect([...document.querySelectorAll('.chat-model-menu [aria-selected="true"]')].map(row => row.textContent?.trim())).toEqual(['Model B'])
})

it('uses the current Claude snapshot instead of a previous terminal header, retaining explicit selections', async () => {
  mocks.read.mockResolvedValue({ ...snapshot(), provider: 'claude', model: 'claude-current', models: [], context: null })
  await mount({ label: 'gpt-old high' })
  expect(host!.querySelector('.cli-chat-model')!.textContent).toBe('claude-current')
})

it('keeps same-name native aliases distinct and selects their original numbered option', async () => {
  mocks.read.mockResolvedValue({ ...snapshot(), provider: 'claude', model: 'flash', models: [], context: null })
  const select = vi.fn()
  const learnedModels = [1, 2].map(number => ({ id: `native:${number}`, nativeNumber: number, nativeSelected: number === 2,
    label: 'flash', description: number === 1 ? 'Custom Opus model' : 'Custom Fable model', efforts: [], defaultEffort: null }))
  await mount({ label: 'flash', learnedModels, onSelect: select })
  host!.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  await nextTick()
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.chat-model-menu [role="option"]')]
  expect(rows.map(row => row.textContent?.trim())).toEqual(['flashCustom Opus model', 'flashCustom Fable model'])
  expect(rows.filter(row => row.getAttribute('aria-selected') === 'true')).toEqual([rows[1]])
  rows[1]!.click()
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'native:2', nativeNumber: 2 }), undefined)
})

it('closes an already-open native picker before opening another cached menu', async () => {
  mocks.read.mockResolvedValue(snapshot())
  const fallback = vi.fn()
  await mount({ nativeMenuOpen: true, onFallback: fallback })
  host!.querySelector<HTMLButtonElement>('.cli-chat-model')!.click()
  expect(fallback).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.chat-model-menu')).toBeNull()
})

it('discards late controls after switching the active session', async () => {
  let finish!: (value: Controls) => void
  mocks.read.mockImplementation((id: string) => id === 's1' ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ ...snapshot(), model: 'model-b', effort: null }))
  const props = reactive({ sessionId: 's1' })
  host = document.createElement('div'); document.body.append(host)
  app = createApp({ render: () => h(CliChatControls, { ...props, visible: true, label: '选择模型', busy: false, learnedModels: [] }) })
  app.mount(host)
  props.sessionId = 's2'
  await nextTick(); await nextTick()
  finish(snapshot())
  await nextTick(); await nextTick()
  expect(host.querySelector('.cli-chat-model')!.textContent).toContain('model-b')
  expect(host.querySelector('.cli-chat-model')!.textContent).not.toContain('model-a')
})
