import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MobileUiPreview from './MobileUiPreview.vue'
import type { MobileHostApi } from '@/lib/hostApi'

let app: ReturnType<typeof createApp> | undefined
let root: HTMLDivElement | undefined
const flush = async () => { for (let i = 0; i < 12; i++) await nextTick() }
afterEach(() => { app?.unmount(); root?.remove(); vi.useRealTimers() })

describe('mobile IUI', () => {
  it('renders shared components, saves choices, and submits to the original desktop binding', async () => {
    const source = 'root = Form("reply", [Choice("choice", ["甲", "乙"], label: "选择")], submit: "确认")'
    const api = {
      readTextFile: vi.fn(async (path: string) => path.endsWith('.state.json') ? '{"values":{},"actions":[]}' : source),
      view: vi.fn(async (request: { operation: string }) => request.operation === 'iui-submit' ? { result: 'inserted' } : { saved: true }),
    } as unknown as MobileHostApi
    root = document.createElement('div'); document.body.append(root)
    app = createApp(MobileUiPreview, { api, root: 'D:/project', path: 'D:/project/choice.shui', content: source })
    app.mount(root); await flush()
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.shui-choice button')]
    expect(buttons.map(button => button.textContent)).toEqual(['甲', '乙'])
    buttons[1].click(); await flush()
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(api.view).toHaveBeenCalledWith(expect.objectContaining({ operation: 'iui-state', path: 'D:/project/choice.shui', data: expect.objectContaining({ state: expect.objectContaining({ values: { choice: '乙' } }) }) }))
    expect(api.view).toHaveBeenCalledWith(expect.objectContaining({ operation: 'iui-submit', data: { text: '确认\n选择：乙' } }))
    expect(root.textContent).toContain('已填入原会话草稿')
  })
  it('updates the visible IUI when the source file changes', async () => {
    vi.useFakeTimers()
    let source = 'root = Text("初始")'
    const api = { readTextFile: vi.fn(async (path: string) => path.endsWith('.state.json') ? '{}' : source) } as unknown as MobileHostApi
    root = document.createElement('div'); document.body.append(root)
    app = createApp(MobileUiPreview, { api, root: 'D:/project', path: 'D:/project/live.shui', content: source })
    app.mount(root); await flush()
    expect(root.textContent).toContain('初始')
    source = 'root = Text("更新")'
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root.textContent).toContain('更新')
  })

  it('restores multiple answers and submits their option labels on mobile', async () => {
    const source = 'root = Form("reply", [Question("checks", "复验入口", [{label: "窄窗", value: "narrow"}, {label: "重开", value: "restore"}], multiple: true, freeText: false)], submit: "确认")'
    const api = {
      readTextFile: vi.fn(async (path: string) => path.endsWith('.state.json') ? JSON.stringify({ values: { checks: { choices: ['narrow', 'obsolete'], text: '旧文字' } } }) : source),
      view: vi.fn(async (request: { operation: string }) => request.operation === 'iui-submit' ? { result: 'inserted' } : { saved: true }),
    } as unknown as MobileHostApi
    root = document.createElement('div'); document.body.append(root)
    app = createApp(MobileUiPreview, { api, root: 'D:/project', path: 'D:/project/questions.shui', content: source })
    app.mount(root); await flush()
    expect(root.querySelector('textarea')).toBeNull()
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes.map(box => box.checked)).toEqual([true, false])
    boxes[1].click(); await flush()
    expect(boxes.map(box => box.checked)).toEqual([true, true])
    root.querySelector<HTMLButtonElement>('button[type=submit]')!.click(); await flush()
    expect(api.view).toHaveBeenCalledWith(expect.objectContaining({ operation: 'iui-submit', data: { text: '确认\n复验入口：窄窗、重开' } }))
    expect(root.textContent).toContain('已填入原会话草稿')
  })
})
