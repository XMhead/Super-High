import { describe, expect, it } from 'vitest'
import { parsePreviewOptions } from './options'

describe('preview parameters', () => {
  it('defaults to a persistent interactive settings session', () => {
    expect(parsePreviewOptions('')).toMatchObject({ section: 'general', mode: 'simulate', scenario: 'ready', persist: true })
  })
  it('selects a repeatable themed error scenario', () => {
    expect(parsePreviewOptions('?section=mobile&scenario=error&theme=light&persist=0')).toMatchObject({ section: 'mobile', scenario: 'error', theme: 'light', persist: false })
  })
  it.each(['section=missing', 'scenario=missing', 'theme=missing', 'mode=missing', 'persist=yes'])(
    'rejects invalid parameters: %s', query => { expect(() => parsePreviewOptions(`?${query}`)).toThrow() },
  )
})
