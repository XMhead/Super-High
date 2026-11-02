import { expect, it, vi } from 'vitest'
import { linkWorkspacePaths, renderWorkspaceMarkdown } from './workspacePathLinks'

it('links existing workspace paths in prose and inline code while preserving links and fences', async () => {
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
  ])
  expect(container.querySelector('pre a')).toBeNull()
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
