import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown'

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
})
