import { describe, expect, it } from 'vitest'

import type { CliConversationMessage } from '@/types'
import { useHistoryTabCompletion } from './useHistoryTabCompletion'

function userMessage(id: string, content: string, timestamp = '2026-08-20T10:00:00.000Z'): CliConversationMessage {
  return { id, sessionId: 'session-main', role: 'user', content, timestamp }
}

function setup(history: CliConversationMessage[], initialDraft = '') {
  let draft = initialDraft
  let cursor = draft.length
  const completion = useHistoryTabCompletion({
    history: () => history,
    getDraft: () => draft,
    getCursorOffset: () => cursor,
    applyDraft: (text, cursorOffset) => {
      draft = text
      if (cursorOffset !== undefined) cursor = cursorOffset
    },
  })
  return {
    completion,
    setDraft: (text: string, atCursor?: number) => {
      draft = text
      cursor = atCursor ?? text.length
    },
    getDraft: () => draft,
  }
}

describe('useHistoryTabCompletion', () => {
  const history = [
    userMessage('n1', '继续', '2026-08-20T10:00:00.000Z'),
    userMessage('n2', '继续', '2026-08-19T10:00:00.000Z'),
    userMessage('n3', '继续', '2026-08-18T10:00:00.000Z'),
    userMessage('n4', '继续做下一个任务', '2026-08-17T10:00:00.000Z'),
    userMessage('n5', '图片路径：D:/示例项目/工作区/plugins/a.png', '2026-08-16T10:00:00.000Z'),
    userMessage('n6', '把 D:\\示例项目\\工作区\\plugins\\a.png 收录', '2026-08-15T10:00:00.000Z'),
    userMessage('n7', '使用 agents-updater 更新', '2026-08-14T10:00:00.000Z'),
  ]

  it('empty draft + Tab shows the most frequent short phrases with counts', () => {
    const { completion } = setup(history)
    expect(completion.refresh()).toBe('')
    expect(completion.popupOpen.value).toBe(true)
    expect(completion.candidates.value).toEqual(['继续'])
    expect(completion.candidateCounts.value).toEqual([3])

    expect(completion.confirm()).toBe(true)
  })

  it('message candidates are ranked by usage frequency, then recency', () => {
    const { completion, setDraft, getDraft } = setup(history)
    setDraft('继')
    completion.refresh()
    expect(completion.candidates.value).toEqual(['继续', '继续做下一个任务'])
    expect(completion.candidateCounts.value).toEqual([3, 1])
    // 确认后整条替换（message 模式）
    expect(completion.confirm()).toBe(true)
    expect(getDraft()).toBe('继续')
  })

  it('path fragment completion replaces only the path run and keeps surrounding text', () => {
    const { completion, setDraft, getDraft } = setup(history)
    setDraft('把 D:/示例项目/工 收录', 11)
    completion.refresh()
    expect(completion.popupOpen.value).toBe(true)
    expect(completion.candidates.value[0]).toBe('D:/示例项目/工作区/plugins/a.png')
    // 路径标签显示尾部
    expect(completion.candidateLabels.value[0]).toBe('工作区/plugins/a.png')
    expect(completion.confirm()).toBe(true)
    expect(getDraft()).toBe('把 D:/示例项目/工作区/plugins/a.png 收录')
  })

  it('word completion still works as the fallback mode', () => {
    const { completion, setDraft, getDraft } = setup(history)
    setDraft('使用ag', 4)
    completion.refresh()
    expect(completion.candidates.value).toEqual(['agents-updater'])
    expect(completion.confirm()).toBe(true)
    expect(getDraft()).toBe('使用agents-updater')
  })

  it('returns a hint text when nothing matches', () => {
    const { completion, setDraft } = setup(history)
    setDraft('missing')
    const hint = completion.refresh()
    expect(completion.popupOpen.value).toBe(false)
    expect(hint).toContain('「missing」')
  })
})
