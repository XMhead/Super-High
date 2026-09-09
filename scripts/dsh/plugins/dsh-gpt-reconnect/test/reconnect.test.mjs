import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, reconnectDelayMs } from '../lib/index.js'

function harness(config = {}) {
  let requestError
  const cleanups = []
  const ctx = {
    logger: { warn() {} },
    on(name, listener) {
      assert.equal(name, 'agent/request-error')
      requestError = listener
      return () => {}
    },
    effect(factory) {
      cleanups.push(factory())
    },
  }
  apply(ctx, config)
  const session = {
    events: [],
    append(type, data) {
      this.events.push({ type, data })
    },
  }
  return {
    requestError,
    session,
    agent: { session },
    async dispose() {
      await Promise.all(cleanups.map(cleanup => cleanup()))
    },
  }
}

test('uses the Codex-style capped connection backoff', () => {
  assert.equal(reconnectDelayMs(1), 5000)
  assert.equal(reconnectDelayMs(2), 10000)
  assert.equal(reconnectDelayMs(3), 20000)
  assert.equal(reconnectDelayMs(4), 40000)
  assert.equal(reconnectDelayMs(5), 60000)
  assert.equal(reconnectDelayMs(20), 60000)
})

test('retries Responses transport failures indefinitely and preserves retry identity', async () => {
  const subject = harness({ initialDelayMs: 1, maxDelayMs: 4 })
  const payload = {
    agent: subject.agent,
    turn: 3,
    step: 7,
    provider: 'terra',
    failure: { code: 'TRANSPORT', message: 'connection closed' },
    signal: new AbortController().signal,
  }
  const unexpectedNext = () => assert.fail('transport reconnect must own this failure')

  assert.deepEqual(await subject.requestError(payload, unexpectedNext), { kind: 'retry' })
  assert.deepEqual(await subject.requestError(payload, unexpectedNext), { kind: 'retry' })
  assert.equal(subject.session.events.length, 4)
  assert.equal(subject.session.events[0].data.retry, 1)
  assert.equal(subject.session.events[0].data.delayMs, 1)
  assert.equal(subject.session.events[2].data.retry, 2)
  assert.equal(subject.session.events[2].data.delayMs, 2)
  assert.equal(subject.session.events[0].data.retryId, subject.session.events[2].data.retryId)
  await subject.dispose()
})

test('retries the active opencode-go Responses route', async () => {
  const subject = harness({ initialDelayMs: 1, maxDelayMs: 2 })
  const payload = {
    agent: subject.agent,
    turn: 1,
    step: 1,
    provider: 'opencode-go',
    failure: { code: 'TRANSPORT', message: 'OpenAI Responses stream ended before a terminal response event' },
    signal: new AbortController().signal,
  }

  assert.deepEqual(await subject.requestError(payload, () => assert.fail('opencode-go transport reconnect must own this failure')), { kind: 'retry' })
  assert.equal(subject.session.events[0].data.provider, 'opencode-go')
  await subject.dispose()
})

test('delegates non-transport failures and stops immediately after cancellation', async () => {
  const subject = harness({ initialDelayMs: 1, maxDelayMs: 4 })
  let delegated = false
  const normalPayload = {
    agent: subject.agent,
    turn: 1,
    step: 1,
    provider: 'terra',
    failure: { code: 'AUTH', message: 'invalid key' },
    signal: new AbortController().signal,
  }
  assert.deepEqual(await subject.requestError(normalPayload, () => {
    delegated = true
    return { kind: 'surface' }
  }), { kind: 'surface' })
  assert.equal(delegated, true)

  const controller = new AbortController()
  controller.abort()
  const cancelledPayload = { ...normalPayload, failure: { code: 'STREAM_CLOSED', message: 'closed' }, signal: controller.signal }
  assert.equal(await subject.requestError(cancelledPayload, () => assert.fail('cancelled reconnect must not delegate')), undefined)
  assert.equal(subject.session.events.length, 0)
  await subject.dispose()
})
