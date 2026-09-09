import type { ItemSearchPhraseRule } from '@/types'

export function applyItemSearchPhrases(query: string, rules: ItemSearchPhraseRule[] = []): string {
  let result = query
  const usableRules = rules
    .map((rule) => ({
      phrase: rule.phrase.trim(),
      value: rule.value.trim(),
    }))
    .filter((rule) => rule.phrase && rule.value)
    .sort((left, right) => right.phrase.length - left.phrase.length)

  for (const rule of usableRules) {
    result = result.split(rule.phrase).join(rule.value)
  }
  return result
}
