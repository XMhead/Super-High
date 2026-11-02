import { describe, expect, it } from 'vitest'
import { formatWorkDuration, noticeLinkTarget, parseCompletionNotice } from './cliCompletion'

describe('noticeLinkTarget', () => {
  it('resolves CLI file links to local paths with optional line numbers', () => {
    expect(noticeLinkTarget('/D:/Super%20High/%E8%B7%9F%E8%B8%AA.txt', 'D:/Super High')).toEqual({ kind: 'file', path: 'D:/Super High/跟踪.txt', lineNumber: undefined })
    expect(noticeLinkTarget('file:///D:/a/b.ts#L12', '')).toEqual({ kind: 'file', path: 'D:/a/b.ts', lineNumber: 12 })
    expect(noticeLinkTarget('D:\\a\\b.ts:7:3', '')).toEqual({ kind: 'file', path: 'D:/a/b.ts', lineNumber: 7 })
    expect(noticeLinkTarget('src/main.ts:4', 'D:\\Demo\\')).toEqual({ kind: 'file', path: 'D:/Demo/src/main.ts', lineNumber: 4 })
  })
  it('keeps web links external and ignores anchors and other schemes', () => {
    expect(noticeLinkTarget('https://example.com/a', '')).toEqual({ kind: 'url', url: 'https://example.com/a' })
    expect(noticeLinkTarget('#top', 'D:/Demo')).toBeNull()
    expect(noticeLinkTarget('mailto:a@b.c', 'D:/Demo')).toBeNull()
    expect(noticeLinkTarget('relative.txt', '')).toBeNull()
  })
})

describe('formatWorkDuration', () => {
  it('matches the native CLI footer format', () => {
    expect(formatWorkDuration(72328)).toBe('1m 12s')
    expect(formatWorkDuration(400)).toBe('1s')
    expect(formatWorkDuration(3_725_000)).toBe('1h 2m 5s')
    expect(formatWorkDuration(null)).toBe('')
    expect(parseCompletionNotice(JSON.stringify({ title: 't', durationMs: 5000 })).durationMs).toBe(5000)
  })
})
