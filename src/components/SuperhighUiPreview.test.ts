import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import type { EditorTab } from '@/types'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
  updateTabContent: vi.fn(),
  saveTab: vi.fn(async () => true),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    readImageAsDataUrl: vi.fn(async () => 'data:image/png;base64,'),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({ updateTabContent: mocks.updateTabContent, saveTab: mocks.saveTab }),
}))

import SuperhighUiPreview from './SuperhighUiPreview.vue'

let app: App | null = null
let host: HTMLElement | null = null

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(content: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SuperhighUiPreview, { tab: tab(content) })
  app.mount(host)
  await flushPromises()
  return host
}

const buttonByText = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)!

const SOURCE = [
  'root = Stack([summary, form, Button("重新构建", action: "rebuild")])',
  'summary = Card("构建", [Stat("耗时", "42s", "-8s", "ok"), Badge("通过", "ok")])',
  'form = Form("review", [Input("note", "备注"), Choice("level", ["低", "高"])], submit: "确认")',
].join('\n')

function tab(content: string): EditorTab {
  return { id: 'tab-1', path: 'D:/work/report.shui', name: 'report.shui', content, contentType: 'text', language: 'plaintext', isDirty: false }
}

function lastState() {
  const calls = mocks.writeFile.mock.calls as unknown as [string, string][]
  const [path, content] = calls.at(-1)!
  return { path, state: JSON.parse(content) }
}

describe('SuperhighUiPreview', () => {
  beforeEach(() => {
    mocks.readFile.mockRejectedValue(new Error('missing'))
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    app = null
    host = null
    vi.clearAllMocks()
  })

  it('renders components and records button actions to the state file', async () => {
    const root = await mount(SOURCE)
    expect(root.querySelector('.shui-card-title')?.textContent).toBe('构建')
    expect(root.querySelector('.shui-stat-value')?.textContent).toBe('42s')

    buttonByText(root, '重新构建').click()
    await flushPromises()
    const { path, state } = lastState()
    expect(path).toBe('D:/work/report.shui.state.json')
    expect(state.schema).toBe('superhigh.ui-state.v1')
    expect(state.actions).toEqual([expect.objectContaining({ id: 1, type: 'click', action: 'rebuild', label: '重新构建' })])
  })

  it('submits form fields with their current values', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ values: { level: '高' }, actions: [{ id: 4, type: 'click', action: 'old' }] }))
    const root = await mount(SOURCE)
    expect(root.querySelector('.shui-choice button.active')?.textContent).toBe('高')

    const input = root.querySelector<HTMLInputElement>('input.shui-input')!
    input.value = '看一下缓存'
    input.dispatchEvent(new Event('input'))
    root.querySelector('form.shui-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    const { state } = lastState()
    expect(state.values).toEqual({ level: '高', note: '看一下缓存' })
    expect(state.actions.at(-1)).toEqual(expect.objectContaining({ id: 5, type: 'submit', form: 'review', values: { note: '看一下缓存', level: '高' } }))
  })

  it('shows streaming state and placeholders for references not written yet', async () => {
    const root = await mount('root = Stack([head, body])\nhead = Text("先到")')
    expect(root.querySelector('.shui-status-streaming')).not.toBeNull()
    expect(root.querySelector('.shui-pending')?.textContent).toBe('body')
  })

  it('writes a reordered array back to the source when a component is dropped', async () => {
    const source = 'root = Stack([a, b])\na = Text("first")\nb = Text("second")'
    const root = await mount(source)
    const [first, second] = [...root.querySelectorAll<HTMLElement>('.shui-item')]
    const rect = (top: number) => ({ top, bottom: top + 20, left: 0, right: 200, width: 200, height: 20, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    first.getBoundingClientRect = () => rect(0)
    second.getBoundingClientRect = () => rect(30)
    Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => second), configurable: true })

    first.querySelector('.shui-grip')!.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 45 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 45 }))
    await flushPromises()

    expect(mocks.updateTabContent).toHaveBeenCalledWith('tab-1', 'root = Stack([b, a])\na = Text("first")\nb = Text("second")')
    expect(mocks.saveTab).toHaveBeenCalledWith('tab-1')
  })

  it('inserts the dragged component source into the CLI input when dropped on a CLI panel', async () => {
    const source = 'root = Stack([a])\na = Badge("ok", "ok")'
    const root = await mount(source)
    const cli = document.createElement('section')
    cli.className = 'panel terminal-panel cli-terminal-panel'
    document.body.appendChild(cli)
    Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => cli), configurable: true })
    const inserted = vi.fn()
    window.addEventListener('superhigh:add-selection-to-chat', inserted)

    root.querySelector('.shui-grip')!.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 300 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 400, clientY: 300 }))
    await flushPromises()

    window.removeEventListener('superhigh:add-selection-to-chat', inserted)
    cli.remove()
    expect((inserted.mock.calls[0][0] as CustomEvent).detail).toEqual({
      source: '查看界面组件 D:/work/report.shui 语句 a（第 2 行）',
      text: 'a = Badge("ok", "ok")',
    })
    expect(mocks.updateTabContent).not.toHaveBeenCalled()
  })
})
