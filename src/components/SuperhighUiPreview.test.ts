import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import type { EditorTab } from '@/types'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readImage: vi.fn(async (_path: string) => 'data:image/png;base64,'),
  readMedia: vi.fn(async (_path: string) => 'data:video/mp4;base64,'),
  fileChanged: null as null | ((event: { kind: string; changedPaths: string[] }) => void),
  writeFile: vi.fn(async () => undefined),
  updateTabContent: vi.fn(),
  saveTab: vi.fn(async () => true),
  openFile: vi.fn(async () => true),
  openTerminalFileLink: vi.fn(async () => true),
  openUrl: vi.fn(async () => undefined),
  insertUiDraft: vi.fn(async (): Promise<'inserted' | 'ended' | 'unbound'> => 'inserted'),
  setEditorFileWatch: vi.fn(async () => undefined),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    readImageAsDataUrl: mocks.readImage,
    readMediaAsDataUrl: mocks.readMedia,
    readMediaPreview: async (path: string) => ({ url: await mocks.readMedia(path), optimized: false }),
    openUrl: mocks.openUrl,
  },
  onWorkspaceFilesChanged: vi.fn(async (handler) => { mocks.fileChanged = handler; return () => { mocks.fileChanged = null } }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: () => ({ workspace: { rootPath: 'D:/work' }, setEditorFileWatch: mocks.setEditorFileWatch, updateTabContent: mocks.updateTabContent, saveTab: mocks.saveTab, openFile: mocks.openFile, openTerminalFileLink: mocks.openTerminalFileLink, insertUiDraft: mocks.insertUiDraft }),
}))

import SuperhighUiPreview from './SuperhighUiPreview.vue'

let app: App | null = null
let host: HTMLElement | null = null

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(content: string, options: { saveSource?: (content: string, previous: string) => Promise<void> } = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(SuperhighUiPreview, { tab: tab(content), ...options })
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

  it('renders Markdown by default and ANSI across text and code components', async () => {
    const ansi = JSON.stringify('\\x1b[32m通过\\x1b[0m <img src=x onerror=alert(1)>')
    const root = await mount(`root = Stack([Text("**默认加粗**"), "*直接正文*", Callout("[文件](./file.md)"), Text("**原文**", format: "plain"), Code("# 方案标题", "markdown"), Code(${ansi}, "ansi"), Ansi(${ansi}), Text(${ansi}, format: "ansi")])`)
    expect(root.querySelector('.shui-text strong')?.textContent).toBe('默认加粗')
    expect(root.querySelector('.shui-text em')?.textContent).toBe('直接正文')
    expect(root.querySelector('.shui-callout a')?.textContent).toBe('文件')
    expect(root.textContent).toContain('**原文**')
    expect(root.querySelector('.shui-code h1')?.textContent).toBe('方案标题')
    expect(root.querySelectorAll('.sh-ansi-preview')).toHaveLength(3)
    expect(root.querySelector('.sh-ansi-preview span')?.getAttribute('style')).toContain('--terminal-ansi-green')
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('changes tabs only on click', async () => {
    const root = await mount('root = Tabs(["第一版 UI 查看", "第二版 UI 查看"], [Text("**第一版内容**"), Text("**第二版内容**")])')
    const [first, second] = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const body = () => root.querySelector('[role="tabpanel"]')?.textContent
    second.dispatchEvent(new Event('pointerenter'))
    await nextTick()
    expect(body()).toBe('第一版内容')
    second.click()
    await nextTick()
    expect(body()).toBe('第二版内容')
    expect(first.getAttribute('aria-selected')).toBe('false')
  })

  it('changes Choice bindings only on click', async () => {
    const root = await mount('root = Form("review", [Choice("version", ["第一版", "第二版"], value: "第一版"), Bind("version", {"第一版": Text("一版内容"), "第二版": Text("二版内容")})], submit: "确认")')
    const [first, second] = root.querySelectorAll<HTMLButtonElement>('.shui-choice button')
    second.dispatchEvent(new Event('pointerenter'))
    await nextTick()
    expect(root.querySelector('.shui-text')?.textContent).toBe('一版内容')
    expect(first.getAttribute('aria-pressed')).toBe('true')
    second.click()
    await nextTick()
    expect(root.querySelector('.shui-text')?.textContent).toBe('二版内容')
  })

  it.each(['multiple: true, value: ["第一版"]'])('keeps multiple Choice bindings unchanged on hover: %s', async (settings) => {
    const root = await mount(`root = Stack([Choice("version", ["第一版", "第二版"], ${settings}), Text(Bind("version"))])`)
    root.querySelectorAll('.shui-choice button')[1].dispatchEvent(new Event('pointerenter'))
    await nextTick()
    expect(root.querySelector('.shui-text')?.textContent).toContain('第一版')
    expect(root.querySelector('.shui-text')?.textContent).not.toContain('第二版')
  })

  it.each([['Video', 'video', '../movie.mp4', 'D:/movie.mp4'], ['Audio', 'audio', './music.ogg', 'D:/work/music.ogg']])('loads %s relative to the shui file', async (component, tag, path, resolved) => {
    const root = await mount(`root = ${component}(${JSON.stringify(path)}, label: "片段")`)
    expect(mocks.readMedia).toHaveBeenCalledWith(resolved)
    expect(root.querySelector(tag)?.getAttribute('controls')).not.toBeNull()
    expect(root.querySelector(tag)?.getAttribute('aria-label')).toBe('片段')
    root.querySelector<HTMLButtonElement>('.shui-resource-link')!.click()
    await flushPromises()
    expect(mocks.openFile).toHaveBeenCalledWith(resolved)
  })

  it('opens the model path from its label', async () => {
    const root = await mount('root = Model3D("./model.gltf", label: "模型")')
    root.querySelector<HTMLButtonElement>('.shui-resource-link')!.click()
    await flushPromises()
    expect(mocks.openFile).toHaveBeenCalledWith('D:/work/model.gltf')
  })

  it.each([
    ['../模型/配方.md', 'D:/模型/配方.md'],
    ['D:/work/模型/配方.md', 'D:/work/模型/配方.md'],
    ['file:///D:/work/%E6%A8%A1%E5%9E%8B.md', 'D:/work/模型.md'],
  ])('opens local Markdown links without navigating the app: %s', async (href, path) => {
    const root = await mount(`root = Markdown(${JSON.stringify(`[模型·配方](<${href}>)`)})`)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    root.querySelector('a')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flushPromises()
    expect(mocks.openFile).toHaveBeenCalledWith(path)
  })

  it.each([
    ['D:/我的世界/示例游戏服务器/plugins/SamplePlugin/config.yml:74', ['D:/我的世界/示例游戏服务器/plugins/SamplePlugin/config.yml', 74]],
    ['E:/Super系列插件git备份/SuperTitle源码/src/main/kotlin/com/supertitle/model/Models.kt:28', ['E:/Super系列插件git备份/SuperTitle源码/src/main/kotlin/com/supertitle/model/Models.kt', 28]],
    ['D:/work/a file.kt:12:3', ['D:/work/a file.kt', 12, { column: 3 }]],
    ['../file.kt#L42', ['D:/file.kt', 42]],
    ['./guide.md#安装', ['D:/work/guide.md', undefined, { anchor: '安装' }]],
    ['file://server/share/a.kt:8', ['//server/share/a.kt', 8]],
  ])('opens IUI file links at their location: %s', async (href, args) => {
    const root = await mount('root = Markdown(' + JSON.stringify('[位置](<' + href + '>)') + ')')
    root.querySelector<HTMLAnchorElement>('a')!.click()
    await flushPromises()
    expect(mocks.openTerminalFileLink).toHaveBeenCalledWith(...args)
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('blocks auxiliary navigation and unsupported schemes and opens websites externally', async () => {
    const root = await mount('root = Markdown("[网页](https://example.com) [协议](custom:open) [文件](./file.md)")')
    const links = root.querySelectorAll('a')
    links[0]!.click()
    links[1]!.click()
    const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    links[2]!.dispatchEvent(middle)
    await flushPromises()
    expect(middle.defaultPrevented).toBe(true)
    expect(mocks.openUrl).toHaveBeenCalledOnce()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('does not repeat links already opened by the app capture handler', async () => {
    const root = await mount('root = Markdown("[网页](https://example.com)")')
    const captured = (event: MouseEvent) => { event.preventDefault(); void mocks.openUrl() }
    window.addEventListener('click', captured, true)
    try { root.querySelector('a')!.click() }
    finally { window.removeEventListener('click', captured, true) }
    await flushPromises()
    expect(mocks.openUrl).toHaveBeenCalledOnce()
  })

  it.each(['Image("./图片.png", "场景")', 'Markdown("![场景](./图片.png)")'])('previews images and closes on native Escape cancellation: %s', async (component) => {
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true })
    const root = await mount(`root = ${component}`)
    root.querySelector('img')!.click()
    await flushPromises()
    const dialog = document.querySelector<HTMLDialogElement>('.image-preview-dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,')
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    await nextTick()
    expect(document.querySelector('.image-preview-dialog')).toBeNull()
  })

  it.each(['Image("./图片.png", "场景")', 'Markdown("![场景](./图片.png)")'])(
    'refreshes changed local images and rejects stale reads: %s', async (component) => {
      const root = await mount(`root = ${component}`)
      let finishOld!: (value: string) => void
      mocks.readImage.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/图片.png'] })
      await nextTick()
      mocks.readImage.mockResolvedValueOnce('data:image/png;base64,new')
      mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/图片.png'] })
      await flushPromises()
      expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,new')
      finishOld('data:image/png;base64,old')
      await flushPromises()
      expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,new')
    },
  )

  it('retries a data file temporarily locked by its writer', async () => {
    let reads = 0
    mocks.readFile.mockImplementation(async (path: string) => {
      if (!path.endsWith('/data.json')) throw new Error('missing')
      if (++reads === 1) throw new Error('无法打开文件：os error 32')
      return '{"total":7}'
    })
    const root = await mount('root = Stat("总计", Data("data.json", "total"))')
    await vi.waitFor(() => expect(root.querySelector('.shui-stat-value')?.textContent).toBe('7'))
    expect(reads).toBe(2)
    expect(root.textContent).not.toContain('个问题')
  })

  it('recovers failed data reads when the workspace watcher requests a rescan', async () => {
    const root = await mount('root = Stat("总计", Data("data.json", "total"))')
    await vi.waitFor(() => expect(root.textContent).toContain('1 个问题'))
    mocks.readFile.mockResolvedValue('{"total":9}')
    mocks.fileChanged!({ kind: 'rescan', changedPaths: [] })
    await flushPromises()
    expect(root.querySelector('.shui-stat-value')?.textContent).toBe('9')
    expect(root.textContent).not.toContain('个问题')
  })

  it.each(['success', 'failure'])('discards stale data %s after a newer refresh', async (result) => {
    mocks.readFile.mockResolvedValue('{"total":1}')
    const root = await mount('root = Stat("总计", Data("data.json", "total"))')
    let finishOld!: (value: string) => void
    let failOld!: (error: Error) => void
    mocks.readFile.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; failOld = reject }))
    mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/data.json'] })
    mocks.readFile.mockResolvedValue('{"total":5}')
    mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/data.json'] })
    await flushPromises()
    if (result === 'success') finishOld('{"total":2}')
    else failOld(new Error('旧读取失败'))
    await flushPromises()
    expect(root.querySelector('.shui-stat-value')?.textContent).toBe('5')
    expect(root.textContent).not.toContain('个问题')
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

  it('keeps a separate footer with working form controls on a page', async () => {
    const root = await mount('root = Page([Text("长正文")], [Form("reply", [Input("note", "备注")], submit: "确认")])')
    expect(root.querySelector('.shui-scroll.has-page .shui-page-body')?.textContent).toContain('长正文')
    const footer = root.querySelector('.shui-page-footer')!
    const input = footer.querySelector<HTMLInputElement>('input')!
    input.value = '底部输入'
    input.dispatchEvent(new Event('input'))
    footer.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(lastState().state.actions.at(-1)).toEqual(expect.objectContaining({ type: 'submit', values: { note: '底部输入' } }))
    expect(mocks.insertUiDraft).toHaveBeenCalledWith('D:/work/report.shui', '确认\n备注：底部输入')
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
    expect(mocks.insertUiDraft).toHaveBeenCalledWith('D:/work/report.shui', '确认\n备注：看一下缓存\nlevel：高')
  })

  it('refreshes fields and actions written from another window without resubmitting', async () => {
    const root = await mount(SOURCE)
    mocks.readFile.mockResolvedValue(JSON.stringify({ values: { note: '编辑器窗口的输入', level: '高' }, actions: [{ id: 9, type: 'click', action: 'other' }] }))
    mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/report.shui.state.json'] })
    await flushPromises()
    expect(root.querySelector<HTMLInputElement>('input.shui-input')?.value).toBe('编辑器窗口的输入')
    expect(root.querySelector('.shui-choice button.active')?.textContent).toBe('高')
    expect(mocks.insertUiDraft).not.toHaveBeenCalled()
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(lastState().state.actions.at(-1).id).toBe(10)
    expect(mocks.insertUiDraft).toHaveBeenCalledWith('D:/work/report.shui', expect.stringContaining('编辑器窗口的输入'))
  })

  it('does not overwrite a new local edit with a slow external state read', async () => {
    const root = await mount(SOURCE)
    let finish!: (value: string) => void
    mocks.readFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/report.shui.state.json'] })
    await flushPromises()
    const input = root.querySelector<HTMLInputElement>('input.shui-input')!
    input.value = '本地最新输入'
    input.dispatchEvent(new Event('input'))
    finish(JSON.stringify({ values: { note: '旧内容' } }))
    await flushPromises()
    expect(input.value).toBe('本地最新输入')
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(lastState().state.values.note).toBe('本地最新输入')
  })

  it('registers exact dependency watches and releases them on unmount', async () => {
    await mount('root = Stack([Stat("数量", Data("deep/count.json", "count")), Image("images/icon.png")])')
    expect(mocks.setEditorFileWatch).toHaveBeenCalledWith(expect.stringMatching(/^iui:/), 'D:/work', expect.arrayContaining([
      { path: 'report.shui', kind: 'file' }, { path: 'report.shui.state.json', kind: 'file' },
      { path: 'deep/count.json', kind: 'file' }, { path: 'images/icon.png', kind: 'file' },
    ]))
    app!.unmount(); app = null
    expect(mocks.setEditorFileWatch).toHaveBeenLastCalledWith(expect.stringMatching(/^iui:/), 'D:/work', [])
  })

  it('waits for queued local state writes before reading an external file event', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ values: { note: '旧字段' } }))
    const root = await mount(SOURCE)
    let finish!: () => void
    mocks.writeFile.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
    const input = root.querySelector<HTMLInputElement>('input.shui-input')!
    input.value = '待写入的新字段'
    input.dispatchEvent(new Event('input'))
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    mocks.fileChanged!({ kind: 'modify', changedPaths: ['D:/work/report.shui.state.json'] })
    await flushPromises()
    expect(input.value).toBe('待写入的新字段')
    mocks.readFile.mockResolvedValue(JSON.stringify({ values: { note: '待写入的新字段' } }))
    finish()
    await flushPromises()
    expect(input.value).toBe('待写入的新字段')
  })

  it('routes editor-window actions through the supplied original-session bridge', async () => {
    const submitDraft = vi.fn(async () => 'inserted' as const)
    host = document.createElement('div'); document.body.append(host)
    app = createApp(SuperhighUiPreview, { tab: tab(SOURCE), submitDraft })
    app.mount(host)
    await flushPromises()
    buttonByText(host, '重新构建').click()
    await flushPromises()
    expect(submitDraft).toHaveBeenCalledWith('D:/work/report.shui', expect.stringContaining('重新构建'))
    expect(mocks.insertUiDraft).not.toHaveBeenCalled()
  })

  it('uses display labels for choices and keeps raw values in state', async () => {
    const root = await mount('root = Form("结果", [Choice("priority", [{label: "高优先级", value: "high"}], label: "优先级")], submit: "确认")')
    root.querySelector<HTMLButtonElement>('.shui-choice button')!.click()
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(mocks.insertUiDraft).toHaveBeenCalledWith('D:/work/report.shui', '确认\n优先级：高优先级')
    expect(lastState().state.values.priority).toBe('high')
  })

  it('shows options and recommendations, links evidence, and submits decisions plus custom answers', async () => {
    const root = await mount(`root = Form("review", [scope, evidence, checks], submit: "填入会话草稿")
scope = Question("scope", "范围？", [{label: "共用修复", value: "shared", recommended: true, description: "两端共享验证"}, {label: "桌面先行", value: "desktop", description: "当天可验证"}])
evidence = Bind("scope", path: "choices.0", cases: {shared: Stat("覆盖入口", 2)})
checks = Question("checks", "优先场景？", [{label: "窄窗", value: "narrow"}, {label: "重开", value: "restore"}], multiple: true)`)
    const submit = buttonByText(root, '填入会话草稿')
    const radios = [...root.querySelectorAll<HTMLInputElement>('.shui-question input[type=radio]')]
    const checkboxes = [...root.querySelectorAll<HTMLInputElement>('.shui-question input[type=checkbox]')]
    expect(radios).toHaveLength(2)
    expect(checkboxes).toHaveLength(2)
    expect(submit.disabled).toBe(true)
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(root.querySelector('.shui-question .shui-badge')?.textContent).toBe('推荐')
    const description = root.querySelector('.shui-question-option-description')!
    expect(description.textContent).toBe('两端共享验证')
    expect(radios[0].getAttribute('aria-describedby')).toBe(description.id)
    radios[0].click()
    await nextTick()
    expect(root.querySelector('.shui-stat')?.textContent).toContain('覆盖入口')
    buttonByText(root.querySelector('fieldset')!, '清除选择').click()
    await nextTick()
    expect(root.querySelector('.shui-stat')).toBeNull()
    radios[0].click()
    await nextTick()
    expect(submit.disabled).toBe(true)
    checkboxes[0].click()
    await nextTick()
    checkboxes[1].click()
    await nextTick()
    expect(checkboxes.every(checkbox => checkbox.checked)).toBe(true)
    const notes = [...root.querySelectorAll('textarea')]
    notes[0].value = '加独立编辑器'
    notes[0].dispatchEvent(new Event('input'))
    notes[1].value = '先测长选项换行'
    notes[1].dispatchEvent(new Event('input'))
    await nextTick()
    expect(submit.disabled).toBe(false)
    submit.click()
    await flushPromises()
    expect(lastState().state.actions.at(-1).values).toEqual({
      scope: { choices: ['shared'], text: '加独立编辑器' }, checks: { choices: ['narrow', 'restore'], text: '先测长选项换行' },
    })
    expect(mocks.insertUiDraft).toHaveBeenCalledWith('D:/work/report.shui', '填入会话草稿\n范围？：共用修复\n补充：加独立编辑器\n优先场景？：窄窗、重开\n补充：先测长选项换行')
  })

  it.each([['ended', '原会话已结束，未填入草稿'], ['unbound', '已记录选择，未绑定原会话']] as const)('reports %s draft binding', async (status, message) => {
    mocks.insertUiDraft.mockResolvedValueOnce(status)
    const root = await mount(SOURCE)
    buttonByText(root, '重新构建').click()
    await flushPromises()
    expect(root.textContent).toContain(message)
  })

  it('shows streaming state and placeholders for references not written yet', async () => {
    const root = await mount('root = Stack([head, body])\nhead = Text("先到")')
    expect(root.querySelector('.shui-status-streaming')).not.toBeNull()
    expect(root.querySelector('.shui-pending')?.textContent).toBe('body')
  })

  it.each([false, true])('writes a reordered array through its source owner, editor window: %s', async (editorWindow) => {
    const source = 'root = Stack([a, b])\na = Text("first")\nb = Text("second")'
    const saveSource = vi.fn(async () => undefined)
    const root = await mount(source, editorWindow ? { saveSource } : {})
    const [first, second] = [...root.querySelectorAll<HTMLElement>('.shui-item')]
    const rect = (top: number) => ({ top, bottom: top + 20, left: 0, right: 200, width: 200, height: 20, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    first.getBoundingClientRect = () => rect(0)
    second.getBoundingClientRect = () => rect(30)
    Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => second), configurable: true })

    first.querySelector('.shui-grip')!.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 45 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 45 }))
    await flushPromises()

    if (editorWindow) {
      expect(saveSource).toHaveBeenCalledWith('root = Stack([b, a])\na = Text("first")\nb = Text("second")', source)
      expect(mocks.updateTabContent).not.toHaveBeenCalled()
    } else {
      expect(mocks.updateTabContent).toHaveBeenCalledWith('tab-1', 'root = Stack([b, a])\na = Text("first")\nb = Text("second")')
      expect(mocks.saveTab).toHaveBeenCalledWith('tab-1')
    }
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
