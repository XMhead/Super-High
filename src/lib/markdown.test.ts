import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders yaml fenced code blocks as plain code', () => {
    const output = renderMarkdown("```yaml\nserver:\n  port: 8080\n```")

    expect(output).toContain('language-yaml')
    expect(output).not.toContain('sh-code-token')
  })
})
