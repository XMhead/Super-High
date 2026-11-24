import { expect, it, vi } from 'vitest'
import { linkWorkspacePaths, MAX_WORKSPACE_PATH_LINK_SOURCE_LENGTH, renderWorkspaceMarkdown } from './workspacePathLinks'
import { targetFromAnchor } from './linkTargets'

it('links existing workspace paths in prose, inline code and fences while preserving explicit links', async () => {
  const resolver = vi.fn(async (path: string) => path.includes('missing') ? null : { path, isFile: !path.endsWith('\\') })
  const markdown = [
    '目录：plugins\\.agent\\tmp\\preview\\v1\\，图片 `plugins\\.agent\\tmp\\preview\\v1\\图片.png`。',
    '`folder with spaces/image.png`',
    '[已有](plugins/file.yml)',
    '`plugins/missing.yml`',
    '```txt', 'plugins/fenced.yml', '```',
  ].join('\n\n')
  const html = await linkWorkspacePaths(renderWorkspaceMarkdown(markdown, 'D:/server/plugins'), 'D:/server/plugins', resolver)
  const container = document.createElement('div')
  container.innerHTML = html
  const links = [...container.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))
  expect(links).toEqual([
    'D:\\server\\plugins\\.agent\\tmp\\preview\\v1\\',
    'D:\\server\\plugins\\.agent\\tmp\\preview\\v1\\图片.png',
    'D:\\server\\plugins\\folder with spaces\\image.png',
    'plugins/file.yml',
    'D:\\server\\plugins\\fenced.yml',
  ])
  expect(container.querySelector('pre a')?.textContent).toBe('plugins/fenced.yml')
  expect(container.querySelector('a a')).toBeNull()
})

it('preserves formatting after absolute Windows paths', () => {
  const html = renderWorkspaceMarkdown('查看 D:\\demo\\.agent\\a.png，随后 **完成** [网页](https://example.com)', 'D:/demo')
  expect(html).toContain('D:\\demo\\.agent\\a.png')
  expect(html).toContain('<strong>完成</strong>')
  expect(html).toContain('<a href="https://example.com">网页</a>')
})

it('uses shared file icons only for existing local files and preserves line targets', async () => {
  const resolver = vi.fn(async (path: string) => path.includes('missing') ? null : { path, isFile: true })
  const html = await linkWorkspacePaths(renderWorkspaceMarkdown('`src/app.ts:24` [文档](README.md#L8) [网页](https://example.com) `missing.ts`', 'D:/demo'), 'D:/demo', resolver, { fileIcons: true })
  const root = document.createElement('div')
  root.innerHTML = html
  expect(root.querySelector('code a')?.getAttribute('data-line-number')).toBe('24')
  expect(root.querySelector('code a .tree-kind-icon.code')).not.toBeNull()
  expect(root.querySelector('a[href="README.md#L8"] .tree-kind-icon.document')).not.toBeNull()
  expect(root.querySelector('a[href="https://example.com"] svg')).toBeNull()
  expect(root.querySelectorAll('.workspace-file-link')).toHaveLength(2)
})

it('links corpus file locations and URLs inside logs without nesting anchors or altering code text', async () => {
  const source = [
    '```log',
    'src/app.ts:12:3',
    'file:///D:/demo/app.kt:133:70',
    '+++ b/src/main.ts',
    'www.totaltypescript.com/docs#solution-3',
    'https://example.com/wiki/Foo_(bar)）',
    '```',
    '[章节](README.md#大图集加载与上传)',
    '`src/app.ts#L12C3-L20C8`',
    '`missing.ts`',
  ].join('\n')
  const resolve = vi.fn(async (path: string) => path.includes('missing') ? null : { path, isFile: true })
  const root = document.createElement('div')
  root.innerHTML = await linkWorkspacePaths(renderWorkspaceMarkdown(source, 'D:/demo'), 'D:/demo', resolve)
  const anchors = [...root.querySelectorAll('pre a')]
  expect(anchors).toHaveLength(5)
  expect(targetFromAnchor(anchors[0]!, 'D:/demo')).toMatchObject({ path: 'D:/demo/src/app.ts', lineNumber: 12, column: 3 })
  expect(targetFromAnchor(anchors[1]!, 'D:/demo')).toMatchObject({ path: 'D:/demo/app.kt', lineNumber: 133, column: 70 })
  expect(anchors[2]?.getAttribute('href')).toBe('D:\\demo\\src\\main.ts')
  expect(anchors[3]?.getAttribute('href')).toBe('https://www.totaltypescript.com/docs#solution-3')
  expect(anchors[4]?.getAttribute('href')).toBe('https://example.com/wiki/Foo_(bar)')
  expect(root.querySelector('pre')?.textContent).toBe(source.split('```log\n')[1]!.split('```')[0])
  expect(targetFromAnchor(root.querySelector('a[href^="README"]')!, 'D:/demo')).toMatchObject({ path: 'D:/demo/README.md', anchor: '大图集加载与上传' })
  expect(targetFromAnchor(root.querySelector('p code a')!, 'D:/demo')).toMatchObject({ lineNumber: 12, column: 3, endLineNumber: 20, endColumn: 8 })
  expect(root.querySelector('a a')).toBeNull()
  expect(root.querySelector('a[href*="missing"]')).toBeNull()
})

it('skips filesystem path linking for large Markdown transcripts', async () => {
  const resolver = vi.fn(async (path: string) => ({ path, isFile: true }))
  const line = 'D:\\workspace\\plugins\\example\\file.md\n'
  const source = line.repeat(Math.ceil((MAX_WORKSPACE_PATH_LINK_SOURCE_LENGTH + 1) / line.length))
  const html = renderWorkspaceMarkdown(source, 'D:/workspace/plugins')
  const linked = await linkWorkspacePaths(html, 'D:/workspace/plugins', resolver)
  expect(source.length).toBeGreaterThan(MAX_WORKSPACE_PATH_LINK_SOURCE_LENGTH)
  expect(resolver).not.toHaveBeenCalled()
  expect(linked).toContain('workspace')
})
