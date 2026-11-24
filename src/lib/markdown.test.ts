import { describe, expect, it } from 'vitest'

import { renderMarkdown, scanMarkdownHeadings } from './markdown'

describe('renderMarkdown', () => {
  it('renders inline and display TeX as MathML', () => {
    const output = renderMarkdown(String.raw`Inline $x^2$ and \(y_0\).

$$
\frac{1}{2}
$$

\[\sqrt{2}\]`)

    expect(output).toContain('<msup>')
    expect(output).toContain('<msub>')
    expect(output).toContain('<mfrac>')
    expect(output).toContain('<msqrt>')
    expect(output.match(/class="sh-math-display"/g)).toHaveLength(2)
  })

  it('preserves currency and code and leaves invalid or untrusted TeX readable', () => {
    const output = renderMarkdown([
      'It costs $10 or $20. Code: `$x$`',
      String.raw`Invalid: $\unknown{<img>}$ and $\href{https://example.com}{x}$`,
    ].join('\n'))

    expect(output).toContain('$10 or $20')
    expect(output).toContain('<code>$x$</code>')
    expect(output).toContain('&lt;img&gt;')
    expect(output).not.toContain('<math')
    expect(output).not.toContain('href="https://example.com"')
  })

  it('renders inline ANSI across Markdown tokens without leaking style to the next document', () => {
    const output = renderMarkdown('\x1b[31m**红色**和 `代码`\x1b[0m &lt;script&gt;')
    expect(output).toContain('<strong><span style="color:var(--terminal-ansi-red)">红色</span></strong>')
    expect(output).toContain('<code><span style="color:var(--terminal-ansi-red)">代码</span></code>')
    expect(output).not.toContain('\x1b')
    expect(output).not.toContain('<script>')
    expect(renderMarkdown('普通文字')).not.toContain('terminal-ansi')
  })
  it('syntax-highlights yaml fenced code blocks with semantic token classes', () => {
    const output = renderMarkdown("```yaml\nmonster:\n  Health: 100\n  Silent: true # 不产生原版声音\n  Name: '虚空神域'\n```")

    expect(output).toContain('language-yaml sh-code-highlight sh-code-highlight-yaml')
    expect(output).toContain('sh-code-token-key')
    expect(output).toContain('sh-code-token-number')
    expect(output).toContain('sh-code-token-literal')
    expect(output).toContain('sh-code-token-comment')
    expect(output).toContain('sh-code-token-string')
  })

  it('renders ANSI fenced code with theme colors and decodes common escape notation', () => {
    const output = renderMarkdown('```ansi\n\\x1b[31mred\\x1b[0m plain\n```')

    expect(output).toContain('sh-ansi-preview')
    expect(output).toContain('color:var(--terminal-ansi-red)')
    expect(output).toContain('red')
    expect(output).not.toContain('\\x1b')
  })

  it('auto-renders actual ANSI SGR sequences in ordinary fenced code', () => {
    const output = renderMarkdown('```text\n\x1b[38;2;1;2;3mRGB\x1b[0m\n```')

    expect(output).toContain('sh-code-highlight-ansi')
    expect(output).toContain('color:rgb(1, 2, 3)')
    expect(output).toContain('RGB')
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
    expect(output).toMatch(/<h1 id="md-heading-0" data-md-heading-id="md-heading-0" class="md-codex-heading" style="[^"]*--memo-title-\d+[^"]*">Project title<\/h1>/)
    expect(output).toMatch(/<h2 id="md-heading-1" data-md-heading-id="md-heading-1" class="md-codex-heading" style="[^"]*">Installation<\/h2>/)
    expect(output).toMatch(/<h1 id="md-heading-2" data-md-heading-id="md-heading-2" class="md-codex-heading" style="[^"]*">Usage<\/h1>/)
    expect(renderMarkdown('Setext title\n============')).toMatch(/<h1 id="md-heading-0" data-md-heading-id="md-heading-0" class="md-codex-heading" style="[^"]*">Setext title<\/h1>/)
  })

  it('assigns the same RGBA title color to headings with identical text', () => {
    const colorOf = (html: string, title: string) => {
      const match = new RegExp(`<h\\d[^>]*>${title}</h\\d>`).exec(html)
      return match?.[0].match(/--memo-title-(\d+)/)?.[1]
    }
    const colors = colorOf(renderMarkdown('# Alpha\n\n## Alpha\n\n### Beta'), 'Alpha')
    expect(colors).toBeTruthy()
    expect(colorOf(renderMarkdown('## Alpha'), 'Alpha')).toBe(colors)
    expect(colorOf(renderMarkdown('# Beta'), 'Beta')).not.toBeUndefined()
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
