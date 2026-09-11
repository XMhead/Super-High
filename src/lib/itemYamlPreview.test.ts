import { describe, expect, it } from 'vitest'

import { buildItemYamlPreviewLines } from './itemYamlPreview'

describe('buildItemYamlPreviewLines', () => {
  it('marks yaml keys separators list markers strings comments and plain values', () => {
    const lines = buildItemYamlPreviewLines("goblin_helmet:\n  material: COAL\n  name: '§#1fcc7f哥布林头盔'\n  lore:\n  - 类型=§f头部\n  # note")

    expect(lines[0].segments.map((segment) => segment.kind)).toEqual(['key', 'separator'])
    expect(lines[1].segments.map((segment) => segment.kind)).toEqual(['indent', 'key', 'separator', 'value'])
    expect(lines[2].segments.map((segment) => segment.kind)).toEqual(['indent', 'key', 'separator', 'string', 'string'])
    expect(lines[2].segments.filter((segment) => segment.color).map((segment) => segment.color)).toEqual(['#1FCC7F'])
    expect(lines[4].segments.map((segment) => segment.kind)).toEqual(['indent', 'listMarker', 'value', 'value'])
    expect(lines[4].segments.filter((segment) => segment.color).map((segment) => segment.color)).toEqual(['#FFFFFF'])
    expect(lines[5].segments.map((segment) => segment.kind)).toEqual(['indent', 'comment'])
  })

  it('preserves yaml token kinds while splitting Minecraft and rgba color spans', () => {
    const lines = buildItemYamlPreviewLines("item:\n  name: '&a绿色 §c红色 rgba(255,0,128,0.5)'")
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

  it('replaces color-enabled DragonCore font characters only when they use the image prefix', () => {
    const lines = buildItemYamlPreviewLines("item:\n  name: '菲尔圣咏 §汐 &尔 靐'", [{
      character: '汐',
      dataUrl: 'data:image/png;base64,AA==',
      path: 'title/潮汐.gif',
      imagePath: 'D:/Client/DragonCore/title/潮汐.gif',
      configPath: 'D:/Project/DragonCore/FontConfig.yml',
      relativeConfigPath: 'FontConfig.yml',
      lineNumber: 1,
      width: 38,
      height: 9,
      yOffset: 0,
      color: true,
      fontWidth: 2,
    }, {
      character: '尔',
      dataUrl: 'data:image/png;base64,BB==',
      path: 'title/VIP称号/VIP2.gif',
      imagePath: 'D:/Client/DragonCore/title/VIP称号/VIP2.gif',
      configPath: 'D:/Project/DragonCore/FontConfig/VIP.yml',
      relativeConfigPath: 'VIP.yml',
      lineNumber: 6,
      width: 26,
      height: 9,
      yOffset: 0,
      color: true,
      fontWidth: null,
    }, {
      character: '靐',
      dataUrl: 'data:image/png;base64,CC==',
      path: 'sx/生命.png',
      imagePath: 'D:/Client/DragonCore/sx/生命.png',
      configPath: 'D:/Project/DragonCore/FontConfig/属性图标.yml',
      relativeConfigPath: '属性图标.yml',
      lineNumber: 1,
      width: 14,
      height: 14,
      yOffset: -3,
      color: false,
      fontWidth: null,
    }], true)

    const images = lines[1].segments.filter((segment) => segment.fontImage)
    expect(images.map((segment) => segment.text)).toEqual(['汐', '尔', '靐'])
    expect(images.map((segment) => segment.fontImage?.dataUrl)).toEqual([
      'data:image/png;base64,AA==',
      'data:image/png;base64,BB==',
      'data:image/png;base64,CC==',
    ])
    expect(lines[1].segments.map((segment) => segment.text).join('')).toContain("name: '菲尔圣咏 汐 尔 靐'")
  })

  it('keeps color-enabled DragonCore font characters as text without the image prefix', () => {
    const lines = buildItemYamlPreviewLines("item:\n  name: '菲尔圣咏 示例项目'", [{
      character: '汐',
      dataUrl: 'data:image/png;base64,AA==',
      path: 'title/潮汐.gif',
      imagePath: 'D:/Client/DragonCore/title/潮汐.gif',
      configPath: 'D:/Project/DragonCore/FontConfig.yml',
      relativeConfigPath: 'FontConfig.yml',
      lineNumber: 1,
      width: 38,
      height: 9,
      yOffset: 0,
      color: true,
      fontWidth: 2,
    }, {
      character: '尔',
      dataUrl: 'data:image/png;base64,BB==',
      path: 'title/VIP称号/VIP2.gif',
      imagePath: 'D:/Client/DragonCore/title/VIP称号/VIP2.gif',
      configPath: 'D:/Project/DragonCore/FontConfig/VIP.yml',
      relativeConfigPath: 'VIP.yml',
      lineNumber: 6,
      width: 26,
      height: 9,
      yOffset: 0,
      color: true,
      fontWidth: null,
    }], true)

    expect(lines.flatMap((line) => line.segments).some((segment) => segment.fontImage)).toBe(false)
    expect(lines[1].segments.map((segment) => segment.text).join('')).toContain('菲尔圣咏 示例项目')
  })
})
