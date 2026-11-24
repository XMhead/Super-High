import { createApp, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import NoticeDetail from './NoticeDetail.vue'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); delete (window as Window & { SuperHighNoticeDetail?: unknown }).SuperHighNoticeDetail })

it('renders complete questions and retains answers when a submission fails', async () => {
  const native = { load: vi.fn(), reply: vi.fn((_json: string) => {}), close: vi.fn() }
  Object.assign(window, { SuperHighNoticeDetail: native })
  const root = document.createElement('div'); document.body.append(root)
  const app = createApp(NoticeDetail); app.mount(root)
  dispose = () => { app.unmount(); root.remove() }
  expect(native.load).toHaveBeenCalledOnce()
  window.dispatchEvent(new CustomEvent('superhigh:notice-detail', { detail: { type: 'detail', detail: {
    title: '测试', provider: 'codex', plan: true, body: '', planRequest: { questions: [
      { id: 'one', question: '**第一题**', options: [{ label: '选项', description: '选项说明' }] },
      { id: 'two', question: '第二题', options: [], multiSelect: false },
    ] },
  } } }))
  await nextTick()
  expect(root.querySelector('.markdown-body strong')?.textContent).toBe('第一题')
  expect(root.textContent).toContain('选项说明')
  const radio = root.querySelector<HTMLInputElement>('input[type=radio]')!
  radio.checked = true; radio.dispatchEvent(new Event('change'))
  const areas = root.querySelectorAll<HTMLTextAreaElement>('textarea')
  areas[1].value = '第二个回答'; areas[1].dispatchEvent(new Event('input'))
  await nextTick()
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(JSON.parse(native.reply.mock.calls[0][0])).toEqual({ one: ['选项'], two: ['第二个回答'] })
  window.dispatchEvent(new CustomEvent('superhigh:notice-detail', { detail: { type: 'reply-error', error: '连接失败' } }))
  await nextTick()
  expect(root.textContent).toContain('连接失败')
  expect(areas[1].value).toBe('第二个回答')
  expect(radio.checked).toBe(true)
})
