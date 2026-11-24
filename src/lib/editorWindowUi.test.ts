import { afterEach, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { bindEditorWindowUiHost, connectEditorWindowUi, editorUiSnapshot } from './editorWindowUi'
import type { EditorTab } from '@/types'

const bus = vi.hoisted(() => ({ handlers: new Map<string, Set<(event: any) => unknown>>(), label: 'editor-one' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: bus.label }) }))
vi.mock('@tauri-apps/api/event', () => {
  const send = async (name: string, payload: unknown) => {
    for (const handler of [...(bus.handlers.get(name) ?? [])]) await handler({ payload })
  }
  return {
    emit: vi.fn(send), emitTo: vi.fn(async (_target: string, name: string, payload: unknown) => send(name, payload)),
    listen: vi.fn(async (name: string, handler: (event: any) => unknown) => {
      const handlers = bus.handlers.get(name) ?? new Set()
      handlers.add(handler); bus.handlers.set(name, handlers)
      return () => { handlers.delete(handler) }
    }),
  }
})
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); bus.handlers.clear(); vi.clearAllMocks() })
const tab = (path: string, content: string): EditorTab => ({ id: path, path, content, name: path.split('/').at(-1)!, contentType: 'text', language: 'plaintext', isDirty: true })

it('syncs only IUI tabs for the matching workspace and forwards drafts and guarded source changes', async () => {
  const sources = ref([tab('D:/One/report.shui', 'root = Text("first")'), tab('D:/One/code.ts', 'code')])
  const submit = vi.fn(async () => 'inserted' as const)
  const save = vi.fn(async (_root, path, content, previous) => {
    const source = sources.value.find(item => item.path === path)!
    if (source.content !== previous) throw new Error('文件已变化')
    source.content = content
  })
  cleanups.push(await bindEditorWindowUiHost(() => [editorUiSnapshot('D:/One', sources.value), editorUiSnapshot('D:/Other', [tab('D:/Other/other.shui', 'other')])], submit, save, vi.fn()))
  const apply = vi.fn()
  const client = await connectEditorWindowUi('d:/one', apply)
  cleanups.push(() => client.destroy())
  expect(apply.mock.calls[0][0].tabs.map((item: EditorTab) => item.path)).toEqual(['D:/One/report.shui'])
  expect(await client.submit('D:/One/report.shui', '确认\n备注：输入')).toBe('inserted')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledWith('D:/One/report.shui', '确认\n备注：输入')
  await client.saveSource('D:/One/report.shui', 'root = Text("new")', 'root = Text("first")')
  await nextTick()
  await vi.waitFor(() => expect(apply.mock.calls.at(-1)?.[0].tabs[0].content).toBe('root = Text("new")'))
  await expect(client.saveSource('D:/One/report.shui', 'stale', 'root = Text("first")')).rejects.toThrow('文件已变化')
  await expect(client.submit('D:/Other/other.shui', 'wrong workspace')).rejects.toThrow('标签已关闭')
  expect(submit).toHaveBeenCalledTimes(1)
  sources.value = []
  await nextTick()
  await vi.waitFor(() => expect(apply.mock.calls.at(-1)?.[0].tabs).toEqual([]))
  client.destroy()
  await expect(client.submit('D:/One/report.shui', 'after close')).rejects.toThrow('连接已关闭')
})
