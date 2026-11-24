import { afterEach, describe, expect, it, vi } from 'vitest'
import { createYamlSyntaxAnalysis, type YamlSyntaxResponse } from './yamlSyntaxAnalysis'

function setup() {
  vi.useFakeTimers()
  const workers: Array<{
    onmessage: ((event: MessageEvent<YamlSyntaxResponse>) => void) | null
    onerror: ((error: unknown) => void) | null
    onmessageerror: ((error: unknown) => void) | null
    postMessage: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
  }> = []
  const createWorker = vi.fn(() => {
    const worker = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() }
    workers.push(worker)
    return worker as unknown as Worker
  })
  return { analysis: createYamlSyntaxAnalysis(createWorker), workers, createWorker, accept: vi.fn(), fail: vi.fn() }
}

afterEach(() => vi.useRealTimers())

describe('YAML background analysis', () => {
  it('coalesces edits, rejects stale results immediately, and stops stale work before sending the latest version', () => {
    const { analysis, workers, accept, fail } = setup()
    analysis.schedule('old: value', accept, fail)
    vi.advanceTimersByTime(160)
    expect(workers[0].postMessage).toHaveBeenCalledWith({ id: 1, text: 'old: value' })
    analysis.schedule('new: value', accept, fail)
    workers[0].onmessage!(new MessageEvent<YamlSyntaxResponse>('message', { data: { id: 1, issues: [] } }))
    expect(accept).not.toHaveBeenCalled()
    vi.advanceTimersByTime(160)
    expect(workers).toHaveLength(1)
    analysis.schedule('newest: value', accept, fail)
    analysis.schedule('final: value', accept, fail)
    vi.advanceTimersByTime(160)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[1].postMessage).toHaveBeenCalledWith({ id: 4, text: 'final: value' })
    workers[0].onmessage!(new MessageEvent<YamlSyntaxResponse>('message', { data: { id: 2, issues: [] } }))
    expect(accept).not.toHaveBeenCalled()
    workers[1].onmessage!(new MessageEvent<YamlSyntaxResponse>('message', { data: { id: 4, issues: [] } }))
    expect(accept).toHaveBeenCalledOnce()
    analysis.cancel()
  })

  it('delays large documents and cancels both timers and active work on tab changes or disposal', () => {
    const { analysis, workers, accept, fail } = setup()
    analysis.schedule('x'.repeat(1024 * 1024), accept, fail)
    vi.advanceTimersByTime(999)
    expect(workers).toHaveLength(0)
    vi.advanceTimersByTime(1)
    analysis.cancel()
    workers[0].onmessage!(new MessageEvent<YamlSyntaxResponse>('message', { data: { id: 1, issues: [] } }))
    expect(accept).not.toHaveBeenCalled()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    analysis.schedule('next: value', accept, fail)
    analysis.cancel()
    vi.advanceTimersByTime(1000)
    expect(workers).toHaveLength(1)
  })

  it('reports worker failure without synchronous parsing and can recover on the next edit', () => {
    const { analysis, workers, accept, fail } = setup()
    analysis.schedule('first: value', accept, fail)
    vi.advanceTimersByTime(160)
    workers[0].onerror!('worker failed')
    expect(fail).toHaveBeenCalledWith('worker failed')
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    analysis.schedule('second: value', accept, fail)
    vi.advanceTimersByTime(160)
    workers[1].onmessage!(new MessageEvent<YamlSyntaxResponse>('message', { data: { id: 2, issues: [] } }))
    expect(accept).toHaveBeenCalledWith([])
    analysis.cancel()
  })
})
