import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

import { createTerminalFileLinkProvider, findTerminalFilePathMatches, registerTerminalFileLinks } from './terminalFileLinks'

function fakeLine(text: string, isWrapped = false) {
  return {
    isWrapped,
    translateToString: () => text,
    getCell: (column: number) => {
      const char = text[column]
      return char === undefined
        ? undefined
        : { getChars: () => char, getWidth: () => 1 }
    },
  }
}

function fakeTerminal(lines: ReturnType<typeof fakeLine>[], cols = 120) {
  return {
    cols,
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) => lines[index],
      },
    },
  } as unknown as Terminal
}

describe('terminal file links', () => {
  it.each([
    '$env:USERPROFILE/.codex/skills/agent-cleaner/scripts/workspace_cleanup.py',
    '${env:USERPROFILE}/.codex/AGENTS.md',
    '%USERPROFILE%/.claude/CLAUDE.md',
  ])('opens an environment-prefixed command path through the backend: %s', async (input) => {
    const text = `Ran python -B "${input}" scan --root "D:/project"`
    const candidate = input.replace(/\//g, '\\')
    const actual = 'C:\\Users\\Example\\global.md'
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([fakeLine(text)], 200), {
      workspaceRoot: () => 'D:\\project',
      resolvePath: value => value === candidate ? { path: actual, isFile: true } : null,
      openFile,
    })
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const links = callback.mock.calls[0][0]
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(input)
    expect(links[0].range).toEqual({ start: { x: text.indexOf(input) + 1, y: 1 }, end: { x: text.indexOf(input) + input.length, y: 1 } })
    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(openFile).toHaveBeenCalledWith(actual)
  })

  it('recognizes a quoted hidden workspace path inside a PowerShell command', () => {
    const path = '.agent/tmp/konggui-style/skill-doctor.json'
    const text = `Get-Content -LiteralPath '${path}' -TotalCount 20`
    expect(findTerminalFilePathMatches(text, 'D:\\project')).toEqual([{
      path: `D:\\project\\${path.replace(/\//g, '\\')}`, text: path,
      start: text.indexOf(path), end: text.indexOf(path) + path.length,
    }])
  })

  it('opens abbreviated Claude tool headers and their diff line numbers through the resolver', async () => {
    const abbreviated = 'D:\\plugins\\.skillshare\\skills\\blockbench-ani…\\supermodel-player-action-authoring.md'
    const actual = abbreviated.replace('blockbench-ani…', 'blockbench-animation')
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(`● Update(${abbreviated})`), fakeLine('  ⎿ Added 2 lines, removed 1 line'), fakeLine('  17 + changed'),
    ]), { resolvePath: candidate => candidate === abbreviated ? { path: actual, isFile: true } : null, openFile })
    for (const row of [1, 3]) {
      const callback = vi.fn()
      provider.provideLinks(row, callback)
      await vi.waitFor(() => expect(callback).toHaveBeenCalled())
      const links = callback.mock.calls[0][0]
      expect(links).toHaveLength(1)
      links[0].activate({ preventDefault: vi.fn() }, links[0].text)
    }
    expect(openFile.mock.calls).toEqual([[actual], [actual, 17]])
    expect(findTerminalFilePathMatches('Update(skills/blockbench-ani…/authoring.md)', 'D:\\plugins')[0]?.path)
      .toBe('D:\\plugins\\skills\\blockbench-ani…\\authoring.md')
  })

  it.each([
    ['Blockbench/outputs/Cozy Isometric Room/Cozy Isometric Room.bbmodel', '(', ')'],
    ['Blockbench/outputs/Cozy Isometric Room/Cozy Isometric Room.source.gltf', '(', ')'],
    ['新建 文本文档.yml', '（', '）'],
  ])('recognizes the complete rendered link %s', (relative, open, close) => {
    const text = `已更新 ${open}${relative}${close}。`
    expect(findTerminalFilePathMatches(text, 'D:\\plugins')).toEqual([{
      path: `D:\\plugins\\${relative.replace(/\//g, '\\')}`,
      text: relative,
      start: text.indexOf(relative),
      end: text.indexOf(relative) + relative.length,
    }])
  })

  it.each([false, true, 'word'] as const)('opens a spaced model path across CLI rows (wrapped=%s)', async (wrapped) => {
    const first = 'Blockbench/outputs/Cozy Isometric Room/Cozy Isometric'
    const second = ' Room.bbmodel'
    const relative = first + second
    const path = `D:\\plugins\\${relative.replace(/\//g, '\\')}`
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(`- 模型 (${first}${wrapped === 'word' ? '' : second.slice(0, 5)}`),
      fakeLine(`  ${wrapped === 'word' ? second.trimStart() : second.slice(5)})`, wrapped === true),
    ]), {
      workspaceRoot: () => 'D:\\plugins',
      fileExists: (candidate) => candidate === path,
      openFile,
    })
    const callback = vi.fn()
    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const links = callback.mock.calls[0][0]
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(relative)
    expect(links[0].range.start.y).toBe(1)
    expect(links[0].range.end.y).toBe(2)
    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(openFile).toHaveBeenCalledWith(path)
  })

  it('recognizes web links without surrounding punctuation or resolving them as files', async () => {
    const url = 'https://example.com/docs/page_(one)?q=hello#part'
    const openUrl = vi.fn()
    const resolvePath = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([fakeLine(`See (${url}).`)]), {
      workspaceRoot: () => 'D:\\Demo', openFile: vi.fn(), openUrl, resolvePath,
    })
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const links = callback.mock.calls[0][0]
    expect(links).toHaveLength(1)
    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(openUrl).toHaveBeenCalledWith(url)
    expect(resolvePath).not.toHaveBeenCalled()
  })

  it.each([false, true])('opens an encoded file URI split across CLI rows (wrapped=%s)', async (wrapped) => {
    const prefix = 'file:///C:/Demo%20Files/generated_images/'
    const suffix = 'result%20one.png'
    const path = 'C:\\Demo Files\\generated_images\\result one.png'
    const openFile = vi.fn()
    const resolvePath = vi.fn().mockImplementation((candidate) => candidate === path ? { path, isFile: true } : null)
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(prefix), fakeLine(suffix, wrapped),
    ], prefix.length), { openFile, resolvePath })
    const callback = vi.fn()
    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const links = callback.mock.calls[0][0]
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe(prefix + suffix)
    expect(links[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: suffix.length, y: 2 } })
    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(openFile).toHaveBeenCalledWith(path)
  })

  it('opens a plain web URL reflowed by the CLI', async () => {
    const prefix = 'https://example.com/engineering/'
    const suffix = 'equipping-agents-with-skills'
    const openUrl = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(prefix), fakeLine(suffix),
    ], prefix.length), { openFile: vi.fn(), openUrl })
    const callback = vi.fn()
    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const link = callback.mock.calls[0][0][0]
    link.activate(new MouseEvent('click'), link.text)
    expect(openUrl).toHaveBeenCalledWith(prefix + suffix)
  })

  it('does not append the next indented status to a web URL', async () => {
    const url = 'https://example.com/docs'
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(url), fakeLine('  Waiting for output'),
    ]), { openFile: vi.fn(), openUrl: vi.fn() })
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback.mock.calls[0][0].map((link: { text: string }) => link.text)).toEqual([url])
  })

  it('extracts a quoted Windows path without its quotes', () => {
    const text = 'Open "C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\analysis.json" now.'
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\analysis.json'

    expect(findTerminalFilePathMatches(text)).toEqual([{
      path,
      text: path,
      start: text.indexOf(path),
      end: text.indexOf(path) + path.length,
    }])
  })

  it('resolves a bare CLI file name against the workspace root', () => {
    const workspaceRoot = 'D:\\Demo Files'
    const text = 'Updated capacitor.config.ts and src\\lib\\terminalFileLinks.ts:42.'

    expect(findTerminalFilePathMatches(text, workspaceRoot)).toEqual([
      {
        path: 'D:\\Demo Files\\capacitor.config.ts',
        text: 'capacitor.config.ts',
        start: text.indexOf('capacitor.config.ts'),
        end: text.indexOf('capacitor.config.ts') + 'capacitor.config.ts'.length,
      },
      {
        path: 'D:\\Demo Files\\src\\lib\\terminalFileLinks.ts',
        text: 'src\\lib\\terminalFileLinks.ts:42',
        lineNumber: 42,
        start: text.indexOf('src\\lib\\terminalFileLinks.ts'),
        end: text.indexOf('src\\lib\\terminalFileLinks.ts') + 'src\\lib\\terminalFileLinks.ts:42'.length,
      },
    ])
  })

  it('resolves a workspace-relative path with Unicode directory and file names', () => {
    const workspaceRoot = 'D:\\示例项目\\示例项目目录名服务端\\plugins'
    const text = '已整理完成：SuperModel/assets/lidless/技能模型/技能模型文件名单.json'
    const relativePath = 'SuperModel/assets/lidless/技能模型/技能模型文件名单.json'

    expect(findTerminalFilePathMatches(text, workspaceRoot)).toEqual([{
      path: 'D:\\示例项目\\示例项目目录名服务端\\plugins\\SuperModel\\assets\\lidless\\技能模型\\技能模型文件名单.json',
      text: relativePath,
      start: text.indexOf(relativePath),
      end: text.indexOf(relativePath) + relativePath.length,
    }])
  })

  it('recognizes a workspace-relative folder without requiring a file extension', () => {
    const workspaceRoot = 'D:\\示例项目\\示例项目目录名服务端\\plugins'
    const text = '权威组合配置：.skillshare/skills/snowstorm-particle/assets/scenes/kunlun-serpent-phase3'
    const relativePath = '.skillshare/skills/snowstorm-particle/assets/scenes/kunlun-serpent-phase3'

    expect(findTerminalFilePathMatches(text, workspaceRoot)).toEqual([{
      path: 'D:\\示例项目\\示例项目目录名服务端\\plugins\\.skillshare\\skills\\snowstorm-particle\\assets\\scenes\\kunlun-serpent-phase3',
      text: relativePath,
      start: text.indexOf(relativePath),
      end: text.indexOf(relativePath) + relativePath.length,
    }])
  })

  it('recognizes Windows home-directory paths for backend resolution', () => {
    const path = '~\\AppData\\Local\\Temp\\blockbench-agent\\final-preview\\frame-005.png'
    const text = `Viewed Image ${path}`

    expect(findTerminalFilePathMatches(text)).toEqual([{
      path,
      text: path,
      start: text.indexOf(path),
      end: text.indexOf(path) + path.length,
    }])
  })

  it('resolves parent-directory paths for backend normalization', () => {
    expect(findTerminalFilePathMatches('../outside.ts', 'D:\\Demo Files')[0]?.path).toBe('D:\\Demo Files\\..\\outside.ts')
  })

  it.each([1, 2])('opens a relative Chinese model path across CLI rows from row %s', async (row) => {
    const relative = 'Blockbench/outputs/梵高夜间露天咖啡座9月6号06时25分48秒/夜间露天咖啡座.bbmodel'
    const split = relative.length - '座.bbmodel'.length
    const path = `D:\\plugins\\${relative.replace(/\//g, '\\')}`
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(`- 打开地图模型 (${relative.slice(0, split)}`),
      fakeLine(`  ${relative.slice(split)})`),
      fakeLine('- 六个视频的方法与原片证据 (.skillshare/skills/bb-map/建筑方法.md)'),
    ]), {
      workspaceRoot: () => 'D:\\plugins',
      fileExists: (candidate) => candidate === path,
      openFile,
    })
    const callback = vi.fn()
    provider.provideLinks(row, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const link = callback.mock.calls[0]?.[0]?.[0]
    expect(link?.text).toBe(relative)
    expect(link?.range.start.y).toBe(1)
    expect(link?.range.end.y).toBe(2)
    link.activate(new MouseEvent('click'), link.text)
    expect(openFile).toHaveBeenCalledWith(path)
  })

  it.each(['pending', 'native', 'osc', 'drag', 'disposed'] as const)('handles an external image click with %s resolution', async (mode) => {
    const path = 'E:\\新建文件夹\\图鉴卡片.png'
    const terminal = fakeTerminal([fakeLine(path)], 120)
    const element = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    element.append(screen)
    screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 200 } as DOMRect)
    let resolve!: (value: boolean) => void
    const check = new Promise<boolean>((done) => { resolve = done })
    Object.assign(terminal, {
      element, rows: 10, hasSelection: () => mode === 'drag',
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    })
    Object.assign(terminal.buffer.active, { viewportY: 0 })
    const openFile = vi.fn()
    const registration = registerTerminalFileLinks(terminal, {
      workspaceRoot: () => 'D:\\plugins', fileExists: () => check, openFile,
    })
    element.dispatchEvent(new MouseEvent('mousedown', { clientX: 15, clientY: 10 }))
    if (mode === 'osc') registration.markActivated()
    if (mode === 'native') {
      resolve(true)
      const provider = vi.mocked(terminal.registerLinkProvider).mock.calls[0][0]
      const callback = vi.fn()
      provider.provideLinks(1, callback)
      await vi.waitFor(() => expect(callback).toHaveBeenCalled())
      const link = callback.mock.calls[0][0][0]
      link.activate(new MouseEvent('mouseup'), path)
    }
    element.dispatchEvent(new MouseEvent('click', { clientX: 15, clientY: 10 }))
    if (mode !== 'native') expect(openFile).not.toHaveBeenCalled()
    if (mode === 'disposed') registration.dispose()
    resolve(true)
    if (mode === 'pending' || mode === 'native') {
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
      expect(openFile).toHaveBeenCalledTimes(1)
    } else {
      await check
      await new Promise((done) => setTimeout(done, 0))
      expect(openFile).not.toHaveBeenCalled()
    }
    registration.dispose()
  })

  it('opens a verified workspace-relative path', async () => {
    const workspaceRoot = 'D:\\Demo Files'
    const targetPath = 'D:\\Demo Files\\capacitor.config.ts'
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('Modified capacitor.config.ts'),
    ]), {
      workspaceRoot: () => workspaceRoot,
      fileExists: vi.fn().mockImplementation((candidate: string) => candidate === targetPath),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const links = callback.mock.calls[0]?.[0]
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('capacitor.config.ts')
    links[0]?.activate(new MouseEvent('click'), 'capacitor.config.ts')
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(targetPath))
  })

  it('opens a verified folder in Explorer instead of trying to preview it as a file', async () => {
    const workspaceRoot = 'D:\\Demo Files'
    const folder = 'D:\\Demo Files\\.skillshare\\skills\\snowstorm-particle\\assets\\scenes\\kunlun-serpent-phase3'
    const openFolder = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('目录：.skillshare/skills/snowstorm-particle/assets/scenes/kunlun-serpent-phase3'),
    ]), {
      workspaceRoot: () => workspaceRoot,
      resolvePath: vi.fn().mockResolvedValue({ path: folder, isFile: false }),
      openFile: vi.fn(),
      openFolder,
    })
    const callback = vi.fn()

    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const link = callback.mock.calls[0]?.[0]?.[0]
    expect(link?.text).toBe('.skillshare/skills/snowstorm-particle/assets/scenes/kunlun-serpent-phase3')
    link?.activate(new MouseEvent('click'), link.text)
    await vi.waitFor(() => expect(openFolder).toHaveBeenCalledWith(folder))
  })

  it('opens a relative path that xterm wraps before its file name', async () => {
    const workspaceRoot = 'D:\\Demo Files'
    const relativePath = '.skillshare/skills/snowstorm-particle/assets/scenes/kunlun-serpent-phase3/scene.json'
    const path = 'D:\\Demo Files\\.skillshare\\skills\\snowstorm-particle\\assets\\scenes\\kunlun-serpent-phase3\\scene.json'
    const splitAt = relativePath.lastIndexOf('scene.json')
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(`权威组合配置：${relativePath.slice(0, splitAt)}`),
      fakeLine(relativePath.slice(splitAt), true),
    ]), {
      workspaceRoot: () => workspaceRoot,
      resolvePath: vi.fn().mockResolvedValue({ path, isFile: true }),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const link = callback.mock.calls[0]?.[0]?.[0]
    expect(link?.text).toBe(relativePath)
    expect(link?.range.start.y).toBe(1)
    expect(link?.range.end.y).toBe(2)
    link?.activate(new MouseEvent('click'), relativePath)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
  })

  it('opens a home-directory path after backend expansion', async () => {
    const homePath = '~\\AppData\\Local\\Temp\\blockbench-agent\\final-preview\\frame-005.png'
    const resolvedPath = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\final-preview\\frame-005.png'
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(`Viewed Image ${homePath}`),
    ]), {
      resolvePath: vi.fn().mockResolvedValue({ path: resolvedPath, isFile: true }),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const link = callback.mock.calls[0]?.[0]?.[0]
    expect(link?.text).toBe(homePath)
    link?.activate(new MouseEvent('click'), homePath)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(resolvedPath))
  })

  it('opens a verified path that spans wrapped terminal rows', async () => {
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-render-analysis\\analysis.json'
    const first = `"${path.slice(0, 71)}`
    const second = `${path.slice(71)}"`
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(first),
      fakeLine(second, true),
    ]), {
      fileExists: vi.fn().mockResolvedValue(true),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const links = callback.mock.calls[0]?.[0]
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(path)
    expect(links[0]?.range.start.y).toBe(1)
    expect(links[0]?.range.end.y).toBe(2)
    links[0]?.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
  })

  it('opens a verified path that a CLI reflows into indented terminal rows', async () => {
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-render-analysis\\analysis.json'
    const splitAt = path.indexOf('front-render-analysis')
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(`• ${path.slice(0, splitAt)}   `),
      fakeLine(`  ${path.slice(splitAt)}`),
    ]), {
      fileExists: vi.fn().mockResolvedValue(true),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const links = callback.mock.calls[0]?.[0]
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(path)
    expect(links[0]?.range.start.y).toBe(1)
    expect(links[0]?.range.end.y).toBe(2)
    links[0]?.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
  })

  it('opens a verified path that a CLI reflows at the terminal edge without indentation', async () => {
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-render-analysis\\analysis.json'
    const splitAt = 88
    const first = path.slice(0, splitAt)
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(first),
      fakeLine(path.slice(splitAt)),
    ], first.length), {
      fileExists: vi.fn().mockResolvedValue(true),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const links = callback.mock.calls[0]?.[0]
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(path)
    expect(links[0]?.range.start.y).toBe(1)
    expect(links[0]?.range.end.y).toBe(2)
    links[0]?.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
  })

  it('opens a verified path across OpenCode gutter rows', async () => {
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-render-analysis\\analysis.json'
    const first = '请输出：C:\\Users\\       ront-'
    const second = '  ┃  ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-   '
    const third = '  ┃  render-analysis\\analysis.json'
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine(first),
      fakeLine(second, true),
      fakeLine(third, true),
    ]), {
      fileExists: vi.fn().mockImplementation((candidate: string) => candidate === path),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(3, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const links = callback.mock.calls[0]?.[0]
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(path)
    expect(links[0]?.range.start.y).toBe(1)
    expect(links[0]?.range.end.y).toBe(3)
    links[0]?.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
  })

  it('opens an OpenCode response path when its full-screen rows are all marked wrapped', async () => {
    const path = 'C:\\Users\\ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-render-analysis\\analysis.json'
    const splitAt = path.indexOf('hq3-front-render-analysis')
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('请输出：C:\\Users\\       t-'),
      fakeLine('  ┃  ExampleUser01\\AppData\\Local\\Temp\\blockbench-agent\\ancient-treant-authoring-20260823\\hq3-front-', true),
      fakeLine('  ┃  render-analysis\\analysis.json', true),
      fakeLine('     + Thought: 652ms', true),
      fakeLine(`     ${path.slice(0, splitAt)}`, true),
      fakeLine(`     ${path.slice(splitAt)}`, true),
    ]), {
      fileExists: vi.fn().mockImplementation((candidate: string) => candidate === path),
      openFile,
    })
    const callback = vi.fn()

    provider.provideLinks(6, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())

    const links = callback.mock.calls[0]?.[0]
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe(path)
    expect(links[0]?.range.start.y).toBe(5)
    expect(links[0]?.range.end.y).toBe(6)
    links[0]?.activate(new MouseEvent('click'), path)
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(path))
  })

  it('does not link a path until the local file check succeeds', async () => {
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('C:\\missing\\analysis.json'),
    ]), {
      fileExists: vi.fn().mockResolvedValue(false),
      openFile: vi.fn(),
    })
    const callback = vi.fn()

    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(undefined))
  })

  it.each([
    ['● Update(scripts\\recolor_gif_palette.py)', '  ⎿  Added 1 line, removed 1 line'],
    ['• Edited scripts/recolor_gif_palette.py (+1 -1)', ''],
  ])('opens a diff line number at that line under %s', async (header, summary) => {
    const path = 'D:\\Demo\\scripts\\recolor_gif_palette.py'
    const openFile = vi.fn()
    const rows = [
      header,
      summary,
      '      468                "lightest": rgb_hex(lightest),',
      '      471 -          _, report_key, target_report = target_palette_from_args(args, selector)',
      '      471 +          _, report_key, target_report = target_palette_from_args(args,',
      '          args.target_selector)',
    ]
    const provider = createTerminalFileLinkProvider(fakeTerminal(rows.map((row) => fakeLine(row))), {
      workspaceRoot: () => 'D:\\Demo',
      fileExists: (candidate) => candidate === path,
      openFile,
    })

    const callback = vi.fn()
    provider.provideLinks(5, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const links = callback.mock.calls[0][0]
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe('471')
    expect(links[0].range).toEqual({ start: { x: 7, y: 5 }, end: { x: 9, y: 5 } })
    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(openFile).toHaveBeenCalledWith(path, 471)

    const continuation = vi.fn()
    provider.provideLinks(6, continuation)
    await vi.waitFor(() => expect(continuation).toHaveBeenCalledWith(undefined))
  })

  it('links the first diff row after the tool summary gutter', async () => {
    const path = 'D:\\Demo\\a.py'
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('● Write(a.py)'),
      fakeLine('  ⎿  600'),
    ]), { workspaceRoot: () => 'D:\\Demo', fileExists: (candidate) => candidate === path, openFile })

    const callback = vi.fn()
    provider.provideLinks(2, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const links = callback.mock.calls[0][0]
    expect(links[0].range.start.x).toBe(6)
    links[0].activate(new MouseEvent('click'), links[0].text)
    expect(openFile).toHaveBeenCalledWith(path, 600)
  })

  it('does not link numbers outside an edit tool diff', async () => {
    const fileExists = vi.fn().mockReturnValue(true)
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('● Update(a.py)'),
      fakeLine('      1 +x = 1'),
      fakeLine('● Bash(wc -l a.py)'),
      fakeLine('      42 lines'),
    ]), { workspaceRoot: () => 'D:\\Demo', fileExists, openFile: vi.fn() })

    const callback = vi.fn()
    provider.provideLinks(4, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(undefined))
    expect(fileExists).not.toHaveBeenCalled()
  })
})

it.each([
  [1, '  └ Hide details', false],
  [2, '  └ Hide details', false],
  [1, '    − Hide details', true],
  [2, '    − Hide details', true],
  [1, '    + Show details', true],
  [2, '    + Show details', true],
] as const)('opens the Chinese Viewed image path from row %s before %s (wrapped=%s)', async (row, details, wrapped) => {
  const first = 'D:\\我的世界\\示例游戏服务器\\plugins\\client\\.minecraft\\screenshots\\blackboxpro\\NO_mc\\fixture-native-'
  const second = 'unification\\003_native-cube.png'
  const path = (first + second).replace(/\//g, '\\')
  const openFile = vi.fn()
  const provider = createTerminalFileLinkProvider(fakeTerminal([
    fakeLine(`• Viewed image ${first}`), fakeLine(`  ${second}`), fakeLine(details, wrapped),
  ], 160), { resolvePath: candidate => candidate === path ? { path, isFile: true } : null, openFile })
  const callback = vi.fn()
  provider.provideLinks(row, callback)
  await vi.waitFor(() => expect(callback).toHaveBeenCalled())
  const links = callback.mock.calls[0][0]
  expect(links).toHaveLength(1)
  expect(links[0].text).toBe(first + second)
  expect(links[0].range.start.y).toBe(1)
  expect(links[0].range.end.y).toBe(2)
  links[0].activate(new MouseEvent('click'), links[0].text)
  expect(openFile).toHaveBeenCalledWith(path)
})

it.each(['    − Hide details', '    - Hide details', '    + Show details'])('keeps %s outside a single-row path even when marked wrapped', async (details) => {
  const path = 'D:\\images\\003_native-cube.png'
  const openFile = vi.fn()
  const provider = createTerminalFileLinkProvider(fakeTerminal([
    fakeLine(`• Viewed image ${path}`), fakeLine(details, true),
  ]), { resolvePath: candidate => candidate === path ? { path, isFile: true } : null, openFile })
  const callback = vi.fn()
  provider.provideLinks(1, callback)
  await vi.waitFor(() => expect(callback).toHaveBeenCalled())
  const links = callback.mock.calls[0][0]
  expect(links).toHaveLength(1)
  expect(links[0].text).toBe(path)
  expect(links[0].range.end).toEqual({ x: `• Viewed image ${path}`.length, y: 1 })
  links[0].activate(new MouseEvent('click'), links[0].text)
  expect(openFile).toHaveBeenCalledWith(path)
  const detailsCallback = vi.fn()
  provider.provideLinks(2, detailsCallback)
  await vi.waitFor(() => expect(detailsCallback).toHaveBeenCalledWith(undefined))
})

it.each(['plugins\\.agent\\tmp\\preview\\v1\\', 'Plugins/.agent/tmp/preview/v1/', '.agent/tmp/preview/v1/'])('resolves workspace-prefixed directory %s', reference => {
  const [match] = findTerminalFilePathMatches(`文件：${reference}，里面有图片`, 'D:\\server\\plugins')
  expect(match?.path).toBe('D:\\server\\plugins\\.agent\\tmp\\preview\\v1\\')
  expect(match?.text).toBe(reference)
})

it('keeps explicit relative subdirectories with the same name as the workspace', () => {
  const [match] = findTerminalFilePathMatches('./plugins/image.png', 'D:\\server\\plugins')
  expect(match?.path).toBe('D:\\server\\plugins\\plugins\\image.png')
})

it('recognizes a single relative folder and leaves different workspace name prefixes intact', () => {
  expect(findTerminalFilePathMatches('`preview/`', 'D:/plugins')[0]?.path).toBe('D:\\plugins\\preview\\')
  expect(findTerminalFilePathMatches('plugins-other/file.png', 'D:/plugins')[0]?.path).toBe('D:\\plugins\\plugins-other\\file.png')
})

describe('session corpus link compatibility', () => {
  it('decodes literal filename hashes once without turning them into heading fragments', () => {
    const [match] = findTerminalFilePathMatches('file:///D:/demo/note.md%23draft.md', 'D:/demo')
    expect(match?.path).toBe('D:\\demo\\note.md#draft.md')
    expect(match?.anchor).toBeUndefined()
  })
  it.each([
    ['src/components/EditorPane.test.ts:415:75', 'src/components/EditorPane.test.ts', { lineNumber: 415, column: 75 }],
    ['src/components/TerminalPane.vue#L365', 'src/components/TerminalPane.vue', { lineNumber: 365 }],
    ['.agent/tmp/candidate.ps1#L346-L359', '.agent/tmp/candidate.ps1', { lineNumber: 346, endLineNumber: 359 }],
    ['render-performance.md#大图集加载与上传', 'render-performance.md', { anchor: '大图集加载与上传' }],
    ['BlockModel/BlockModel (2).yml', 'BlockModel/BlockModel (2).yml', {}],
    ['minecraft-decompiler/tools/runtime/jdk-17.0.20+8-jre/legal/java.xml/bcel.md:1', 'minecraft-decompiler/tools/runtime/jdk-17.0.20+8-jre/legal/java.xml/bcel.md', { lineNumber: 1 }],
    ['.gitignore', '.gitignore', {}],
    ['.env', '.env', {}],
    ['Dockerfile', 'Dockerfile', {}],
    ['LICENSE', 'LICENSE', {}],
  ])('recognizes the complete existing-file candidate %s', (input, relative, position) => {
    const [match] = findTerminalFilePathMatches(input, 'D:/Example Workspace')
    expect(match).toMatchObject({ path: `D:\\Example Workspace\\${relative.replace(/\//g, '\\')}`, text: input, start: 0, end: input.length, ...position })
  })

  it.each([
    ['src/app.ts:12:8', 12, { column: 8 }],
    ['src/app.ts#L12C3-L20C8', 12, { column: 3, endLineNumber: 20, endColumn: 8 }],
    ['file:///D:/Demo/src/app.ts:12:8', 12, { column: 8 }],
    ['README.md#build', undefined, { anchor: 'build' }],
  ])('passes locations to the terminal opener for %s', async (input, lineNumber, position) => {
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([fakeLine(input)], 200), {
      workspaceRoot: () => 'D:/Demo', resolvePath: path => ({ path, isFile: true }), openFile,
    })
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    const link = callback.mock.calls[0][0][0]
    link.activate(new MouseEvent('click'), link.text)
    expect(openFile).toHaveBeenCalledWith(expect.any(String), lineNumber, position)
  })

  it('strips a/b prefixes only in Git patch headers, even under a workspace named a', () => {
    const [patch] = findTerminalFilePathMatches('+++ b/src/main.ts', 'D:/a/demo')
    expect(patch?.path).toBe('D:\\a\\demo\\src\\main.ts')
    expect(findTerminalFilePathMatches('--- a/src/main.ts', 'D:/a')[0]?.path).toBe('D:\\a\\src\\main.ts')
    expect(findTerminalFilePathMatches('+++ b/src/main.ts', 'D:/src')[0]?.path).toBe('D:\\src\\src\\main.ts')
    expect(findTerminalFilePathMatches('a/src/main.ts', 'D:/demo')[0]?.path).toBe('D:\\demo\\a\\src\\main.ts')
  })

  it('handles protocol-free websites and Chinese prose around URLs without changing URL contents', () => {
    const text = '链接（https://github.com/example/repo/pull/1600)），另见 www.totaltypescript.com/docs#solution-3。'
    expect(findTerminalFilePathMatches(text, 'D:/demo').map(match => match.path)).toEqual([
      'https://github.com/example/repo/pull/1600', 'https://www.totaltypescript.com/docs#solution-3',
    ])
  })
})
