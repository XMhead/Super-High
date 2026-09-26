import { describe, expect, it } from 'vitest'

import { replaceItemYamlBlockInFile } from './itemYamlBlockEdit'

describe('replaceItemYamlBlockInFile', () => {
  it('replaces only the target top-level item block and keeps sibling items', () => {
    const content = [
      'before_item:',
      "  name: '外部新增'",
      '',
      'goblin_helmet:',
      "  name: '&a旧头盔'",
      '  material: IRON_HELMET',
      '',
      'wolf_pelt:',
      "  name: '狼皮'",
      '  material: LEATHER',
      '',
    ].join('\n')

    const result = replaceItemYamlBlockInFile(content, {
      itemKey: 'goblin_helmet',
      lineNumber: 4,
      nextBlock: [
        'goblin_helmet:',
        "  name: '&b新头盔'",
        '  material: DIAMOND_HELMET',
      ].join('\n'),
    })

    expect(result.content).toBe([
      'before_item:',
      "  name: '外部新增'",
      '',
      'goblin_helmet:',
      "  name: '&b新头盔'",
      '  material: DIAMOND_HELMET',
      '',
      'wolf_pelt:',
      "  name: '狼皮'",
      '  material: LEATHER',
      '',
    ].join('\n'))
    expect(result.startLineNumber).toBe(4)
  })

  it('finds the item by key when external edits shifted the original line number', () => {
    const content = [
      'external_insert:',
      '  material: STONE',
      '',
      'target_item:',
      '  material: COAL',
      '',
      'other_item:',
      '  material: DIRT',
      '',
    ].join('\n')

    const result = replaceItemYamlBlockInFile(content, {
      itemKey: 'target_item',
      lineNumber: 1,
      nextBlock: 'target_item:\n  material: IRON_INGOT',
    })

    expect(result.content).toContain('external_insert:\n  material: STONE')
    expect(result.content).toContain('target_item:\n  material: IRON_INGOT')
    expect(result.content).toContain('other_item:\n  material: DIRT')
    expect(result.startLineNumber).toBe(4)
  })

  it('rejects saving text without a top-level yaml item key', () => {
    expect(() => replaceItemYamlBlockInFile('target_item:\n  material: COAL\n', {
      itemKey: 'target_item',
      lineNumber: 1,
      nextBlock: '  material: IRON_INGOT',
    })).toThrow('顶层物品 key')
  })

  it('rejects stale results when the target item no longer exists', () => {
    expect(() => replaceItemYamlBlockInFile('other_item:\n  material: DIRT\n', {
      itemKey: 'target_item',
      lineNumber: 1,
      nextBlock: 'target_item:\n  material: COAL',
    })).toThrow('未找到物品块')
  })
})
