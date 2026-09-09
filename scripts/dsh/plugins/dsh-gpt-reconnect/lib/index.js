import { randomUUID } from 'node:crypto'

export const name = 'gpt-transport-reconnect'
export const inject = ['agents']

const INITIAL_DELAY_MS = 5000
const MAX_DELAY_MS = 60000
const POLICY_NAME = 'gpt-transport-reconnect/v1'
const RECONNECTABLE_CODES = new Set(['TRANSPORT', 'STREAM_CLOSED'])
// These are the Responses routes currently used by Super High/DSH. A missing
// response.completed is a transport-level failure for all of them, so retry
// the whole request the same way Codex does after an early stream close.
const RECONNECTABLE_PROVIDERS = new Set(['opencode-go', 'grok', 'terra', 'itai'])

export function reconnectDelayMs(retry, initialDelayMs = INITIAL_DELAY_MS, maxDelayMs = MAX_DELAY_MS) {
  return Math.min(initialDelayMs * 2 ** Math.min(retry - 1, 30), maxDelayMs)
}

function resolveConfig(config = {}) {
  const initialDelayMs = config.initialDelayMs ?? INITIAL_DELAY_MS
  const maxDelayMs = config.maxDelayMs ?? MAX_DELAY_MS
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
    throw new Error('gpt-transport-reconnect: initialDelayMs must be a positive finite number')
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error('gpt-transport-reconnect: maxDelayMs must be a finite number not below initialDelayMs')
  }
  return { initialDelayMs, maxDelayMs }
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function previousRetry(events, turn, step, provider, policyKey) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'llm/retry'
      && event.data?.turn === turn
      && event.data?.step === step
      && event.data?.provider === provider
      && event.data?.policyKey === policyKey) {
      return event.data
    }
  }
}

/**
 * Reconnect Responses providers when an attempt lost its transport before
 * completion. Other providers and failures keep the bounded dsh-llm-retry
 * policy.
 */
export function apply(ctx, config = {}) {
  const retryConfig = resolveConfig(config)
  const policyKey = JSON.stringify([POLICY_NAME, retryConfig.initialDelayMs, retryConfig.maxDelayMs])
  const lifetime = new AbortController()
  const active = new Set()

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function reconnect({ agent, turn, step, provider, failure, signal }, next) {
    if (!RECONNECTABLE_PROVIDERS.has(provider) || !RECONNECTABLE_CODES.has(failure?.code)) return next()
    const combinedSignal = signal === undefined
      ? lifetime.signal
      : AbortSignal.any([signal, lifetime.signal])
    if (combinedSignal.aborted) return

    const previous = previousRetry(agent.session.events, turn, step, provider, policyKey)
    const retry = (previous?.retry ?? 0) + 1
    const retryId = previous?.retryId ?? randomUUID()
    const delayMs = reconnectDelayMs(retry, retryConfig.initialDelayMs, retryConfig.maxDelayMs)
    agent.session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: 'always',
      policyKey,
      retry,
      delayMs,
      failure,
    })
    ctx.logger?.warn?.(`gpt-transport-reconnect: ${provider} ${failure.code}; retry ${retry} in ${delayMs}ms`)
    if (!await cancellableDelay(delayMs, combinedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve()
    return track(reconnect(payload, next))
  })
  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('gpt-transport-reconnect disposed'))
    await Promise.allSettled([...active])
  }, 'gpt-transport-reconnect: abort and drain active reconnects')
}
