import { describe, expect, it, vi } from 'vitest'

import {
  buildHtmlPreviewResourceBridge,
  HTML_PREVIEW_RESOURCE_MESSAGE,
  resolveHtmlPreviewResourcePath,
  saveHtmlPreviewDownload,
} from './htmlPreviewResources'

describe('html preview resources', () => {
  it('resolves relative images under the opened html file directory', () => {
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', 'images/光1.png')).toBe('D:/Project/output/images/光1.png')
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', './images/光1.png?version=1')).toBe('D:/Project/output/images/光1.png')
  })

  it('rejects absolute paths and traversal outside the html directory', () => {
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', '../secret.png')).toBeNull()
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', 'D:/secret.png')).toBeNull()
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', 'https://example.com/image.png')).toBeNull()
  })

  it('emits a bridge that requests dynamically inserted images', () => {
    const script = buildHtmlPreviewResourceBridge('D:/Project/output/gallery.html')
    expect(script).toContain(`const RESOURCE = '${HTML_PREVIEW_RESOURCE_MESSAGE}'`)
    expect(script).toContain('MutationObserver')
    expect(script).toContain('baseDirectory')
  })

  it('saves a generated download at the path chosen by the user, and preserves cancellation', async () => {
    const files = {
      pickSaveFilePath: vi.fn().mockResolvedValueOnce('D:/Saved/选择.json').mockResolvedValueOnce(null),
      saveDownloadDataUrl: vi.fn().mockResolvedValue('D:/Saved/选择.json'),
    }
    const data = { fileName: '五元素选择.json', dataUrl: 'data:application/json;base64,e30=' }
    await expect(saveHtmlPreviewDownload('D:/Project/gallery.html', data, files)).resolves.toBe('D:/Saved/选择.json')
    expect(files.pickSaveFilePath).toHaveBeenCalledWith('D:/Project/五元素选择.json')
    expect(files.saveDownloadDataUrl).toHaveBeenCalledWith('D:/Saved/选择.json', data.dataUrl)
    await expect(saveHtmlPreviewDownload('D:/Project/gallery.html', data, files)).resolves.toBeNull()
    expect(files.saveDownloadDataUrl).toHaveBeenCalledTimes(1)
  })
})
