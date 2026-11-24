import { describe, expect, it, vi } from 'vitest'
import { createPromptHistoryCache } from './promptHistoryCache'
import type { CliConversationMessage } from '@/types'

function message(id: string, age = 0): CliConversationMessage {
  return { id, sessionId: 'native', role: 'user', content: id, timestamp: new Date(Date.now() - age).toISOString() }
}

describe('prompt history cache', () => {
  it('shares pending loads and keeps an immediate workspace snapshot during refresh', async () => {
    let finish!: (entries: CliConversationMessage[]) => void
    const load = vi.fn(() => new Promise<CliConversationMessage[]>((resolve) => { finish = resolve }))
    const cache = createPromptHistoryCache(load)
    const first = cache.refresh('D:/Project')
    expect(cache.refresh('d:\\project\\')).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)
    finish([message('old')])
    await first
    const refresh = cache.refresh('D:/Project')
    expect(cache.peek('d:/PROJECT')?.map((entry) => entry.id)).toEqual(['old'])
    expect(cache.peek('D:/Other')).toBeUndefined()
    finish([message('new'), message('old')])
    await refresh
    expect(cache.peek('D:/Project')?.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('keeps usable results after an update fails and expires old prompts', async () => {
    const load = vi.fn().mockResolvedValueOnce([message('recent'), message('expired', 8 * 86400000)])
      .mockRejectedValueOnce(new Error('unavailable'))
    const cache = createPromptHistoryCache(load)
    await cache.refresh('D:/Project')
    await expect(cache.refresh('D:/Project')).rejects.toThrow('unavailable')
    expect(cache.peek('D:/Project')?.map((entry) => entry.id)).toEqual(['recent'])
  })
})
