import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import ScriptToolsPanel from './ScriptToolsPanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ScriptToolDescriptor } from '@/types'

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(async () => undefined), read: vi.fn(async () => '<p>Registered UI</p>') }))
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn(() => null) }))
vi.mock('@/lib/tauri', () => ({ backend: { listProjectScriptTools: mocks.list, saveSettings: mocks.save, readFile: mocks.read } }))
const tools: ScriptToolDescriptor[] = [
  { id: 'global', displayName: 'Global', scope: 'global', sourcePath: 'global.py', uiPath: 'panel.html', hidden: false, tooltip: '' },
  { id: 'project', displayName: 'Project', scope: 'project', sourcePath: 'project.py', uiPath: 'panel.html', hidden: false, tooltip: '' },
  { id: 'plain', displayName: 'Plain', scope: 'project', sourcePath: 'plain.py', uiPath: null, hidden: false, tooltip: '' },
]
const mounted: Array<() => void> = []
afterEach(() => { mounted.splice(0).forEach(cleanup => cleanup()); vi.clearAllMocks() })
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function mount(settings?: any, workspace = 'D:/Project') {
  mocks.list.mockImplementation(async (root: string) => ({ configPath: null, directories: [], tools: root === 'D:/Other' ? [tools[0]] : tools }))
  const pinia = createPinia()
  const store = useWorkspaceStore(pinia)
  store.workspace = { rootPath: workspace } as any
  if (settings) store.settings = settings
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(ScriptToolsPanel)
  app.use(pinia)
  app.mount(root)
  mounted.push(() => { app.unmount(); root.remove() })
  return { root, store, unmount: () => { app.unmount(); root.remove(); mounted.pop() } }
}
const selected = (root: HTMLElement) => root.querySelector<HTMLElement>('.script-tool-card.active')?.dataset.toolId
function click(root: HTMLElement, selector: string) { root.querySelector<HTMLElement>(selector)!.click() }

it('uses fixed source filters, selects cards, and stops path actions from changing selection', async () => {
  const { root, store } = mount()
  await settle()
  expect([...root.querySelectorAll('.script-tool-categories button')].map(button => button.textContent?.trim())).toEqual(['全部', '全局', '项目'])
  expect(selected(root)).toBe('global')
  click(root, '[data-tool-id="project"] button[title="复制完整脚本路径"]')
  expect(selected(root)).toBe('global')
  click(root, '[data-tool-id="project"]')
  await settle()
  expect(selected(root)).toBe('project')
  expect(root.querySelector('.script-tool-extension-host')).not.toBeNull()
  expect(root.querySelector('[data-tool-id="project"] .skill-kind-tag')?.classList.contains('kind-project')).toBe(true)
  expect(root.querySelector('[title="展开扩展 UI"]')).toBeNull()
  click(root, '.script-tool-categories button:nth-child(2)')
  await nextTick()
  expect(selected(root)).toBe('global')
  expect(root.querySelectorAll('[data-tool-id]')).toHaveLength(1)
  click(root, '.script-tool-categories button:nth-child(3)')
  await nextTick()
  click(root, '[data-tool-id="plain"]')
  await settle()
  expect(selected(root)).toBe('plain')
  expect(root.textContent).toContain('此脚本未登记扩展界面')
  expect(store.settings.scriptToolSelections['d:/project']).toEqual({ filter: 'project', toolId: 'plain' })
})

it('restores serialized selection after reopening and keeps workspace selections separate', async () => {
  const first = mount()
  await settle()
  click(first.root, '[data-tool-id="project"]')
  await settle()
  const saved = JSON.parse(JSON.stringify(first.store.settings))
  first.unmount()
  const second = mount(saved)
  await settle()
  expect(selected(second.root)).toBe('project')
  second.store.workspace = { rootPath: 'D:/Other' } as any
  await settle()
  expect(selected(second.root)).toBe('global')
  second.store.workspace = { rootPath: 'D:/Project' } as any
  await settle()
  expect(selected(second.root)).toBe('project')
  expect(mocks.save.mock.calls.length).toBeGreaterThan(0)
})

it('preserves the last script across an empty source and falls back when the script disappears', async () => {
  const first = mount(undefined, 'D:/Other')
  await settle()
  click(first.root, '.script-tool-categories button:nth-child(3)')
  await nextTick()
  expect(selected(first.root)).toBeUndefined()
  expect(first.root.textContent).toContain('此来源没有脚本工具')
  const saved = JSON.parse(JSON.stringify(first.store.settings))
  expect(saved.scriptToolSelections['d:/other'].toolId).toBe('global')
  first.unmount()
  const second = mount(saved, 'D:/Other')
  await settle()
  expect(selected(second.root)).toBe('global')
  expect(second.store.settings.scriptToolSelections['d:/other'].filter).toBe('all')
  second.store.settings.scriptToolSelections['d:/project'] = { filter: 'project', toolId: 'missing' }
  second.store.workspace = { rootPath: 'D:/Project' } as any
  await settle()
  expect(selected(second.root)).toBe('project')
})
