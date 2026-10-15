import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemoRecord } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import MemoWindow from './MemoWindow.vue'

const mocks = vi.hoisted(() => ({
  listMemos: vi.fn(),
  createMemo: vi.fn(),
  fetchWebpageTitles: vi.fn(),
  updateMemo: vi.fn(),
  deleteMemo: vi.fn(),
  saveMemoImage: vi.fn(),
  readImageAsDataUrl: vi.fn(),
  resolveTerminalPath: vi.fn(),
  openUrl: vi.fn(),
  saveSettings: vi.fn(),
  isTauri: vi.fn(),
  onMemoCliRequest: vi.fn(),
  memoCliReady: vi.fn(),
  memoCliData: vi.fn(),
  memoCliComplete: vi.fn(),
  listMemoCategories: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    listMemos: mocks.listMemos,
    createMemo: mocks.createMemo,
    fetchWebpageTitles: mocks.fetchWebpageTitles,
    updateMemo: mocks.updateMemo,
    deleteMemo: mocks.deleteMemo,
    saveMemoImage: mocks.saveMemoImage,
    readImageAsDataUrl: mocks.readImageAsDataUrl,
    resolveTerminalPath: mocks.resolveTerminalPath,
    openUrl: mocks.openUrl,
    saveSettings: mocks.saveSettings,
    memoCliReady: mocks.memoCliReady,
    memoCliData: mocks.memoCliData,
    memoCliComplete: mocks.memoCliComplete,
    listMemoCategories: mocks.listMemoCategories,
  },
  isTauri: mocks.isTauri,
  onMemoCliRequest: mocks.onMemoCliRequest,
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
    attachments: [],
    createdAt: '2026-07-10T08:57:00.000Z',
    updatedAt: '2026-07-10T08:57:00.000Z',
    ...overrides,
  }
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await nextTick()
}

async function mountWindow(records: MemoRecord[] = [memo()], saved = { category: '', id: '' }) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.settings.memoLastCategory = saved.category
  store.settings.memoLastSelectedId = saved.id
  store.workspace = {
    id: 'workspace',
    name: 'Super High',
    displayName: 'Super High',
    rootPath: 'D:/Demo Files',
    openedAt: '2026-08-10T00:00:00.000Z',
  }
  store.memoWindowOpen = true
  mocks.listMemos.mockImplementation(async (filter) => records.filter((note) => !filter?.category || note.category === filter.category))
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
  it('renames a category through the editor and preserves selected notes and unsaved content', async () => {
    const records = [memo({ category: '旧分类' })]
    mocks.listMemoCategories.mockImplementation(async () => [records[0]!.category!])
    const { root, store } = await mountWindow(records, { category: '旧分类', id: 'memo-1' })
    mocks.updateMemo.mockImplementation(async (_id, title, content, category, attachments) => {
      Object.assign(records[0]!, { title, content, category, attachments })
      return { ...records[0]! }
    })
    mocks.memoCliData.mockImplementation(async () => { records[0]!.category = 'Agent'; return ['Agent'] })
    const content = root.querySelector<HTMLTextAreaElement>('.memo-content-input')!
    content.value = '未保存的正文'
    content.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[aria-label="重命名分类：旧分类"]')!.click()
    await settle()
    const input = root.querySelector<HTMLInputElement>('[aria-label="分类名称"]')!
    input.value = 'Agent'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('[aria-label="重命名分类：Agent"]')).not.toBeNull())
    expect(mocks.memoCliData).toHaveBeenCalledWith({ operation: 'memo.category-rename', options: { name: '旧分类', 'new-name': 'Agent' } })
    expect(mocks.updateMemo.mock.invocationCallOrder[0]).toBeLessThan(mocks.memoCliData.mock.invocationCallOrder[0])
    expect(records[0]!.content).toBe('未保存的正文')
    expect(root.querySelector('.memo-list-item.active')).not.toBeNull()
    expect(store.settings.memoLastCategory).toBe('Agent')
  })

  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.isTauri.mockReturnValue(false)
    mocks.listMemoCategories.mockResolvedValue([])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.updateMemo.mockImplementation(async (id: string, title: string, content: string, category: string, attachments: string[]) => memo({ id, title, content, category, attachments }))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  })

  it('keeps CLI category changes visible and creates notes in edit mode outside previous filters', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.onMemoCliRequest.mockResolvedValue(vi.fn())
    const records = [memo({ category: '旧分类' })]
    const { root } = await mountWindow(records)
    const receive = mocks.onMemoCliRequest.mock.calls[0]![0]
    async function send(operation: string, options: Record<string, string>) {
      mocks.memoCliComplete.mockClear()
      receive({ id: 'request', request: { operation: `memo.${operation}`, options } })
      await vi.waitFor(() => expect(mocks.memoCliComplete).toHaveBeenCalled())
      expect(mocks.memoCliComplete.mock.calls[0]![2]).toBeUndefined()
      return mocks.memoCliComplete.mock.calls[0]![1]
    }
    await send('filter', { category: '旧分类' })
    mocks.memoCliData.mockImplementation(async () => { records[0]!.category = '新分类'; return ['新分类'] })
    await send('category-rename', { name: '旧分类', 'new-name': '新分类' })
    expect((await send('status', {})).filter.category).toBe('新分类')
    await send('category-delete', { name: '新分类' })
    expect((await send('status', {})).filter.category).toBe('')
    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await settle()
    await send('filter', { query: '不匹配', category: '其他分类' })
    mocks.memoCliData.mockImplementation(async () => {
      const created = memo({ id: 'memo-new', category: '新分类' })
      records.push(created)
      return created
    })
    await send('create', { category: '新分类' })
    expect(root.querySelector('.memo-content-input')).not.toBeNull()
    expect(root.querySelector('.memo-list-item.active .memo-list-title')?.textContent).toBe('第一条正文')
    expect(root.querySelector<HTMLInputElement>('.memo-search input')!.value).toBe('')
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('copies unsaved text in edit and preview modes and reports clipboard failures', async () => {
    mocks.updateMemo.mockImplementation(async (id: string, title: string, content: string, _category: string, attachments: string[]) => memo({ id, title, content, attachments }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { root } = await mountWindow()
    const content = root.querySelector<HTMLTextAreaElement>('.memo-content-input')!
    content.value = '尚未保存\nhttps://example.com <正文>'
    content.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    const copy = root.querySelector<HTMLButtonElement>('.memo-copy-button')!
    copy.click()
    await settle()
    expect(writeText).toHaveBeenLastCalledWith(content.value)
    expect(root.querySelector('[role="status"]')!.textContent).toBe('已复制正文')
    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await settle()
    writeText.mockRejectedValueOnce(new Error('denied'))
    copy.click()
    await settle()
    expect(writeText).toHaveBeenLastCalledWith(content.value)
    expect(root.querySelector('[role="status"]')!.textContent).toBe('复制失败，请重试')
    copy.click()
    await settle()
    expect(root.querySelector('[role="status"]')!.textContent).toBe('已复制正文')
  })

  it('inserts the selected memo into the active CLI draft', async () => {
    const { root, store } = await mountWindow([memo({ content: '整理这三个文件', attachments: ['E:/one.txt', 'E:/two.txt'] })])
    store.terminalSessions = [{ id: 'session-main', title: 'Codex', providerKind: 'codex', cwd: 'D:/Demo Files' }]
    store.activeTerminalSessionId = 'session-main'
    store.activeCliSessionId = 'session-main'
    store.showActivityMessage = vi.fn()
    await settle()

    const insert = root.querySelector<HTMLButtonElement>('.memo-insert-button')!
    expect(insert.disabled).toBe(false)
    insert.click()
    await settle()

    expect(store.terminalDrafts['session-main']).toBe('整理这三个文件\nE:/one.txt\nE:/two.txt')
    expect(store.showActivityMessage).toHaveBeenCalledWith('已插入备忘录内容到 CLI 输入框')
  })

  it('keeps pasted images out of the body and copies their paths', async () => {
    const path = 'D:/Demo Files/.superhigh/pasted-images/photo.png'
    mocks.saveMemoImage.mockResolvedValue(path)
    mocks.readImageAsDataUrl.mockResolvedValue('data:image/png;base64,AA==')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { root } = await mountWindow()
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    const item = { type: 'image/png', getAsFile: () => file }
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { items: [item] } })
    root.querySelector<HTMLTextAreaElement>('.memo-content-input')!.dispatchEvent(paste)
    await vi.waitFor(() => expect(root.querySelectorAll('.memo-attachment')).toHaveLength(1))
    expect(paste.defaultPrevented).toBe(true)
    expect(root.querySelector<HTMLTextAreaElement>('.memo-content-input')!.value).toBe('第一条正文')
    root.querySelector<HTMLButtonElement>('.memo-copy-button')!.click()
    await settle()
    expect(writeText).toHaveBeenCalledWith(`第一条正文\n${path}`)
    root.querySelector<HTMLButtonElement>('.memo-attachment')!.click()
    await settle()
    const preview = root.querySelector<HTMLElement>('.memo-image-modal')!
    expect(preview).not.toBeNull()
    preview.querySelector<HTMLButtonElement>('button[title="放大"]')!.click()
    await nextTick()
    expect(preview.textContent).toContain('120%')
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
    await vi.waitFor(() => expect(focus).toHaveBeenCalled())
    expect(root.querySelector('.memo-list-title')!.textContent).toBe('未命名备忘录')
  })

  it('restores the saved category and memo after remount, and falls back when the memo was deleted', async () => {
    const records = [memo(), memo({ id: 'memo-2', category: '工作', content: '第二条' }), memo({ id: 'memo-3', category: '工作', content: '第三条' })]
    mocks.listMemoCategories.mockResolvedValue(['工作'])
    const { root, store } = await mountWindow(records, { category: '工作', id: 'memo-3' })
    expect(root.querySelector('.memo-category-list .active')?.textContent).toBe('工作')
    expect(root.querySelector('.memo-list-item.active .memo-list-title')?.textContent).toBe('第三条')
    root.querySelector<HTMLButtonElement>('.memo-list-item')!.click()
    await settle()
    expect(store.settings.memoLastSelectedId).toBe('memo-2')
    app!.unmount()
    app = null
    const reopened = await mountWindow(records, { category: store.settings.memoLastCategory, id: store.settings.memoLastSelectedId })
    expect(reopened.root.querySelector('.memo-list-item.active .memo-list-title')?.textContent).toBe('第二条')
    app!.unmount()
    app = null
    const missing = await mountWindow(records, { category: '工作', id: 'deleted' })
    expect(missing.store.settings.memoLastSelectedId).toBe('memo-2')
  })

  it('uses the live first line as the default title and starts the description at the second line', async () => {
    const { root } = await mountWindow([memo({ content: '# 第一行标题\n第二行 **摘要**\n第三行' })])
    expect(root.querySelector('.memo-list-title')?.textContent).toBe('第一行标题')
    expect(root.querySelector('.memo-list-description')?.textContent).toBe('第二行 摘要 第三行')
    expect(root.querySelector<HTMLInputElement>('.memo-title-input')!.placeholder).toBe('第一行标题')
    const content = root.querySelector<HTMLTextAreaElement>('.memo-content-input')!
    content.value = '修改后的第一行'
    content.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(root.querySelector('.memo-list-title')?.textContent).toBe('修改后的第一行')
    expect(root.querySelector('.memo-list-description')).toBeNull()
  })

  it('autosaves title and content after editing without changing createdAt', async () => {
    vi.useFakeTimers()
    const original = memo()
    mocks.updateMemo.mockImplementation(async (id: string, title: string, content: string, _category: string, attachments: string[]) => ({
      ...original,
      id,
      title,
      content,
      attachments,
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

    expect(mocks.updateMemo).toHaveBeenLastCalledWith('memo-1', '整理后的标题', '整理后的正文', '', [])
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
    await settle()

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

  it('adds multiple clipboard URLs as titled links on separate lines and autosaves them', async () => {
    mocks.fetchWebpageTitles.mockResolvedValue([
      { url: 'https://example.com/one', title: 'Example One' },
      { url: 'https://example.com/two', title: null },
    ])
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockResolvedValue('https://example.com/one https://example.com/two') } })
    const { root } = await mountWindow([memo({ content: '已有内容' })])
    root.querySelector<HTMLButtonElement>('.memo-add-links-button')!.click()
    await settle()

    expect(mocks.fetchWebpageTitles).toHaveBeenCalledWith(['https://example.com/one', 'https://example.com/two'])
    expect(root.querySelector<HTMLTextAreaElement>('.memo-content-input')!.value).toBe(
      '已有内容\n[Example One](https://example.com/one)\n[https://example.com/two](https://example.com/two)',
    )
    await new Promise((resolve) => setTimeout(resolve, 450))
    await settle()
    expect(mocks.updateMemo).toHaveBeenLastCalledWith(
      'memo-1',
      '',
      '已有内容\n[Example One](https://example.com/one)\n[https://example.com/two](https://example.com/two)',
      '',
      [],
    )
  })

  it('renders inserted Markdown-style webpage links using their titles', async () => {
    const { root } = await mountWindow([memo({ content: '[Example One](https://example.com/one)' })])
    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await settle()
    const anchor = root.querySelector<HTMLAnchorElement>('.memo-content-preview a[href]')!
    expect(anchor.textContent).toBe('Example One')
    expect(anchor.getAttribute('href')).toBe('https://example.com/one')
  })

  it('renders Markdown structure in preview mode', async () => {
    const { root } = await mountWindow([memo({
      content: '# 标题\n\n- 第一项\n- **第二项**\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n\n```ts\nconst x = 1\n```',
    })])
    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await settle()
    const preview = root.querySelector<HTMLElement>('.memo-content-preview.markdown-body')!
    expect(preview.querySelector('h1')?.textContent).toBe('标题')
    expect(preview.querySelectorAll('ul > li')).toHaveLength(2)
    expect(preview.querySelector('li strong')?.textContent).toBe('第二项')
    expect(preview.querySelector('table td')?.textContent).toBe('a')
    expect(preview.querySelector('pre code')?.textContent).toContain('const x = 1')
  })

  it('escapes raw html in preview and trims trailing punctuation off links', async () => {
    const { root } = await mountWindow([memo({
      content: '<b>粗体</b> https://example.com/docs.',
    })])
    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await settle()
    const preview = root.querySelector<HTMLElement>('.memo-content-preview')!
    expect(preview.querySelector('b')).toBeNull()
    expect(preview.textContent).toContain('<b>粗体</b>')
    const anchor = preview.querySelector<HTMLAnchorElement>('a[href]')!
    expect(anchor.textContent).toBe('https://example.com/docs')
    expect(anchor.getAttribute('href')).toBe('https://example.com/docs')
  })

  it('uses terminal path matching and opens resolved files in the code preview', async () => {
    const path = 'D:/示例项目/示例服务端/plugins/skillshare/skills/blockbench/references/blockbench-search-models.md'
    const resolvedPath = path.replace(/\//g, '\\')
    mocks.resolveTerminalPath.mockImplementation(async (candidate: string) => (
      candidate === resolvedPath ? { path: resolvedPath, isFile: true } : null
    ))
    const { root, store } = await mountWindow([memo({ content: `参考 ${path} 继续处理` })])
    const openTerminalFileLink = vi.spyOn(store, 'openTerminalFileLink').mockResolvedValue(true)

    root.querySelector<HTMLButtonElement>('.memo-preview-button')!.click()
    await settle()
    const anchor = root.querySelector<HTMLAnchorElement>('.memo-content-preview a[data-terminal-link-index]')!
    expect(anchor.textContent).toBe(path)

    anchor.click()
    await settle()

    expect(mocks.resolveTerminalPath).toHaveBeenCalledWith(resolvedPath)
    expect(openTerminalFileLink).toHaveBeenCalledWith(resolvedPath)
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

  it('applies a calendar quick filter for the previous seven days', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 12, 0, 0))
    const { root } = await mountWindow()
    root.querySelector<HTMLButtonElement>('.memo-date-button')!.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('.memo-date-quick-filters button')!.click()
    await vi.advanceTimersByTimeAsync(220)
    await settle()

    expect(mocks.listMemos).toHaveBeenLastCalledWith({
      text: undefined,
      createdFrom: new Date(2026, 6, 14).toISOString(),
      createdBefore: new Date(2026, 6, 21).toISOString(),
    })
    expect(root.querySelector('.memo-date-menu')).toBeNull()
  })

  it('persists a dragged frame and deletes the selected memo directly', async () => {
    mocks.deleteMemo.mockResolvedValue(undefined)
    const { root, store } = await mountWindow()
    const titlebar = root.querySelector<HTMLElement>('.memo-titlebar')!
    const memoWindow = root.querySelector<HTMLElement>('.memo-window')!
    const initialLeft = parseFloat(memoWindow.style.left)
    const initialTop = parseFloat(memoWindow.style.top)
    titlebar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 150 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 160, clientY: 150 }))
    await settle()

    expect(store.settings.memoWindowFrame.left).toBe(Math.min(initialLeft + 60, window.innerWidth - parseFloat(memoWindow.style.width)))
    expect(store.settings.memoWindowFrame.top).toBe(Math.min(initialTop + 50, window.innerHeight - 22 - parseFloat(memoWindow.style.height)))
    expect(mocks.saveSettings).toHaveBeenCalled()

    root.querySelector<HTMLButtonElement>('.memo-editor-actions button[title="删除备忘录"]')!.click()
    await settle()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(mocks.deleteMemo).toHaveBeenCalledWith('memo-1')
    expect(root.querySelectorAll('.memo-list-item')).toHaveLength(0)
  })
})
