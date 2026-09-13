import { describe, expect, it } from 'vitest'

import { findScriptToolFileReferences, resolveScriptToolWorkspaceFile } from './scriptToolOutput'

describe('script tool output file references', () => {
  it('extracts workspace-relative paths and optional positions', () => {
    expect(findScriptToolFileReferences('来源：`MythicMobs/Mobs/斗罗/古神析.yml:42:3`')).toEqual([{
      text: 'MythicMobs/Mobs/斗罗/古神析.yml:42:3',
      filePath: 'MythicMobs/Mobs/斗罗/古神析.yml',
      index: 4,
      lineNumber: 42,
      column: 3,
    }])
    expect(findScriptToolFileReferences('见 scripts/report.py#L8')).toEqual([{
      text: 'scripts/report.py#L8',
      filePath: 'scripts/report.py',
      index: 2,
      lineNumber: 8,
      column: undefined,
    }])
  })

  it('only resolves files inside the open workspace', () => {
    const root = 'D:/示例项目/示例项目服务端/plugins'
    expect(resolveScriptToolWorkspaceFile(root, 'MythicMobs/Mobs/boss.yml')).toBe(`${root}/MythicMobs/Mobs/boss.yml`)
    expect(resolveScriptToolWorkspaceFile(root, 'D:/示例项目/示例项目服务端/plugins/MythicMobs/Mobs/boss.yml')).toBe(`${root}/MythicMobs/Mobs/boss.yml`)
    expect(resolveScriptToolWorkspaceFile(root, '../outside.yml')).toBeNull()
    expect(resolveScriptToolWorkspaceFile(root, 'D:/other/boss.yml')).toBeNull()
  })
})
