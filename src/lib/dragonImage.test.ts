import { describe, expect, it } from 'vitest'

import {
  buildDragonPixelBuffer,
  DragonImageParseError,
  extractDragonPixelSource,
  parseDragonImageConfig,
} from './dragonImage'

describe('dragon image config', () => {
  it('parses size, palette colors, and 1-based pixels', () => {
    const document = parseDragonImageConfig(`
width: 2
height: 1

colors:
[1]=&a
[2]=#ffcc0080

pixels:
x:1,y:1[1]
x:2,Y:1[2]
`)

    expect(document.width).toBe(2)
    expect(document.height).toBe(1)
    expect(document.colors[1]).toEqual({ r: 85, g: 255, b: 85, a: 255 })
    expect(document.colors[2]).toEqual({ r: 255, g: 204, b: 0, a: 128 })

    const buffer = buildDragonPixelBuffer(document)
    expect(Array.from(buffer)).toEqual([
      85, 255, 85, 255,
      255, 204, 0, 128,
    ])
  })

  it('keeps unspecified pixels transparent and lets later pixels overwrite earlier ones', () => {
    const document = parseDragonImageConfig(`
width: 2
height: 2
[1]=rgba(255,0,0,1)
[2]=rgba(0,0,255,0.5)
x:1,y:1[1]
x:1,y:1[2]
`)

    const buffer = buildDragonPixelBuffer(document)
    expect(Array.from(buffer.slice(0, 8))).toEqual([
      0, 0, 255, 128,
      0, 0, 0, 0,
    ])
  })

  it('expands inclusive x and y coordinate ranges', () => {
    const document = parseDragonImageConfig(`
width: 4
height: 3
[1]=rgba(255,0,0,1)
[2]=rgba(0,0,255,1)
[3]=rgba(0,255,0,1)
x:1~3,y:2[1]
x:4,y:1~3[2]
x:2~3,y:2~3[3]
`)

    expect(document.pixels).toHaveLength(10)

    const buffer = buildDragonPixelBuffer(document)
    expect(Array.from(buffer)).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 255, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      0, 0, 0, 0,
      0, 255, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ])
  })

  it('reports range issues once per source line', () => {
    expect(() => parseDragonImageConfig(`
width: 2
height: 2
[1]=&a
x:1~4,y:1[1]
x:1~2,y:2[2]
`)).toThrow(DragonImageParseError)

    try {
      parseDragonImageConfig(`
width: 2
height: 2
[1]=&a
x:1~4,y:1[1]
x:1~2,y:2[2]
`)
    } catch (error) {
      expect(error).toBeInstanceOf(DragonImageParseError)
      expect((error as DragonImageParseError).issues).toEqual([
        { lineNumber: 5, message: '第 5 行像素坐标超出 2 x 2' },
        { lineNumber: 6, message: '第 6 行引用了未定义颜色 [2]' },
      ])
    }
  })

  it('reports line numbers for invalid pixels', () => {
    expect(() => parseDragonImageConfig(`
width: 1
height: 1
[1]=&a
x:2,y:1[1]
x:1,y:1[2]
`)).toThrow(DragonImageParseError)

    try {
      parseDragonImageConfig(`
width: 1
height: 1
[1]=&a
x:2,y:1[1]
x:1,y:1[2]
`)
    } catch (error) {
      expect(error).toBeInstanceOf(DragonImageParseError)
      expect((error as DragonImageParseError).issues).toEqual([
        { lineNumber: 5, message: '第 5 行像素坐标超出 1 x 1' },
        { lineNumber: 6, message: '第 6 行引用了未定义颜色 [2]' },
      ])
    }
  })

  it('parses a single dragon-pixel fenced block from markdown', () => {
    const document = parseDragonImageConfig(`
\`\`\`dragon-pixel
width: 1
height: 1
[1]=#ff00ffff
x:1,y:1[1]
\`\`\`
`)

    expect(document.width).toBe(1)
    expect(document.height).toBe(1)
    expect(Array.from(buildDragonPixelBuffer(document))).toEqual([255, 0, 255, 255])
  })

  it('rejects markdown with multiple dragon-pixel fenced blocks', () => {
    expect(() => extractDragonPixelSource(`
\`\`\`dragon-pixel
width: 1
\`\`\`
\`\`\`dragon-pixel
height: 1
\`\`\`
`)).toThrow(DragonImageParseError)
  })
})
