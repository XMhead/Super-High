import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEditorContentChanges, createTrailingTask, createVersionCache } from './editorInputAnalysis'

afterEach(() => vi.useRealTimers())

describe('editor input analysis', () => {
  it('applies simultaneous edits against original UTF-16 offsets, including undo and CRLF', () => {
    const source = '😀name: old\r\nother: old\r\n'
    expect(applyEditorContentChanges(source, [
      { rangeOffset: 8, rangeLength: 3, text: 'new' },
      { rangeOffset: 20, rangeLength: 3, text: 'value' },
    ])).toBe('😀name: new\r\nother: value\r\n')
    expect(applyEditorContentChanges('abc', [
      { rangeOffset: 0, rangeLength: 3, text: '' },
    ])).toBe('')
  })

  it('coalesces continuous input, caches only the current model version, and cancels on disposal', () => {
    vi.useFakeTimers()
    const cache = createVersionCache<object>()
    const first = {}
    const second = {}
    let model = first
    let version = 1
    const parse = vi.fn(() => version)
    const analyze = () => cache.get(model, version, 'syntax', parse)
    const task = createTrailingTask(analyze, 160)
    for (let index = 0; index < 30; index += 1) {
      version += 1
      task.schedule()
      vi.advanceTimersByTime(20)
    }
    expect(parse).not.toHaveBeenCalled()
    vi.advanceTimersByTime(160)
    expect(parse).toHaveBeenCalledTimes(1)
    analyze()
    expect(parse).toHaveBeenCalledTimes(1)
    model = second
    analyze()
    expect(parse).toHaveBeenCalledTimes(2)
    task.schedule()
    task.cancel()
    vi.runAllTimers()
    expect(parse).toHaveBeenCalledTimes(2)
  })
})
