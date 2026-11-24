import { describe, expect, it } from 'vitest'
import { fileSearchPreviewForMatch } from './fileSearchPreview'

describe('file search full-line validation', () => {
  const line = `BEGIN needle ${'x'.repeat(9000)} END`

  it('validates anchored and distant-context regexes before truncating display', () => {
    expect(fileSearchPreviewForMatch(line, /^BEGIN needle .* END$/)).not.toBeNull()
    expect(fileSearchPreviewForMatch(line, /needle(?=.*END$)/)).toContain('needle')
    expect(fileSearchPreviewForMatch(line, /needle END$/)).toBeNull()
    expect(fileSearchPreviewForMatch(line, /^BEGIN needle .* END$/)!.length).toBeLessThanOrEqual(500)
  })

  it('preserves JavaScript whole-word and case-sensitive filtering', () => {
    expect(fileSearchPreviewForMatch(line, /(?<!\w)(?:needle)(?!\w)/)).toContain('needle')
    expect(fileSearchPreviewForMatch(line, /NEEDLE/)).toBeNull()
    expect(fileSearchPreviewForMatch(line, /NEEDLE/i)).toContain('needle')
    expect(fileSearchPreviewForMatch('needles', /(?<!\w)(?:needle)(?!\w)/)).toBeNull()
  })
})
