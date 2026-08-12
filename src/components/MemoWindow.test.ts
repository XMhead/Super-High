import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemoRecord } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import MemoWindow from './MemoWindow.vue'

const mocks = vi.hoisted(() => ({
  listMemos: vi.fn(),
  createMemo: vi.fn(),
  updateMemo: vi.fn(),
  deleteMemo: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listMemos: mocks.listMemos,
    createMemo: mocks.createMemo,
    updateMemo: mocks.updateMemo,
    deleteMemo: mocks.deleteMemo,
    saveSettings: mocks.saveSettings,
  },
  isTauri: vi.fn(() => false),
  onProjectServiceStatus: vi.fn(),
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn() }))

let app: App<Element> | null = null

function memo(overrides: Partial<MemoRecord> = {}): MemoRecord {
  return {
    id: 'memo-1',
    title: '',
    content: '第一条正文',
    createdAt: '2026-07-10T08:57:00.000Z',
    updatedAt: '2026-07-10T08:57:00.000Z',
    ...overrides,
  }
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await nextTick()
}

async function mountWindow(records: MemoRecord[] = [memo()]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.workspace = {
    id: 'workspace',
    name: 'Super High',
    displayName: 'Super High',
    rootPath: 'D:/Super High',
    openedAt: '2026-08-10T00:00:00.000Z',
  }
  store.memoWindowOpen = true
  mocks.listMemos.mockImplementation(async () => records.slice())
  mocks.saveSettings.mockImplementation(async (settings) => settings)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(MemoWindow)
  app.use(pinia)
  app.mount(root)
  await settle()
  return { root, store, records }
}

describe('MemoWindow', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('creates an untitled memo immediately and focuses its content', async () => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    const records = [memo()]
    const created = memo({
      id: 'memo-2',
      content: '',
      createdAt: '2026-07-20T12:46:00.000Z',
      updatedAt: '2026-07-20T12:46:00.000Z',
    })
    mocks.createMemo.mockImplementation(async () => {
      records.unshift(created)
      return created
    })
    const { root } = await mountWindow(records)

    root.querySelector<HTMLButtonElement>('.memo-add-button')!.click()
    await settle()

    expect(mocks.createMemo).toHaveBeenCalledOnce()
    expect(root.querySelector<HTMLInputElement>('.memo-title-input')!.value).toBe('')
    expect(focus).toHaveBeenCalled()
    expect(root.querySelector('.memo-list-item strong')!.textContent).toMatch(/2026\/07\/20/)
  })

  it('autosaves title and content after editing without changing createdAt', async () => {
    vi.useFakeTimers()
    const original = memo()
    mocks.updateMemo.mockImplementation(async (id: string, title: string, content: string) => ({
      ...original,
      id,
      title,
      content,
      updatedAt: '2026-07-10T09:00:00.000Z',
    }))
    const { root } = await mountWindow([original])
    const title = root.querySelector<HTMLInputElement>('.memo-title-input')!
    const content = root.querySelector<HTMLTextAreaElement>('.memo-content-input')!

    title.value = '整理后的标题'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    content.value = '整理后的正文'
    content.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(400)
    await settle()

    expect(mocks.updateMemo).toHaveBeenLastCalledWith('memo-1', '整理后的标题', '整理后的正文')
    expect(original.createdAt).toBe('2026-07-10T08:57:00.000Z')
    expect(root.querySelector('.memo-metadata')!.textContent).toContain('已保存')
  })

  it('toggles preview mode and renders stored website links as clickable anchors', async () => {
    const { root } = await mountWindow([memo({
      content: '参考 https://github.com/XMhead/skills 里的技能',
    })])
    const toggle = root.querySelector<HTMLButtonElement>('.memo-preview-button')!
    expect(root.querySelector('.memo-content-input')).not.toBeNull()
    expect(root.querySelector('.memo-content-preview')).toBeNull()

    toggle.click()
    await nextTick()

    expect(root.querySelector('.memo-content-input')).toBeNull()
    const preview = root.querySelector<HTMLElement>('.memo-content-preview')!
    expect(preview).not.toBeNull()
    const anchor = preview.querySelector<HTMLAnchorElement>('a[href]')!
    expect(anchor).not.toBeNull()
    expect(anchor.textContent).toBe('https://github.com/XMhead/skills')
    expect(anchor.getAttribute('href')).toBe('https://github.com/XMhead/skills')
    expect(anchor.getAttribute('target')).toBe('_blank')

    toggle.click()
    await nextTick()
    expect(root.querySelector('.memo-content-input')).not.toBeNull()
    expect(root.querySelector('.memo-content-preview')).toBeNull()
  })

  it('escapes raw html in preview and trims trailing punctuation off links', async () => {
    const { root } = await mountWindow([memo({
      content: '<b>粗体</b> https://example.com/docs.',
    })])
    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await nextTick()
    const preview = root.querySelector<HTMLElement>('.memo-content-preview')!
    expect(preview.querySelector('b')).toBeNull()
    expect(preview.textContent).toContain('<b>粗体</b>')
    const anchor = preview.querySelector<HTMLAnchorElement>('a[href]')!
    expect(anchor.textContent).toBe('https://example.com/docs')
    expect(anchor.getAttribute('href')).toBe('https://example.com/docs')
  })

  it('queries an inclusive local date range with an exclusive next-day boundary', async () => {
    vi.useFakeTimers()
    const { root } = await mountWindow()
    root.querySelector<HTMLButtonElement>('.memo-date-button')!.click()
    await nextTick()
    const [from, to] = Array.from(root.querySelectorAll<HTMLInputElement>('.memo-date-menu input'))

    from.value = '2026-07-10'
    from.dispatchEvent(new Event('input', { bubbles: true }))
    to.value = '2026-07-20'
    to.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(220)
    await settle()

    expect(mocks.listMemos).toHaveBeenLastCalledWith({
      text: undefined,
      createdFrom: new Date(2026, 6, 10).toISOString(),
      createdBefore: new Date(2026, 6, 21).toISOString(),
    })
  })

  it('persists a dragged frame and deletes the selected memo after confirmation', async () => {
    mocks.deleteMemo.mockResolvedValue(undefined)
    const { root, store } = await mountWindow()
    const titlebar = root.querySelector<HTMLElement>('.memo-titlebar')!
    titlebar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 150 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 160, clientY: 150 }))
    await settle()

    expect(store.settings.memoWindowFrame.left).toBe(520)
    expect(store.settings.memoWindowFrame.top).toBe(126)
    expect(mocks.saveSettings).toHaveBeenCalled()

    root.querySelector<HTMLButtonElement>('.memo-editor-heading button[title="删除备忘录"]')!.click()
    await settle()
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.deleteMemo).toHaveBeenCalledWith('memo-1')
    expect(root.querySelectorAll('.memo-list-item')).toHaveLength(0)
  })
})
