import { describe, expect, it } from 'vitest'
import { highlightCode } from './codeHighlight'

describe('code highlighting', () => {
  it.each([
    ['yaml', 'enabled: true\ncount: 42\nname: "hello"\n# comment'],
    ['typescript', 'const count: number = 42'],
    ['python', 'def hello():\n    return "world"'],
    ['json', '{"count": 42}'],
    ['shell', 'echo "$HOME"'],
    ['html', '<div title="hello">world</div>'],
  ])('highlights %s while preserving exact source text', async (language, source) => {
    const result = await highlightCode(source, language)
    expect(result).toContain('class="hljs-')
    const element = document.createElement('code')
    element.innerHTML = result
    expect(element.textContent).toBe(source)
  })
  it('escapes markup in code and unknown file types', async () => {
    for (const language of ['yaml', 'plaintext']) {
      const element = document.createElement('code')
      const source = 'value: <img src=x onerror=alert(1)>'
      element.innerHTML = await highlightCode(source, language)
      expect(element.querySelector('img')).toBeNull()
      expect(element.textContent).toBe(source)
    }
  })
})
