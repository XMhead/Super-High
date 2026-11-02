import { createApp, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AutomationTasksPanel from './AutomationTasksPanel.vue'
import type { AutomationTask } from '@/lib/automation'

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), confirm: vi.fn() }))
const workspace = reactive({ workspace: { rootPath: 'D:/sample' } as { rootPath: string } | null })
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => workspace }))
vi.mock('@/lib/tauri', () => ({ backend: { listAutomationTasks: mocks.list, saveAutomationTask: mocks.save, deleteAutomationTask: mocks.remove } }))
vi.mock('@/lib/appDialog', () => ({ appConfirm: mocks.confirm }))

const power: AutomationTask = { id: 'power', scope: 'system', title: '电源任务', enabled: false, schedule: { kind: 'daily', time: '23:00' }, action: { kind: 'shutdown' } }
let host: HTMLDivElement
let app: ReturnType<typeof createApp>
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)! }
async function fill(selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(selector)!
  element.value = value
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await nextTick()
}
beforeEach(async () => {
  vi.clearAllMocks()
  workspace.workspace = { rootPath: 'D:/sample' }
  mocks.list.mockResolvedValue([power])
  mocks.save.mockImplementation(async task => task)
  mocks.confirm.mockResolvedValue(true)
  host = document.createElement('div'); document.body.append(host)
  app = createApp(AutomationTasksPanel); app.mount(host)
  await vi.waitFor(() => expect(host.textContent).toContain('电源任务'))
})
afterEach(() => { app.unmount(); host.remove() })

it('saves the reviewed project task without running a command', async () => {
  button('新建').click(); await nextTick()
  await fill('#automation-title', '备份')
  await fill('#automation-command', "Write-Output 'ok'")
  host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ title: '备份', scope: 'project', enabled: false, schedule: expect.objectContaining({ kind: 'once' }), action: { kind: 'command', command: "Write-Output 'ok'" } }), 'D:/sample')
  await vi.waitFor(() => expect(host.textContent).toContain('任务已保存'))
})

it('keeps a failed power edit open and retains the list after a failed refresh', async () => {
  button('编辑').click(); await nextTick()
  await fill('#automation-action', 'restart')
  mocks.save.mockRejectedValueOnce(new Error('无法写入'))
  host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('无法写入'))
  expect(host.querySelector('form')).not.toBeNull()
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ scope: 'system', action: { kind: 'restart' } }), 'D:/sample')
  mocks.list.mockRejectedValueOnce(new Error('配置损坏'))
  host.querySelector<HTMLButtonElement>('[aria-label=刷新自动任务]')!.click()
  await vi.waitFor(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('配置损坏'))
  expect(host.querySelector('.automation-task-title')?.textContent).toBe('电源任务')
  expect(host.querySelector('[aria-label=删除电源任务]')).toBeNull()
})

it('drops an edit when the workspace changes and does not save to the new workspace', async () => {
  button('新建').click(); await nextTick()
  workspace.workspace = { rootPath: 'D:/other' }; await nextTick()
  expect(host.querySelector('form')).toBeNull()
  expect(mocks.save).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith('D:/other'))
})
