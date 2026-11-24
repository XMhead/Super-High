import { beforeEach, expect, it, vi } from 'vitest'
import { openEditorWindow } from './editorWindows'
import { backend } from './tauri'
import type { Workspace } from '@/types'

vi.mock('./tauri', () => ({ backend: {
  getAppStorageInfo: vi.fn(async () => ({ dataDir: 'C:/Data' })),
  listExtensionProjectRoots: vi.fn(async (root: string) => [root]),
  readFile: vi.fn(async (path: string) => JSON.stringify({ version: 1, pages: [{ id: 'items', entry: path.startsWith('C:') ? 'global.html' : 'items.html' }] })),
  openEditorWindow: vi.fn(async () => 'editor-window'),
} }))
const workspace: Workspace = { id: 'one', name: 'One', displayName: 'One', rootPath: 'D:/One', openedAt: '' }
beforeEach(() => vi.clearAllMocks())

it('opens an empty independent window bound to the invoking workspace', async () => {
  expect(await openEditorWindow(workspace)).toBe('editor-window')
  expect(backend.openEditorWindow).toHaveBeenCalledWith(workspace, undefined)
})
it('resolves project editors before global editors and forwards parameters', async () => {
  await openEditorWindow(workspace, { id: 'items', parameters: { tab: 'weapons', count: 2 } })
  expect(backend.openEditorWindow).toHaveBeenLastCalledWith(workspace, {
    path: 'D:/One/.superhigh/editor/items.html', title: 'items', parameters: { tab: 'weapons', count: 2 },
  })
  await openEditorWindow(workspace, { id: 'items', scope: 'global' })
  expect(backend.openEditorWindow).toHaveBeenLastCalledWith(workspace, {
    path: 'C:/Data/editor/global.html', title: 'items', parameters: {},
  })
})
it('reports missing workspace and unknown editors before creating a window', async () => {
  await expect(openEditorWindow(null)).rejects.toThrow('工作区')
  await expect(openEditorWindow(workspace, { id: 'missing' })).rejects.toThrow('missing')
  expect(backend.openEditorWindow).not.toHaveBeenCalled()
})
