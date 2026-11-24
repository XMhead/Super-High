import { describe, expect, it } from 'vitest'
import { editorUiSource } from './editorUiSource'
import { compileSuperhighUi } from './superhighUi'

describe('editor IUI parameters', () => {
  it('compiles nested components, bindings and escaped content through the existing parser', () => {
    const source = editorUiSource({ component: 'Stack', children: [
      { component: 'Choice', name: 'kind', options: ['A', 'B'], value: 'A' },
      { component: 'Text', content: { component: 'Bind', field: 'kind' } },
      { component: 'Markdown', content: '# title\n"quoted" <script>literal</script>' },
    ] })
    const doc = compileSuperhighUi(source)
    expect(doc.diagnostics).toEqual([])
    expect(doc.root?.type).toBe('Stack')
    expect(doc.root?.children.children.items).toHaveLength(3)
  })
})
