import { describe, expect, it } from 'vitest'

import { buildYamlColorPreviewLines } from './yamlColorPreview'

describe('buildYamlColorPreviewLines', () => {
  it('marks yaml keys separators list markers strings comments and plain values', () => {
    const lines = buildYamlColorPreviewLines("goblin_helmet:\n  material: COAL\n  name: '§#1fcc7f哥布林头盔'\n  lore:\n  - 类型=§f头部\n  # note")

    expect(lines[0].segments.map((segment) => segment.kind)).toEqual(['key', 'separator'])
    expect(lines[1].segments.map((segment) => segment.kind)).toEqual(['indent', 'key', 'separator', 'value'])
    expect(lines[2].segments.map((segment) => segment.kind)).toEqual(['indent', 'key', 'separator', 'string', 'string'])
    expect(lines[2].segments.filter((segment) => segment.color).map((segment) => segment.color)).toEqual(['#1FCC7F'])
    expect(lines[4].segments.map((segment) => segment.kind)).toEqual(['indent', 'listMarker', 'value', 'value'])
    expect(lines[4].segments.filter((segment) => segment.color).map((segment) => segment.color)).toEqual(['#FFFFFF'])
    expect(lines[5].segments.map((segment) => segment.kind)).toEqual(['indent', 'comment'])
  })

  it('preserves yaml token kinds while splitting Minecraft and rgba color spans', () => {
    const lines = buildYamlColorPreviewLines("item:\n  name: '&a绿色 §c红色 rgba(255,0,128,0.5)'")
    const colored = lines[1].segments
      .filter((segment) => segment.color)
      .map((segment) => ({ kind: segment.kind, text: segment.text, color: segment.color }))

    expect(colored).toEqual([
      { kind: 'string', text: '&a绿色 ', color: '#55FF55' },
      { kind: 'string', text: '§c红色 ', color: '#FF5555' },
      { kind: 'string', text: 'rgba(255,0,128,0.5)', color: 'rgba(255, 0, 128, 0.5)' },
      { kind: 'string', text: "'", color: '#FF5555' },
    ])
  })

})
