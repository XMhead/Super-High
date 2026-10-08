import { describe, expect, it } from 'vitest'
import { parseDesktopPreviewOptions, parsePreviewOptions } from './options'

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

describe('desktop workspace preview parameters', () => {
  it('defaults to the interactive ready workspace', () => {
    expect(parseDesktopPreviewOptions('')).toMatchObject({ scenario: 'ready', mode: 'simulate', persist: true })
  })
  it('selects a read-only themed error scenario', () => {
    expect(parseDesktopPreviewOptions('?scenario=error&mode=readonly&theme=light&persist=0')).toMatchObject({ scenario: 'error', mode: 'readonly', theme: 'light', persist: false })
  })
  it.each(['scenario=missing', 'mode=missing', 'theme=missing', 'persist=yes'])(
    'rejects invalid parameters: %s', query => { expect(() => parseDesktopPreviewOptions(`?${query}`)).toThrow() },
  )
})
