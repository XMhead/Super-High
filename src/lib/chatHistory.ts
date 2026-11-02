import type { CliNativeConversationSummary, TerminalSession } from '@/types'
import { cliProviderLabel } from './cliProviders'
import { fileNameFromPath, normalizePath } from './path'

export const chatWorkspaceKey = (path: string) => normalizePath(path).replace(/\/$/, '').toLocaleLowerCase()

export interface ChatHistoryGroup {
  key: string
  path: string
  name: string
  sessions: TerminalSession[]
  conversations: CliNativeConversationSummary[]
  updatedAt: string
}

/** Group native history by its own cwd; opening a row never changes the active workspace. */
export function groupChatHistory(
  history: CliNativeConversationSummary[], sessions: TerminalSession[], paths: string[], query = '', provider = '',
): ChatHistoryGroup[] {
  const groups = new Map<string, ChatHistoryGroup>()
  const needle = query.trim().toLocaleLowerCase()
  const matches = (kind: string, path: string, title: string, summary = '') => (!provider || kind === provider)
    && (!needle || `${path}\n${title}\n${summary}\n${cliProviderLabel(kind)}`.toLocaleLowerCase().includes(needle))
  const group = (path: string) => {
    const key = chatWorkspaceKey(path)
    if (!groups.has(key)) groups.set(key, { key, path, name: fileNameFromPath(path) || '未知工作区', sessions: [], conversations: [], updatedAt: '' })
    return groups.get(key)!
  }
  if (!needle && !provider) paths.filter(Boolean).forEach(group)
  for (const session of sessions) {
    if (matches(session.providerKind, session.cwd, session.name || session.terminalTitle || session.title)) group(session.cwd).sessions.push(session)
  }
  const seen = new Set<string>()
  for (const conversation of history) {
    if (seen.has(conversation.id)) continue
    seen.add(conversation.id)
    if (!matches(conversation.providerKind, conversation.cwd, conversation.title, conversation.summary)) continue
    const target = group(conversation.cwd)
    if (conversation.updatedAt > target.updatedAt) target.updatedAt = conversation.updatedAt
    const open = sessions.some(session => session.providerKind === conversation.providerKind
      && chatWorkspaceKey(session.cwd) === chatWorkspaceKey(conversation.cwd)
      && !!session.nativeConversationId
      && (session.nativeConversationId === conversation.id || chatWorkspaceKey(session.nativeConversationId) === chatWorkspaceKey(conversation.sourcePath)))
    if (!open) target.conversations.push(conversation)
  }
  for (const target of groups.values()) target.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return [...groups.values()].sort((a, b) => Number(b.sessions.length > 0) - Number(a.sessions.length > 0)
    || b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path))
}

export function chatHistoryAge(timestamp: string, now: number): string {
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时`
  if (minutes < 1440 * 7) return `${Math.floor(minutes / 1440)}天`
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
