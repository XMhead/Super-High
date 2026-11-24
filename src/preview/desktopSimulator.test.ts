import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installDesktopSimulator } from './desktopSimulator'
import { backend } from '@/lib/tauri'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), store: { settings: { themeId: 'dark' }, openProject: vi.fn(async () => true) } }))
vi.mock('@/lib/tauri', () => ({ backend: { readFile: vi.fn(), readEditorFile: vi.fn(), writeFile: vi.fn() } }))
vi.mock('@/lib/theme', () => ({ applyTheme: vi.fn() }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => mocks.store }))
vi.mock('./workspaceSource', () => ({ previewPathName: (path: string) => path, openPreviewSource: async () => ({ rootPath: 'D:/Source', name: 'Source', displayName: 'Source', readTextFile: mocks.read, writeFile: mocks.write }) }))

beforeEach(() => { mocks.read.mockReset(); mocks.write.mockReset(); mocks.store.openProject.mockClear() })
describe('desktop editor source adapter', () => {
  it.each(['simulate', 'readonly'] as const)('reads source and overlay text with the editor contract in %s mode', async mode => {
    const content = new Map([['D:/Source/a.ts', 'const value = "真实源码"']])
    mocks.read.mockImplementation(async path => {
      if (!content.has(path)) throw new Error('路径超出源码目录')
      return content.get(path)
    })
    mocks.write.mockImplementation((path, text) => content.set(path, text))
    const simulator = await installDesktopSimulator(createPinia(), { scenario: 'empty', mode, persist: false })
    try {
      expect(await backend.readEditorFile('D:/Source/a.ts')).toEqual({ content: 'const value = "真实源码"', encoding: 'utf-8' })
      expect(mocks.read).toHaveBeenCalledWith('D:/Source/a.ts')
      if (mode === 'simulate') {
        await backend.writeFile('D:/Source/a.ts', '覆盖层内容')
        expect(await backend.readEditorFile('D:/Source/a.ts')).toEqual({ content: '覆盖层内容', encoding: 'utf-8' })
      } else {
        await expect(backend.writeFile('D:/Source/a.ts', '覆盖层内容')).rejects.toThrow('当前预览不允许写入文件')
        expect(mocks.write).not.toHaveBeenCalled()
      }
      await expect(backend.readEditorFile('E:/Outside/a.ts')).rejects.toThrow('路径超出源码目录')
    } finally { simulator.dispose() }
  })
})
