import { describe, expect, it, vi } from 'vitest'

import {
  buildHtmlPreviewResourceBridge,
  inlineHtmlPreviewAssets,
  HTML_PREVIEW_RESOURCE_MESSAGE,
  resolveHtmlPreviewResourcePath,
  saveHtmlPreviewDownload,
} from './htmlPreviewResources'

describe('html preview resources', () => {
  it('inlines local scripts and styles with stylesheet-relative images before parsing', async () => {
    const files = {
      readFile: vi.fn(async (path: string) => path.endsWith('.js') ? 'window.loaded="中文"' : 'body{background:url(../images/光.png)}'),
      readMediaAsDataUrl: vi.fn(async () => 'data:image/png;base64,AA=='),
    }
    const source = '<link rel="stylesheet" media="screen" href="css/main.css"><script src="js/app.js"></script><script>window.ready=window.loaded</script>'
    const html = await inlineHtmlPreviewAssets(source, 'D:/Project/review.html', files)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('link')).toBeNull()
    expect(doc.querySelector('style')?.getAttribute('media')).toBe('screen')
    expect(doc.querySelector('style')?.textContent).toContain('data:image/png;base64,AA==')
    expect([...doc.querySelectorAll('script')].map(s => s.textContent)).toEqual(['window.loaded="中文"', 'window.ready=window.loaded'])
    expect(files.readMediaAsDataUrl).toHaveBeenCalledWith('D:/Project/images/光.png')
  })
  it('resolves relative images under the opened html file directory', () => {
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', 'images/光1.png')).toBe('D:/Project/output/images/光1.png')
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', './images/光1.png?version=1')).toBe('D:/Project/output/images/光1.png')
  })

  it('rejects absolute paths and traversal outside the html directory', () => {
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', '../secret.png')).toBeNull()
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', 'D:/secret.png')).toBeNull()
    expect(resolveHtmlPreviewResourcePath('D:/Project/output/gallery.html', 'https://example.com/image.png')).toBeNull()
  })

  it('loads sibling and file URL assets inside the workspace and rejects outside paths', () => {
    const page = 'D:/Project/review/review.html'
    expect(resolveHtmlPreviewResourcePath(page, '../icon/中文.png', 'D:/Project')).toBe('D:/Project/icon/中文.png')
    expect(resolveHtmlPreviewResourcePath(page, 'file:///D:/Project/icon/%E4%B8%AD%E6%96%87.png', 'D:/Project')).toBe('D:/Project/icon/中文.png')
    expect(resolveHtmlPreviewResourcePath(page, '%2e%2e/%2e%2e/secret.png', 'D:/Project')).toBeNull()
    expect(resolveHtmlPreviewResourcePath(page, 'file:///D:/Other/icon.png', 'D:/Project')).toBeNull()
    expect(resolveHtmlPreviewResourcePath(page, 'file://server/Project/icon.png', 'D:/Project')).toBeNull()
    expect(resolveHtmlPreviewResourcePath('C:/App/editor/page.html', './icon.png', 'D:/Project')).toBe('C:/App/editor/icon.png')
  })

  it('allows local media outside the workspace without relaxing text paths', () => {
    const page = 'D:/Project/review/review.html'
    expect(resolveHtmlPreviewResourcePath(page, 'file:///D:/Other/%E4%B8%AD%E6%96%87.png', 'D:/Project', true)).toBe('D:/Other/中文.png')
    expect(resolveHtmlPreviewResourcePath(page, 'D:/Other/image.png', 'D:/Project', true)).toBe('D:/Other/image.png')
    expect(resolveHtmlPreviewResourcePath(page, '../../Other/image.png', 'D:/Project', true)).toBe('D:/Other/image.png')
    expect(resolveHtmlPreviewResourcePath(page, 'file://server/share/image.png', 'D:/Project', true)).toBeNull()
    expect(resolveHtmlPreviewResourcePath(page, 'https://example.com/image.png', 'D:/Project', true)).toBeNull()
    expect(resolveHtmlPreviewResourcePath(page, 'file:///D:/Other/image.png', 'D:/Project')).toBeNull()
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
