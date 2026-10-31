import { expect, it } from 'vitest'
import { chatHistoryAge, groupChatHistory } from './chatHistory'
import type { CliNativeConversationSummary } from '@/types'

const record = (id: string, cwd: string, providerKind = 'codex', title = id): CliNativeConversationSummary => ({
  id, cwd, providerKind, title, summary: '', nativeSessionId: id, createdAt: '', updatedAt: '2026-10-30T08:00:00Z', messageCount: 2, sourcePath: id, resumeSupported: true,
})

it('keeps workspaces separate while merging Windows path aliases and avoiding restored-session duplicates', () => {
  const groups = groupChatHistory([record('one', 'D:/Project'), record('two', 'D:/Other'), record('three', 'd:\\project\\'), record('one', 'D:/Project')],
    [{ id: 'live', cwd: 'D:\\PROJECT', providerKind: 'codex', title: 'running', nativeConversationId: 'one' }], ['D:/Empty'])
  expect(groups).toHaveLength(3)
  expect(groups[0].key).toBe('d:/project')
  expect(groups[0].sessions.map(item => item.id)).toEqual(['live'])
  expect(groups[0].conversations.map(item => item.id)).toEqual(['three'])
  expect(groups.find(group => group.path === 'D:/Other')?.conversations.map(item => item.id)).toEqual(['two'])
  expect(groups.find(group => group.path === 'D:/Empty')?.conversations).toEqual([])
})

it('searches titles, providers and workspace paths together and filters providers without losing hidden history', () => {
  const records = [record('a', 'D:/Server', 'claude', '修复聊天'), record('b', 'D:/Tools', 'codex', '修复聊天'), record('c', 'D:/Server', 'dsh', '检查记录')]
  expect(groupChatHistory(records, [], [], '修复', 'claude').flatMap(group => group.conversations.map(item => item.id))).toEqual(['a'])
  expect(groupChatHistory(records, [], [], 'server').flatMap(group => group.conversations.map(item => item.id))).toEqual(['a', 'c'])
  expect(groupChatHistory(records, [], [], 'OpenCode')).toEqual([])
  expect(groupChatHistory(records, [], [], 'codex').flatMap(group => group.conversations.map(item => item.id))).toEqual(['b'])
})

it('handles future and invalid timestamps without fabricated ages', () => {
  expect(chatHistoryAge('invalid', Date.now())).toBe('')
  expect(chatHistoryAge('2026-10-30T08:00:00Z', Date.parse('2026-10-30T07:00:00Z'))).toBe('刚刚')
  expect(chatHistoryAge('2026-10-30T08:00:00Z', Date.parse('2026-10-30T09:05:00Z'))).toBe('1小时')
})

it('matches an open session by source path within its provider and workspace', () => {
  const item = record('conversation', 'D:/Project')
  item.sourcePath = 'D:/history/session.jsonl'
  const session = { id: 'live', cwd: 'd:/project', providerKind: 'codex', title: 'running', nativeConversationId: item.sourcePath }
  expect(groupChatHistory([item], [session], [])[0].conversations).toEqual([])
  expect(groupChatHistory([item], [{ ...session, providerKind: 'claude' }], []).flatMap(group => group.conversations)).toEqual([item])
})
