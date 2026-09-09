import { describe, expect, it } from 'vitest'

import { findScriptToolFileReferences, resolveScriptToolWorkspaceFile } from './scriptToolOutput'

describe('script tool output file references', () => {
  it('extracts workspace-relative paths and optional positions', () => {
    expect(findScriptToolFileReferences('来源：`Mobs/example.yml:42:3`')).toEqual([{
      text: 'Mobs/example.yml:42:3',
      filePath: 'Mobs/example.yml',
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
    const root = 'D:/Work/server/plugins'
    expect(resolveScriptToolWorkspaceFile(root, 'Mobs/boss.yml')).toBe(`${root}/Mobs/boss.yml`)
    expect(resolveScriptToolWorkspaceFile(root, 'D:/Work/server/plugins/Mobs/boss.yml')).toBe(`${root}/Mobs/boss.yml`)
    expect(resolveScriptToolWorkspaceFile(root, '../outside.yml')).toBeNull()
    expect(resolveScriptToolWorkspaceFile(root, 'D:/other/boss.yml')).toBeNull()
  })
})
