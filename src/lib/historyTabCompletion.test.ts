import { describe, expect, it } from 'vitest'

import type { CliConversationMessage } from '@/types'
import {
  buildHistoryUsageCache,
  currentPathFragment,
  currentWordFragment,
  matchHistoryPathCandidates,
  matchHistoryWordCandidates,
  mergeHistoryMessages,
} from './historyTabCompletion'

function userMessage(id: string, content: string): CliConversationMessage {
  return {
    id,
    sessionId: 'session-main',
    role: 'user',
    content,
    timestamp: '2026-08-20T10:00:00.000Z',
  }
}

describe('currentWordFragment', () => {
  it('takes the word run before the cursor, stopping at CJK / space / punctuation', () => {
    // 中英混排：agents-updater 藏在汉字后面也能取到
    expect(currentWordFragment('使用ag', 4)).toEqual({ fragment: 'ag', start: 2, end: 4 })
    expect(currentWordFragment('帮我 使用ag 弄', 7)).toEqual({ fragment: 'ag', start: 5, end: 7 })
    expect(currentWordFragment('deP', 3)).toEqual({ fragment: 'deP', start: 0, end: 3 })
    // 光标停在词中间：取整个词片段，便于替换
    expect(currentWordFragment('agents-updater', 8)).toEqual({ fragment: 'agents-u', start: 0, end: 8 })
  })

  it('returns null when nothing word-like precedes the cursor', () => {
    expect(currentWordFragment('', 0)).toBeNull()
    expect(currentWordFragment('帮我使用', 4)).toBeNull()
    expect(currentWordFragment('使用 ', 3)).toBeNull()
    expect(currentWordFragment('使用ag', 2)).toBeNull()
  })

  it('clamps out-of-range cursor offsets', () => {
    expect(currentWordFragment('ag', 99)).toEqual({ fragment: 'ag', start: 0, end: 2 })
    expect(currentWordFragment('ag', -1)).toBeNull()
  })
})

describe('matchHistoryWordCandidates', () => {
  const messages = [
    userMessage('1', '使用agents-updater skills 更新'),
    userMessage('2', '帮我用 typescript 配置'),
    userMessage('3', 'AGENTS 大写词'),
  ]

  it('finds words starting with the fragment, including words hidden after CJK', () => {
    expect(matchHistoryWordCandidates(messages, 'ag')).toEqual(['agents-updater', 'AGENTS'])
    expect(matchHistoryWordCandidates(messages, 'type')).toEqual(['typescript'])
    expect(matchHistoryWordCandidates(messages, 'skill')).toEqual(['skills'])
  })

  it('skips words identical to the fragment and dedupes exact duplicates', () => {
    expect(matchHistoryWordCandidates([userMessage('1', '用 ag 结尾'), userMessage('2', 'ag 开头')], 'ag')).toEqual([])
    expect(matchHistoryWordCandidates([
      userMessage('1', 'alpha alpha'),
      userMessage('2', 'alpha again'),
    ], 'alp')).toEqual(['alpha'])
  })

  it('returns nothing for fragments without matches or empty input', () => {
    expect(matchHistoryWordCandidates(messages, 'zzz')).toEqual([])
    expect(matchHistoryWordCandidates(messages, '  ')).toEqual([])
    expect(matchHistoryWordCandidates([], 'ag')).toEqual([])
  })
})

describe('currentPathFragment', () => {
  it('takes the continuous non-space run before the cursor, including path separators', () => {
    expect(currentPathFragment('把 D:/示例项目/记录 弄一下', 12))
      .toEqual({ fragment: 'D:/示例项目/记录', start: 2, end: 12 })
    expect(currentPathFragment('使用 D:\\Demo Files\\src', 20))
      .toEqual({ fragment: 'D:\\Demo Files\\src', start: 3, end: 20 })
  })

  it('stops at quotes so quoted paths complete inside the quotes', () => {
    expect(currentPathFragment('路径："D:/x/y"', 10))
      .toEqual({ fragment: 'D:/x/y', start: 4, end: 10 })
  })

  it('returns null when the fragment is not path-like (no drive, no separators)', () => {
    expect(currentPathFragment('使用ag', 4)).toBeNull()
    expect(currentPathFragment('hello world', 11)).toBeNull()
    expect(currentPathFragment('继续', 2)).toBeNull()
    expect(currentPathFragment('', 0)).toBeNull()
  })

  it('accepts a bare drive letter as a path fragment', () => {
    expect(currentPathFragment('D:', 2)).toEqual({ fragment: 'D:', start: 0, end: 2 })
  })

  it('clamps out-of-range cursor offsets', () => {
    expect(currentPathFragment('D:/x', 99)).toEqual({ fragment: 'D:/x', start: 0, end: 4 })
  })
})

describe('buildHistoryUsageCache', () => {
  // messages 按新近度倒序：index 越小越新
  const messages = [
    userMessage('1', '继续'),
    userMessage('2', '继续'),
    userMessage('3', '继续'),
    userMessage('4', '继续做下一个任务'),
    userMessage('5', '图片路径：D:/示例项目/工作区/plugins/a.png'),
    userMessage('6', '把 D:\\示例项目\\工作区\\plugins\\a.png 放进去'),
    userMessage('7', '用 D:\\示例项目\\工作区\\other.png 看看'),
    userMessage('8', '一次性长消息'.repeat(10)),
  ]

  it('counts exact message reuse and ranks frequent phrases by count then recency', () => {
    const cache = buildHistoryUsageCache(messages)
    expect(cache.countByContent.get('继续')).toBe(3)
    expect(cache.frequentPhrases[0]).toEqual({ text: '继续', count: 3 })
    expect(cache.frequentPhrases).toHaveLength(1)
  })

  it('merges paths case-insensitively and across / vs \\ separators, keeping the newest form', () => {
    const cache = buildHistoryUsageCache(messages)
    expect(cache.paths[0].count).toBe(2)
    // 最新出现的是 / 写法（index 5 早于 index 6），保留 / 写法
    expect(cache.paths[0].path).toBe('D:/示例项目/工作区/plugins/a.png')
    expect(cache.paths[1].count).toBe(1)
    // 排序：次数降序，同频按新近度
    expect(cache.paths[1].path).toBe('D:\\示例项目\\工作区\\other.png')
    expect(cache.paths[1].lastIndex).toBe(6)
  })

  it('merges extra indexed paths so disk history ranks above one-off typed paths', () => {
    const cache = buildHistoryUsageCache(messages, [
      { path: 'D:\\示例项目\\示例项目目录工作区\\plugins', count: 30, lastIndex: 0 },
    ])
    expect(cache.paths[0]).toMatchObject({
      path: 'D:\\示例项目\\示例项目目录工作区\\plugins',
      count: 30,
    })
  })

  it('dedupes live and disk messages by content plus timestamp', () => {
    const live = [userMessage('1', '继续')]
    const disk = [userMessage('2', '继续'), userMessage('3', '打开插件')]
    disk[0].timestamp = live[0].timestamp
    expect(mergeHistoryMessages(live, disk).map((item) => item.content)).toEqual(['继续', '打开插件'])
  })

  it('keeps paths that contain spaces (Super High) and stops at CJK after a space', () => {
    const spaced = [
      userMessage('s1', '看 D:\\Demo Files\\src\\main.ts 和 D:\\Super 收录 文件'),
      userMessage('s2', '再看 D:/ExampleProject/dist 目录'),
    ]
    const cache = buildHistoryUsageCache(spaced)
    expect(cache.paths.map((item) => item.path)).toEqual([
      'D:\\Demo Files\\src\\main.ts',
      // 「D:\Super 收录」在空格后是中文，不在路径内，只截取到 D:\Super
      'D:\\Super',
      'D:/ExampleProject/dist',
    ])
  })
})

describe('matchHistoryPathCandidates', () => {
  const paths = [
    { path: 'D:\\示例项目\\工作区\\plugins\\a.png', count: 3, lastIndex: 1 },
    { path: 'D:\\示例项目\\工作区\\plugins\\b.png', count: 2, lastIndex: 2 },
    { path: 'E:\\空轨\\x.jar', count: 5, lastIndex: 0 },
  ]

  it('matches by prefix case-insensitively and adapts separators to the typed fragment', () => {
    const candidates = matchHistoryPathCandidates(paths, 'D:/示例项目/工作区')
    expect(candidates.map((item) => item.path)).toEqual([
      'D:/示例项目/工作区/plugins/a.png',
      'D:/示例项目/工作区/plugins/b.png',
    ])
    expect(candidates[0]?.count).toBe(3)
    // 弹窗标签只显示尾部，头部已在输入框里
    expect(candidates[0]?.label).toBe('工作区/plugins/a.png')
  })

  it('keeps backslash form when the typed fragment uses backslashes', () => {
    const candidates = matchHistoryPathCandidates(paths, 'D:\\示例项目')
    expect(candidates[0]?.path).toBe('D:\\示例项目\\工作区\\plugins\\a.png')
  })

  it('skips paths identical to the fragment and returns nothing for empty input', () => {
    expect(matchHistoryPathCandidates(paths, 'D:\\示例项目\\工作区\\plugins\\a.png')).toEqual([])
    expect(matchHistoryPathCandidates(paths, '')).toEqual([])
    expect(matchHistoryPathCandidates([], 'D:/')).toEqual([])
  })
})
