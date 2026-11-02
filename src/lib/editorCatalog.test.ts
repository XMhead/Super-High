import { describe, expect, it } from 'vitest'

import { parseEditorManifest, resolveEditorPage } from './editorCatalog'

describe('editorCatalog', () => {
  it('parses manifest pages and skips templates and escaping entries', () => {
    const raw = JSON.stringify({ version: 1, pages: [
      { id: '物品', entry: './items.html' },
      { entry: 'nested\\quest.html' },
      { id: '模板', entry: 'template.html' },
      { id: '越界', entry: '../outside.html' },
      null,
    ] })

    expect(parseEditorManifest(raw, 'C:/Data/editor/', 'global')).toEqual([
      { scope: 'global', id: '物品', entry: 'items.html', path: 'C:/Data/editor/items.html' },
      { scope: 'global', id: 'nested/quest.html', entry: 'nested/quest.html', path: 'C:/Data/editor/nested/quest.html' },
    ])
    expect(parseEditorManifest('not json', 'C:/Data/editor', 'project')).toEqual([])
  })

  it('resolves which tier an editor page belongs to', () => {
    const data = 'C:\\Users\\A\\AppData\\Roaming\\super-high'
    expect(resolveEditorPage('D:/Project/.superhigh/editor/items.html', 'D:/Project', data))
      .toEqual({ scope: 'project', directory: 'D:/Project/.superhigh/editor', entry: 'items.html' })
    expect(resolveEditorPage('c:/users/a/appdata/roaming/super-high/editor/tool.html', 'D:/Project', data)?.scope).toBe('global')
    expect(resolveEditorPage(`${data}\\system-editors\\skill-overview.html`, 'D:/Project', data))
      .toMatchObject({ scope: 'system', entry: 'skill-overview.html' })
    expect(resolveEditorPage('D:/Project/page.html', 'D:/Project', data)).toBeNull()
    expect(resolveEditorPage('D:/Shared/.superhigh/editor/items.html', 'D:/Project', data, ['D:/Shared']))
      .toEqual({ scope: 'project', directory: 'D:/Shared/.superhigh/editor', entry: 'items.html' })
    expect(resolveEditorPage('D:/Shared/.superhigh/editor/items.html', 'D:/Other', data)).toBeNull()
  })
})
