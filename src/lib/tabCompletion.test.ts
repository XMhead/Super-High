import { describe, expect, it } from 'vitest'

import { buildTabCompletionSuggestion } from './tabCompletion'

describe('buildTabCompletionSuggestion', () => {
  it('completes the rest of a matching line from the current file', () => {
    const text = [
      'const activeTab = computed(() => store.activeTab)',
      'const active',
    ].join('\n')

    expect(buildTabCompletionSuggestion(text, { lineNumber: 2, column: 'const active'.length + 1 })).toEqual({
      insertText: 'Tab = computed(() => store.activeTab)',
    })
  })

  it('keeps the current indentation when copying a line shape', () => {
    const text = [
      '  const previewWidth = 520',
      '    const preview',
    ].join('\n')

    expect(buildTabCompletionSuggestion(text, { lineNumber: 2, column: '    const preview'.length + 1 })).toEqual({
      insertText: 'Width = 520',
    })
  })

  it('brings a small block with the matching line', () => {
    const text = [
      'function mountEditor() {',
      '  syncEditor()',
      '}',
      'function mount',
    ].join('\n')

    expect(buildTabCompletionSuggestion(text, { lineNumber: 4, column: 'function mount'.length + 1 })).toEqual({
      insertText: 'Editor() {\n  syncEditor()\n}',
    })
  })

  it('continues a repeated block without duplicating the following closing brace', () => {
    const text = [
      'if (enabled) {',
      '  syncEditor()',
      '}',
      'if (enabled) {',
      '  ',
      '}',
    ].join('\n')

    expect(buildTabCompletionSuggestion(text, { lineNumber: 5, column: 3 })).toEqual({
      insertText: 'syncEditor()',
    })
  })
})
