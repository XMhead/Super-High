import { describe, expect, it } from 'vitest'
import { findMarkdownHeading } from './markdown'
import { parseLinkTarget, targetFromAnchor, trimLinkPunctuation } from './linkTargets'

describe('shared session link targets', () => {
  it.each([
    ['src/components/EditorPane.test.ts:415:75', { path: 'D:/Example Workspace/src/components/EditorPane.test.ts', lineNumber: 415, column: 75 }],
    ['file:///D:/Example%20Workspace/SampleImageTest.kt:133:70', { path: 'D:/Example Workspace/SampleImageTest.kt', lineNumber: 133, column: 70 }],
    ['.agent/tmp/candidate.ps1#L346-L359', { path: 'D:/Example Workspace/.agent/tmp/candidate.ps1', lineNumber: 346, endLineNumber: 359 }],
    ['src/app.ts#L12C3-L20C8', { path: 'D:/Example Workspace/src/app.ts', lineNumber: 12, column: 3, endLineNumber: 20, endColumn: 8 }],
    ['src/app.ts(12,8)', { path: 'D:/Example Workspace/src/app.ts', lineNumber: 12, column: 8 }],
    ['render-performance.md#大图集加载与上传', { path: 'D:/Example Workspace/render-performance.md', anchor: '大图集加载与上传' }],
    ['<D:/Example Workspace/src/app.ts:12>', { path: 'D:/Example Workspace/src/app.ts', lineNumber: 12 }],
    ['file:///D:/notes/a%23b.md#heading', { path: 'D:/notes/a#b.md', anchor: 'heading' }],
    ['file://server/share/a%20b.kt:8:2', { path: '//server/share/a b.kt', lineNumber: 8, column: 2 }],
    ['file://localhost/D:/notes/a.kt:8', { path: 'D:/notes/a.kt', lineNumber: 8 }],
  ])('preserves the path and location in %s', (href, expected) => {
    expect(parseLinkTarget(href, 'D:/Example Workspace')).toMatchObject({ kind: 'file', ...expected })
  })

  it('keeps web fragments and encoded query strings intact', () => {
    expect(parseLinkTarget('www.totaltypescript.com/docs#solution-3', '')).toEqual({ kind: 'url', url: 'https://www.totaltypescript.com/docs#solution-3' })
    const url = 'https://example.com/search?q=a%2Bb&next=%2Fdocs#L12'
    expect(parseLinkTarget(url, '')).toEqual({ kind: 'url', url })
    expect(parseLinkTarget('mailto:a@b.c', 'D:/demo')).toBeNull()
  })

  it('trims prose punctuation while retaining balanced URL parentheses', () => {
    expect(trimLinkPunctuation('https://github.com/example/repo/pull/1600)）')).toBe('https://github.com/example/repo/pull/1600')
    expect(trimLinkPunctuation('https://example.com/wiki/Foo_(bar)）。')).toBe('https://example.com/wiki/Foo_(bar)')
  })

  it('recovers location metadata from generated anchors', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'D:/demo/a.ts')
    Object.assign(anchor.dataset, { lineNumber: '12', column: '3', endLineNumber: '20', endColumn: '8' })
    expect(targetFromAnchor(anchor, '')).toMatchObject({ path: 'D:/demo/a.ts', lineNumber: 12, column: 3, endLineNumber: 20, endColumn: 8 })
    anchor.setAttribute('href', 'D:/demo/note.md#draft.md')
    anchor.setAttribute('data-workspace-path', 'D:\\demo\\note.md#draft.md')
    expect(targetFromAnchor(anchor, '')).toMatchObject({ path: 'D:/demo/note.md#draft.md' })
    expect(targetFromAnchor(anchor, '')).not.toHaveProperty('anchor')
  })

  it('finds Chinese, formatted, duplicate and encoded Markdown heading fragments', () => {
    const source = '# 大图集加载与上传\n\n## **Build** & `Test`\n\n## Build & Test\n\n```md\n# ignored\n```'
    expect(findMarkdownHeading(source, '%E5%A4%A7%E5%9B%BE%E9%9B%86%E5%8A%A0%E8%BD%BD%E4%B8%8E%E4%B8%8A%E4%BC%A0')?.lineNumber).toBe(1)
    expect(findMarkdownHeading(source, 'build--test')?.lineNumber).toBe(3)
    expect(findMarkdownHeading(source, 'build--test-1')?.lineNumber).toBe(5)
    expect(findMarkdownHeading(source, 'md-heading-1')?.lineNumber).toBe(3)
    expect(findMarkdownHeading(source, 'ignored')).toBeUndefined()
  })
})
