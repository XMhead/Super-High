import { normalizePath } from '@/lib/path'
import { backend } from '@/lib/tauri'
import type { CliConversationMessage } from '@/types'

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function createPromptHistoryCache(load: (path: string) => Promise<CliConversationMessage[]>) {
  const snapshots = new Map<string, CliConversationMessage[]>()
  const pending = new Map<string, Promise<CliConversationMessage[]>>()
  const keyFor = (path: string) => normalizePath(path.trim()).replace(/\/+$/, '').toLowerCase()
  const recent = (entries: CliConversationMessage[]) => {
    const now = Date.now()
    return entries.filter((entry) => {
      const timestamp = Date.parse(entry.timestamp)
      return timestamp <= now && timestamp >= now - WINDOW_MS
    }).slice(0, 50)
  }

  return {
    peek(path: string) {
      const key = keyFor(path)
      const entries = snapshots.get(key)
      if (!entries) return undefined
      const snapshot = recent(entries)
      snapshots.delete(key)
      snapshots.set(key, snapshot)
      return snapshot
    },
    refresh(path: string): Promise<CliConversationMessage[]> {
      const key = keyFor(path)
      const running = pending.get(key)
      if (running) return running
      const request = load(path).then((entries) => {
        const snapshot = recent(entries)
        if (pending.get(key) === request) {
          snapshots.delete(key)
          snapshots.set(key, snapshot)
          while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!)
        }
        return snapshot
      }).finally(() => {
        if (pending.get(key) === request) pending.delete(key)
      })
      pending.set(key, request)
      return request
    },
    clear() {
      snapshots.clear()
      pending.clear()
    },
  }
}

export const promptHistoryCache = createPromptHistoryCache((path) => backend.listWorkspacePromptHistory(path))
