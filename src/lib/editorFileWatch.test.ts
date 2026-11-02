import { describe, it, expect } from 'vitest'
import { parseEditorFileWatch, editorWatchPaths } from './editorFileWatch'

describe('editor file watch boundaries', () => {
  const scopes = parseEditorFileWatch([
    { path: 'Config/config.yml', kind: 'file' },
    { path: 'Data/skills', kind: 'directory', recursive: true, extensions: ['.yml'] },
    { path: 'Data/icons', kind: 'directory', extensions: ['.png'] },
  ])
  it('keeps exact files, directory boundaries and explicit recursion', () => {
    expect(editorWatchPaths(scopes, ['Config/config.yml', 'Config/other.yml', 'Data/skills/nested/a.yml', 'Data/skills2/a.yml', 'Data/skills/a.txt', 'Data/icons/a.png', 'Data/icons/nested/a.png'], 'modify'))
      .toEqual(['Config/config.yml', 'Data/skills/nested/a.yml', 'Data/icons/a.png'])
  })
  it('handles deleted ancestors, renames and overflow without a workspace-root fallback', () => {
    expect(editorWatchPaths(scopes, ['Data', 'Data/skills/nested', 'Data/skills/no.txt'], 'remove')).toEqual(['Data', 'Data/skills/nested'])
    expect(editorWatchPaths(scopes, ['Config/config.yml', 'Config/renamed.yml'], 'rename')).toEqual(['Config/config.yml'])
    expect(editorWatchPaths(scopes, [], 'rescan')).toEqual(['Config/config.yml', 'Data/skills', 'Data/icons'])
    expect(editorWatchPaths([], ['anywhere/file.yml'], 'rescan')).toEqual([])
  })
  it('rejects broad or invalid declarations before creating the editor', () => {
    for (const path of ['.', '../Data', '/Data', 'C:/Data', 'Data/../Other']) expect(() => parseEditorFileWatch([{ path, kind: 'directory' }])).toThrow()
    expect(() => parseEditorFileWatch([{ path: 'config.yml', kind: 'file', recursive: true }])).toThrow()
    expect(() => parseEditorFileWatch([{ path: 'Data', kind: 'directory', extensions: ['yaml'] }])).toThrow()
    expect(parseEditorFileWatch(undefined)).toEqual([])
  })
})
