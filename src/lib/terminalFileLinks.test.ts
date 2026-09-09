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
  it('extracts a quoted Windows path without its quotes', () => {
    const text = 'Open "C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\analysis.json" now.'
    const path = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\analysis.json'

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
        text: 'src\\lib\\terminalFileLinks.ts',
        start: text.indexOf('src\\lib\\terminalFileLinks.ts'),
        end: text.indexOf('src\\lib\\terminalFileLinks.ts') + 'src\\lib\\terminalFileLinks.ts'.length,
      },
    ])
  })

  it('resolves a workspace-relative path with Unicode directory and file names', () => {
    const workspaceRoot = 'D:\\示例项目\\示例项目目录工作区\\plugins'
    const text = '已整理完成：ExampleProject/assets/sample/文档资源/文档文件名单.json'
    const relativePath = 'ExampleProject/assets/sample/文档资源/文档文件名单.json'

    expect(findTerminalFilePathMatches(text, workspaceRoot)).toEqual([{
      path: 'D:\\示例项目\\示例项目目录工作区\\plugins\\ExampleProject\\assets\\sample\\文档资源\\文档文件名单.json',
      text: relativePath,
      start: text.indexOf(relativePath),
      end: text.indexOf(relativePath) + relativePath.length,
    }])
  })

  it('recognizes a workspace-relative folder without requiring a file extension', () => {
    const workspaceRoot = 'D:\\示例项目\\示例项目目录工作区\\plugins'
    const text = '权威组合配置：.skillshare/skills/sample-effect/assets/scenes/sample-scene'
    const relativePath = '.skillshare/skills/sample-effect/assets/scenes/sample-scene'

    expect(findTerminalFilePathMatches(text, workspaceRoot)).toEqual([{
      path: 'D:\\示例项目\\示例项目目录工作区\\plugins\\.skillshare\\skills\\sample-effect\\assets\\scenes\\sample-scene',
      text: relativePath,
      start: text.indexOf(relativePath),
      end: text.indexOf(relativePath) + relativePath.length,
    }])
  })

  it('recognizes Windows home-directory paths for backend resolution', () => {
    const path = '~\\AppData\\Local\\Temp\\preview-task\\final-preview\\frame-005.png'
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
    const relative = 'Documents/outputs/示例文档九月导出记录/示例文档.pdf'
    const split = relative.length - '档.pdf'.length
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

  it.each(['pending', 'native', 'drag', 'disposed'] as const)('handles an external image click with %s resolution', async (mode) => {
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
    const folder = 'D:\\Demo Files\\.skillshare\\skills\\sample-effect\\assets\\scenes\\sample-scene'
    const openFolder = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('目录：.skillshare/skills/sample-effect/assets/scenes/sample-scene'),
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
    expect(link?.text).toBe('.skillshare/skills/sample-effect/assets/scenes/sample-scene')
    link?.activate(new MouseEvent('click'), link.text)
    await vi.waitFor(() => expect(openFolder).toHaveBeenCalledWith(folder))
  })

  it('opens a relative path that xterm wraps before its file name', async () => {
    const workspaceRoot = 'D:\\Demo Files'
    const relativePath = '.skillshare/skills/sample-effect/assets/scenes/sample-scene/scene.json'
    const path = 'D:\\Demo Files\\.skillshare\\skills\\sample-effect\\assets\\scenes\\sample-scene\\scene.json'
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
    const homePath = '~\\AppData\\Local\\Temp\\preview-task\\final-preview\\frame-005.png'
    const resolvedPath = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\final-preview\\frame-005.png'
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
    const path = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-render-analysis\\analysis.json'
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
    const path = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-render-analysis\\analysis.json'
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
    const path = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-render-analysis\\analysis.json'
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
    const path = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-render-analysis\\analysis.json'
    const first = '请输出：C:\\Users\\       ront-'
    const second = '  ┃  Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-   '
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
    const path = 'C:\\Users\\Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-render-analysis\\analysis.json'
    const splitAt = path.indexOf('hq3-front-render-analysis')
    const openFile = vi.fn()
    const provider = createTerminalFileLinkProvider(fakeTerminal([
      fakeLine('请输出：C:\\Users\\       t-'),
      fakeLine('  ┃  Example\\AppData\\Local\\Temp\\preview-task\\sample-authoring\\hq3-front-', true),
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
})
