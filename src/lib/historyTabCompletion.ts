import type { CliConversationMessage } from '@/types'

/**
 * 输入框历史消息 Tab 补全的候选匹配与历史收集。
 * 交互状态机见 useHistoryTabCompletion.ts（弹窗预览版）。
 *
 * 补全能力基于用户历史提示词习惯统计：
 * Super High 当前对话 + 磁盘上的 claude/codex 会话记录（写入 super-high.db）：
 * - 整条消息前缀匹配，按「使用频率优先、新近度其次」排序（重复消息是主要习惯，如「继续」）
 * - 光标前是路径片段时优先做「历史路径补全」（用户提示词中约 30% 含盘符路径，平均 69 字符）
 * - 空草稿按 Tab 展示历史高频短语（重复 >= 2 次的短消息）
 */

export function matchHistoryCandidates(messages: CliConversationMessage[], query: string): string[] {
  // 去掉首尾空白再匹配：输入法/手误留下的空格不再让匹配直接失败
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const message of messages) {
    if (!message.content.toLowerCase().startsWith(normalizedQuery) || seen.has(message.content)) continue
    seen.add(message.content)
    candidates.push(message.content)
  }
  return candidates
}

/**
 * 词 = 连续的字母/数字/下划线/连字符；汉字、空格、标点都算词边界。
 * 这样「使用agents-updater」里的 agents-updater 也能被单独识别出来。
 */
const WORD_CHAR = /[A-Za-z0-9_-]/
const WORD_RUN = /[A-Za-z0-9_-]+/g

/**
 * 取输入框里光标前正在输入的「词片段」及其在草稿中的范围。
 * 光标停在词中间也能取到完整片段；没有可补全的片段时返回 null。
 */
export function currentWordFragment(
  draft: string,
  cursorOffset: number,
): { fragment: string; start: number; end: number } | null {
  const end = Math.max(0, Math.min(cursorOffset, draft.length))
  let start = end
  while (start > 0 && WORD_CHAR.test(draft[start - 1])) start -= 1
  const fragment = draft.slice(start, end)
  if (!fragment) return null
  return { fragment, start, end }
}

/**
 * 在历史消息里找「以词片段开头」的词（整条消息开头匹配不到时的兜底）：
 * - 词边界 = 非词字符（汉字/空格/标点），所以「使用agents-updater」里的 agents-updater 能命中 ag
 * - 按消息顺序（最新优先）扫描，完全相同的词只保留第一个
 * - 与片段完全相同的词不参与（补了等于没补）
 */
export function matchHistoryWordCandidates(messages: CliConversationMessage[], fragment: string): string[] {
  const normalizedFragment = fragment.trim().toLowerCase()
  if (!normalizedFragment) return []
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const message of messages) {
    for (const match of message.content.matchAll(WORD_RUN)) {
      const word = match[0]
      if (word === fragment || seen.has(word)) continue
      if (!word.toLowerCase().startsWith(normalizedFragment)) continue
      seen.add(word)
      candidates.push(word)
    }
  }
  return candidates
}

/**
 * 从 terminalConversation 中收集所有 CLI 会话的用户消息，
 * 按时间倒序（最新的排前面），用于 Tab 补全候选。
 */
export function collectCliHistoryMessages(
  conversation: Record<string, CliConversationMessage[]>,
  cliSessionIds: string[],
): CliConversationMessage[] {
  const idSet = new Set(cliSessionIds)
  return Object.values(conversation)
    .flat()
    .filter((message) => (
      idSet.has(message.sessionId)
      && message.role === 'user'
      && !!message.content.trim()
    ))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
}

export function mergeHistoryMessages(
  live: CliConversationMessage[],
  disk: CliConversationMessage[],
): CliConversationMessage[] {
  const seen = new Set<string>()
  const merged: CliConversationMessage[] = []
  for (const message of [...live, ...disk]) {
    const content = message.content.trim()
    if (!content) continue
    const key = `${content}\0${message.timestamp}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(message)
  }
  return merged.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
}

/* ------------------------------------------------------------------ */
/* 以下为基于提示词习惯的补全增强：使用频率统计、历史路径、高频短语      */
/* ------------------------------------------------------------------ */

export interface HistoryPathCandidate {
  /** 历史消息里出现过的完整路径（保留首次出现时的写法） */
  path: string
  /** 该路径在历史消息中出现的次数 */
  count: number
  /** 最近一次出现的消息下标（消息按新近度倒序，越小越新） */
  lastIndex: number
}

export interface HistoryUsageCache {
  /** 消息内容(trim 后) → 出现次数 */
  countByContent: Map<string, number>
  /** 重复 >= 2 次的短消息（<= 40 字符），按次数降序、同频按新近度 */
  frequentPhrases: Array<{ text: string; count: number }>
  /** 历史消息中的盘符绝对路径，按次数降序、同频按新近度 */
  paths: HistoryPathCandidate[]
}

/**
 * 历史消息里形如 D:\xxx 或 D:/xxx 的路径。
 * 允许路径内部空格（如 D:\Demo Files\src）：空格后必须跟拉丁/数字/路径分隔符，
 * 避免把「D:/x 收录」里的中文动词吞进来。
 */
const PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|()[\]{}]*(?:[ \t]+[A-Za-z0-9_\-./\\]+)*/g
const PATH_TRAILING = /[.,;:!?，。；：！？)\]"'`]+$/

/** 归一化路径键：小写 + 分隔符统一为 /，用于大小写/正反斜杠混合匹配 */
function normalizePathKey(path: string): string {
  return path.toLowerCase().replace(/[\\/]+/g, '/')
}

/**
 * 历史使用频率缓存。消息数组引用不变时复用（computed 在同一轮响应式内返回同一引用），
 * 避免每次按键都全量重扫历史。
 */
const usageCacheStore = new WeakMap<CliConversationMessage[], HistoryUsageCache>()

export function buildHistoryUsageCache(
  messages: CliConversationMessage[],
  extraPaths: HistoryPathCandidate[] = [],
): HistoryUsageCache {
  const cached = extraPaths.length ? undefined : usageCacheStore.get(messages)
  if (cached) return cached

  const countByContent = new Map<string, number>()
  const pathByKey = new Map<string, HistoryPathCandidate>()

  for (let index = 0; index < messages.length; index += 1) {
    const content = messages[index].content.trim()
    if (content) {
      countByContent.set(content, (countByContent.get(content) ?? 0) + 1)
    }
    for (const raw of content.matchAll(PATH_RE)) {
      const path = raw[0].replace(PATH_TRAILING, '')
      if (path.length < 4) continue
      const key = normalizePathKey(path)
      const prev = pathByKey.get(key)
      if (prev) {
        prev.count += 1
      } else {
        pathByKey.set(key, { path, count: 1, lastIndex: index })
      }
    }
  }

  for (const extra of extraPaths) {
    const key = normalizePathKey(extra.path)
    if (key.length < 4) continue
    const prev = pathByKey.get(key)
    if (prev) {
      prev.count += extra.count
      prev.lastIndex = Math.min(prev.lastIndex, extra.lastIndex)
    } else {
      pathByKey.set(key, {
        path: extra.path,
        count: extra.count,
        lastIndex: extra.lastIndex,
      })
    }
  }

  // 同频时保持消息新近顺序（messages 已是新→旧），sort 稳定
  const frequentPhrases = [...countByContent.entries()]
    .filter(([text, count]) => count >= 2 && text.length <= 40)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([text, count]) => ({ text, count }))

  const paths = [...pathByKey.values()]
    .sort((left, right) => right.count - left.count || left.lastIndex - right.lastIndex)
    .slice(0, 200)

  const cache: HistoryUsageCache = { countByContent, frequentPhrases, paths }
  if (!extraPaths.length) usageCacheStore.set(messages, cache)
  return cache
}

const CJK_CHAR = /[\u4e00-\u9fff]/

/**
 * 取光标前正在输入的「路径片段」及其范围：
 * - 默认取连续非空白字符（含 \ / . : 等），引号内的路径不越过引号
 * - 路径内部可能有空格（如 D:\Demo Files\src）：只有当空格两侧都是非中文
 *   字符（拉丁字母/数字/标点）时才跨过它，避免把「把 D:/x 收录」里的中文动词吞进来
 * - 片段必须像路径（盘符开头，或包含 / 或 \）才返回
 */
export function currentPathFragment(
  draft: string,
  cursorOffset: number,
): { fragment: string; start: number; end: number } | null {
  const end = Math.max(0, Math.min(cursorOffset, draft.length))
  let start = end
  while (start > 0) {
    const ch = draft[start - 1]
    if (ch === '"' || ch === "'" || ch === '`') break
    if (/\s/.test(ch)) {
      // 空格两侧的非空字符必须都不是中文才跨过（路径内部空格如 Super High）
      let before = start - 1
      while (before > 0 && /\s/.test(draft[before - 1])) before -= 1
      if (before === 0 || CJK_CHAR.test(draft[before - 1]) || CJK_CHAR.test(draft[start] ?? '')) break
      start -= 1
      continue
    }
    start -= 1
  }
  const fragment = draft.slice(start, end)
  if (!fragment) return null
  if (!/^[A-Za-z]:/.test(fragment) && !fragment.includes('\\') && !fragment.includes('/')) return null
  return { fragment, start, end }
}

export interface PathCompletionCandidate {
  /** 补全后的完整路径 */
  path: string
  /** 出现次数 */
  count: number
  /** 弹窗展示用：路径末尾 3 段（头部已在输入框里，不用重复显示） */
  label: string
}

/**
 * 在历史路径里找「以路径片段开头」的候选：
 * - 大小写不敏感，/ 与 \ 等价（用户两种写法混用）
 * - 若用户当前用的是 /，补全结果统一转成 /（沿用输入习惯）
 * - 与片段完全相同的路径不参与
 */
export function matchHistoryPathCandidates(
  paths: HistoryPathCandidate[],
  fragment: string,
): PathCompletionCandidate[] {
  const normalizedFragment = fragment.trim().toLowerCase().replace(/[\\/]+/g, '/')
  if (!normalizedFragment) return []
  const sep = fragment.includes('/') ? '/' : '\\'
  const candidates: PathCompletionCandidate[] = []
  for (const item of paths) {
    const key = normalizePathKey(item.path)
    if (key === normalizedFragment || !key.startsWith(normalizedFragment)) continue
    const path = sep === '/' ? item.path.replace(/\\/g, '/') : item.path
    const segments = path.split(/[\\/]+/).filter(Boolean)
    candidates.push({
      path,
      count: item.count,
      label: segments.slice(-3).join(sep),
    })
    if (candidates.length >= 8) break
  }
  return candidates
}
