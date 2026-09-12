import { describe, expect, it } from 'vitest'

import {
  buildCliMessageWithImages,
  clipboardEventHasImages,
  extractPastedImagesFromClipboardEvent,
  fileNameFromPath,
} from './cliImagePaste'

describe('cliImagePaste', () => {
  it('builds image-only message with a path instruction', () => {
    expect(buildCliMessageWithImages('', ['D:/project/.superhigh/pasted-images/a.png'])).toBe(
      '图片路径：D:/project/.superhigh/pasted-images/a.png\n请读取并查看上述本地图片文件后再回答；若无法访问该路径，请明确说明。',
    )
  })

  it('prefixes user text with numbered image paths', () => {
    expect(
      buildCliMessageWithImages('帮我看下', [
        'D:/a.png',
        'D:/b.jpg',
      ]),
    ).toBe('图片1路径：D:/a.png\n图片2路径：D:/b.jpg\n请读取并查看上述本地图片文件后再回答；若无法访问该路径，请明确说明。\n帮我看下')
  })

  it('deduplicates blank and repeated paths', () => {
    expect(buildCliMessageWithImages('x', [' D:/a.png ', '', 'D:/a.png'])).toBe(
      '图片路径：D:/a.png\n请读取并查看上述本地图片文件后再回答；若无法访问该路径，请明确说明。\nx',
    )
  })

  it('extracts file names from windows paths', () => {
    expect(fileNameFromPath('D:\\project\\.superhigh\\pasted-images\\shot.png')).toBe('shot.png')
  })

  it('extracts all five PNG files copied from a folder', async () => {
    const files = Array.from({ length: 5 }, (_, index) => new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      `image-${index + 1}.png`,
      { type: 'image/png' },
    ))
    const event = {
      clipboardData: {
        files,
        items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
      },
    } as unknown as ClipboardEvent

    expect(clipboardEventHasImages(event)).toBe(true)
    const candidates = await extractPastedImagesFromClipboardEvent(event)

    expect(candidates).toHaveLength(5)
    expect(candidates.map((candidate) => candidate.preferredName)).toEqual([
      'image-1.png',
      'image-2.png',
      'image-3.png',
      'image-4.png',
      'image-5.png',
    ])
    expect(candidates.every((candidate) => candidate.dataUrl.startsWith('data:image/png;base64,'))).toBe(true)
  })
})
