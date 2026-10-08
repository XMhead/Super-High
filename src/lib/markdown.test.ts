import { describe, expect, it } from 'vitest'

import { renderMarkdown, scanMarkdownHeadings } from './markdown'

describe('renderMarkdown', () => {
  it('syntax-highlights yaml fenced code blocks with semantic token classes', () => {
    const output = renderMarkdown("```yaml\nmonster:\n  Health: 100\n  Silent: true # 不产生原版声音\n  Name: '虚空神域'\n```")

    expect(output).toContain('language-yaml sh-code-highlight sh-code-highlight-yaml')
    expect(output).toContain('sh-code-token-key')
    expect(output).toContain('sh-code-token-number')
    expect(output).toContain('sh-code-token-literal')
    expect(output).toContain('sh-code-token-comment')
    expect(output).toContain('sh-code-token-string')
  })

  it('infers the content root below a document title and keeps heading levels', () => {
    const headings = scanMarkdownHeadings([
      '# Project title',
      '',
      '## Installation ##',
      '',
      '```md',
      '# Example only',
      '```',
      '',
      '### Usage',
    ].join('\n'))

    expect(headings.map((heading) => ({ title: heading.keyName, line: heading.lineNumber, level: heading.level, depth: heading.navigationDepth }))).toEqual([
      { title: 'Installation', line: 3, level: 2, depth: 0 },
      { title: 'Usage', line: 9, level: 3, depth: 1 },
    ])
  })

  it('uses the same stable heading anchors for ATX and setext headings', () => {
    const output = renderMarkdown('# Project title\n\n## Installation\n\n# Usage')
    expect(output).toContain('<h1 id="md-heading-0" data-md-heading-id="md-heading-0">Project title</h1>')
    expect(output).toContain('<h2 id="md-heading-1" data-md-heading-id="md-heading-1">Installation</h2>')
    expect(output).toContain('<h1 id="md-heading-2" data-md-heading-id="md-heading-2">Usage</h1>')
    expect(renderMarkdown('Setext title\n============')).toContain('<h1 id="md-heading-0" data-md-heading-id="md-heading-0">Setext title</h1>')
  })

  it('builds a changelog-like tree from version headings and their sections', () => {
    const headings = scanMarkdownHeadings([
      '# 更新日志',
      '',
      '## [0.1.36]',
      '### 新增功能',
      '### 问题修复',
      '## [0.1.35]',
      '### 新增功能',
      '#### 细节',
    ].join('\n'))

    expect(headings.map((heading) => ({ title: heading.keyName, level: heading.level, depth: heading.navigationDepth }))).toEqual([
      { title: '[0.1.36]', level: 2, depth: 0 },
      { title: '新增功能', level: 3, depth: 1 },
      { title: '问题修复', level: 3, depth: 1 },
      { title: '[0.1.35]', level: 2, depth: 0 },
      { title: '新增功能', level: 3, depth: 1 },
      { title: '细节', level: 4, depth: 2 },
    ])
  })
})
