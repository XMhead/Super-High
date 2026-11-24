import { describe, expect, it } from 'vitest'
import { uiDraftBindings } from './superhighUiDraft'

describe('IUI draft binding', () => {
  it('rejects exited or replaced sessions and deduplicates concurrent and repeated confirmations', async () => {
    const path = 'D:/test/binding.shui'
    const binding = uiDraftBindings.begin(path, 's1')!
    uiDraftBindings.activate(path, binding, 'D:/test')
    let release!: (live: 'live' | 'ended' | 'unavailable') => void
    const live = () => new Promise<'live' | 'ended' | 'unavailable'>((resolve) => { release = resolve })
    const result: string[] = []
    const append = (_id: string, _root: string, text: string) => { result.push(text); return true }
    const pending = uiDraftBindings.submit(path, '确认', live, append)
    expect(await uiDraftBindings.submit(path, '确认', live, append)).toBe('pending')
    uiDraftBindings.invalidateSession('s1')
    release('live')
    expect(await pending).toBe('ended')
    const next = uiDraftBindings.begin(path, 's2')!
    uiDraftBindings.activate(path, next, 'D:/test')
    expect(await uiDraftBindings.submit(path, '确认', async () => 'live', append)).toBe('inserted')
    expect(await uiDraftBindings.submit(path, '确认', async () => 'live', append)).toBe('duplicate')
    expect(await uiDraftBindings.submit(path, '修改', async () => 'ended', append)).toBe('ended')
    expect(await uiDraftBindings.submit(path, '修改', async () => 'live', append)).toBe('ended')
    const third = uiDraftBindings.begin(path, 's3')!
    uiDraftBindings.activate(path, third, 'D:/test')
    expect(await uiDraftBindings.submit(path, '确认', async () => 'unavailable', append)).toBe('unavailable')
    expect(await uiDraftBindings.submit('D:/test/unbound.shui', '确认', async () => 'live', append)).toBe('unbound')
    expect(result).toEqual(['确认'])
  })
})
