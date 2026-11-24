import { describe, expect, it } from 'vitest'

import {
  formatCodePreviewSelectionSource,
  formatCodePreviewSelectionSourceForRange,
} from './selectionChat'

describe('selection chat formatting', () => {
  it('uses the absolute file path and selected line range for code preview snippets', () => {
    expect(formatCodePreviewSelectionSource('D:\\Project\\config\\skill.yml', 10, 1)).toBe(
      '查看选取内容 D:\\Project\\config\\skill.yml 第 1 行到第 10 行',
    )
  })

  it('uses a single-line label when the selection is on one line', () => {
    expect(formatCodePreviewSelectionSource('D:\\Project\\config\\skill.yml', 7, 7)).toBe(
      '查看选取内容 D:\\Project\\config\\skill.yml 第 7 行',
    )
  })

  it('shows the previous line when a multi-line Monaco selection ends at column one', () => {
    expect(formatCodePreviewSelectionSourceForRange('D:\\Project\\config\\skill.yml', {
      startLineNumber: 1,
      endLineNumber: 11,
      endColumn: 1,
    })).toBe('查看选取内容 D:\\Project\\config\\skill.yml 第 1 行到第 10 行')
  })
})
