import { normalizePath } from './path'

type Binding = { sessionId: string; root: string; active: boolean; ended: boolean; last: string; pending: boolean }
export type UiDraftResult = 'inserted' | 'unbound' | 'ended' | 'unavailable' | 'duplicate' | 'pending'
type LiveResult = 'live' | 'ended' | 'unavailable'
const bindings = new Map<string, Binding>()
const key = (path: string) => normalizePath(path).toLowerCase()

// Only runtime memory: a restarted app can never recover or redirect an old binding.
export const uiDraftBindings = {
  begin(path: string, sessionId?: string | null): Binding | null {
    const k = key(path)
    bindings.delete(k)
    if (!sessionId) return null
    const binding = { sessionId, root: '', active: false, ended: false, last: '', pending: false }
    bindings.set(k, binding)
    return binding
  },
  activate(path: string, binding: Binding, root: string) {
    if (bindings.get(key(path)) !== binding || binding.ended) return
    binding.root = root
    binding.active = true
  },
  invalidateSession(sessionId: string) {
    for (const binding of bindings.values()) if (binding.sessionId === sessionId) binding.ended = true
  },
  async submit(path: string, text: string, live: (sessionId: string, root: string) => Promise<LiveResult>, append: (sessionId: string, root: string, text: string) => boolean): Promise<UiDraftResult> {
    const k = key(path)
    const binding = bindings.get(k)
    if (!binding) return 'unbound'
    if (binding.ended) return 'ended'
    if (!binding.active || !text) return 'unbound'
    if (binding.pending) return 'pending'
    if (binding.last === text) return 'duplicate'
    binding.pending = true
    try {
      const status = await live(binding.sessionId, binding.root)
      if (binding.ended) return 'ended'
      if (bindings.get(k) !== binding) return 'unbound'
      if (status === 'ended') { binding.ended = true; return 'ended' }
      if (status === 'unavailable') return 'unavailable'
      if (!append(binding.sessionId, binding.root, text)) { binding.ended = true; return 'ended' }
      binding.last = text
      return 'inserted'
    } finally { binding.pending = false }
  },
}
