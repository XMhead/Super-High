import { describe, expect, it } from 'vitest'
import { buildCliMessageWithTextFiles, matchPastedTextFiles, mentionQueryFromDraft, pastedTextStamp, shouldExportPastedText } from './cliTextPaste'

describe('cliTextPaste', () => {
  it('exports only text longer than 500 characters', () => {
    expect(shouldExportPastedText('字'.repeat(500))).toBe(false)
    expect(shouldExportPastedText('字'.repeat(501))).toBe(true)
  })

  it('formats local timestamps with Chinese units', () => {
    expect(pastedTextStamp(new Date(2026, 9, 1, 8, 5, 3))).toBe('2026年10月01日08时05分03秒')
  })

  it('detects @ queries at the cursor only after whitespace or start', () => {
    expect(mentionQueryFromDraft('@')).toEqual({ start: 0, query: '' })
    expect(mentionQueryFromDraft('看 @SH粘贴')).toEqual({ start: 2, query: 'SH粘贴' })
    expect(mentionQueryFromDraft('mail@example')).toBeNull()
    expect(mentionQueryFromDraft('@abc 后续', 4)).toEqual({ start: 0, query: 'abc' })
    expect(mentionQueryFromDraft('@abc 后续')).toBeNull()
  })

  it('filters files and prefixes text paths to the message', () => {
    const files = [{ name: 'SH粘贴-2026年10月21日14时05分33秒.txt' }, { name: 'SH粘贴-2026年10月20日09时00分00秒.txt' }]
    expect(matchPastedTextFiles(files, '21日')).toEqual([files[0]])
    expect(buildCliMessageWithTextFiles('说明', ['D:/a.txt'])).toBe('文本路径：D:/a.txt\n说明')
    expect(buildCliMessageWithTextFiles('', ['D:/a.txt', 'D:/b.txt', 'D:/a.txt'])).toBe('文本1路径：D:/a.txt\n文本2路径：D:/b.txt')
  })
})
