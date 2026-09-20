import { describe, expect, it } from 'vitest'

import { applyItemSearchPhrases } from './itemSearchPhrases'
import type { ItemSearchPhraseRule } from '@/types'

function rule(id: string, phrase: string, value: string): ItemSearchPhraseRule {
  return {
    id,
    phrase,
    value,
    createdAt: '2026-07-05T00:00:00Z',
    updatedAt: '2026-07-05T00:00:00Z',
    history: [],
  }
}

describe('applyItemSearchPhrases', () => {
  it('replaces phrases without requiring spaces', () => {
    expect(applyItemSearchPhrases('1c头盔', [rule('one', '1c', '哥布林')])).toBe('哥布林头盔')
  })

  it('applies multiple phrases and prefers the longest phrase first', () => {
    const rules = [
      rule('short', '1c', '哥布林'),
      rule('long', '1c精英', '哥布林精英'),
      rule('slot', '头盔', '帽子'),
    ]

    expect(applyItemSearchPhrases('1c精英头盔', rules)).toBe('哥布林精英帽子')
  })

  it('ignores empty phrase and value rules', () => {
    const rules = [
      rule('empty-phrase', ' ', '哥布林'),
      rule('empty-value', '1c', ' '),
    ]

    expect(applyItemSearchPhrases('1c头盔', rules)).toBe('1c头盔')
  })
})
