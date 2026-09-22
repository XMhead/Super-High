import { ref } from 'vue'

import type { CliConversationMessage } from '@/types'
import {
  buildHistoryUsageCache,
  currentPathFragment,
  currentWordFragment,
  matchHistoryCandidates,
  matchHistoryPathCandidates,
  matchHistoryWordCandidates,
  type HistoryPathCandidate,
} from './historyTabCompletion'

type CompletionMode = 'message' | 'word' | 'path' | 'frequent'

/**
 * 输入框历史消息 Tab 补全的交互状态机（弹窗预览版），基于用户提示词习惯设计：
 * - 空草稿按 Tab → 「常用短语」：历史中重复 >= 2 次的短消息（如「继续」），按次数排序
 * - 光标前是路径片段 → 「历史路径补全」：只替换路径片段，保留其他文字（用户约 30% 提示词含长路径）
 * - 句中正在输入的英文词（片段不在草稿开头）→ 词级补全优先，避免打断句子
 * - 整条消息开头匹配其次，候选按「使用频率降序、新近度其次」排序（重复消息是主要习惯）
 * - 最后兜底词级补全（整条草稿就是一个词，如 deP）
 * - ↑/↓ 移动选中，Tab 确认补全，Esc 关闭
 * - 候选只剩输入本身时不弹（已经"补全完成"）
 */
export function useHistoryTabCompletion(options: {
  history: () => CliConversationMessage[]
  extraPaths?: () => HistoryPathCandidate[]
  getDraft: () => string
  applyDraft: (text: string, cursorOffset?: number) => void
  getCursorOffset?: () => number
}) {
  const candidates = ref<string[]>([])
  /** 与 candidates 平行的出现次数（undefined = 未统计） */
  const candidateCounts = ref<(number | undefined)[]>([])
  /** 与 candidates 平行的弹窗展示文本（undefined = 显示原文） */
  const candidateLabels = ref<(string | undefined)[]>([])
  const selectedIndex = ref(0)
  const popupOpen = ref(false)
  const mode = ref<CompletionMode>('message')
  /** 词级/路径级补全时被替换的范围 */
  const replaceRange = ref<{ start: number; end: number } | null>(null)

  function close() {
    popupOpen.value = false
  }

  /** 按当前输入重新匹配候选并刷新弹窗；无候选时关闭弹窗并返回提示文案。 */
  function refresh(): string {
    const draft = options.getDraft()
    const cursor = options.getCursorOffset?.() ?? draft.length
    const cache = buildHistoryUsageCache(options.history(), options.extraPaths?.() ?? [])

    // 1) 空草稿：展示历史高频短语（用户最常重复的短消息）
    if (!draft.trim()) {
      const phrases = cache.frequentPhrases
      if (!phrases.length) {
        close()
        return ''
      }
      candidates.value = phrases.map((phrase) => phrase.text)
      candidateCounts.value = phrases.map((phrase) => phrase.count)
      candidateLabels.value = phrases.map(() => undefined)
      selectedIndex.value = 0
      mode.value = 'frequent'
      replaceRange.value = null
      popupOpen.value = true
      return ''
    }

    // 2) 光标前是路径片段：优先历史路径补全（用户路径长且反复使用）
    const pathFragment = currentPathFragment(draft, cursor)
    if (pathFragment) {
      const pathCandidates = matchHistoryPathCandidates(cache.paths, pathFragment.fragment)
      if (pathCandidates.length) {
        candidates.value = pathCandidates.map((item) => item.path)
        candidateCounts.value = pathCandidates.map((item) => item.count)
        candidateLabels.value = pathCandidates.map((item) => item.label)
        selectedIndex.value = 0
        mode.value = 'path'
        replaceRange.value = { start: pathFragment.start, end: pathFragment.end }
        popupOpen.value = true
        return ''
      }
    }

    // 3) 正在句中输入英文词（词片段不在草稿开头且有词级候选）时，词级补全优先，
    //    避免整条消息替换打断正在输入的句子（如「使用ag」→ agents-updater）
    const word = currentWordFragment(draft, cursor)
    const wordList = word ? matchHistoryWordCandidates(options.history(), word.fragment) : []
    if (word && word.start > 0 && wordList.length) {
      candidates.value = wordList
      candidateCounts.value = wordList.map(() => undefined)
      candidateLabels.value = wordList.map(() => undefined)
      selectedIndex.value = 0
      mode.value = 'word'
      replaceRange.value = word
      popupOpen.value = true
      return ''
    }

    // 4) 整条消息开头匹配优先（候选按使用频率降序、同频按新近度）
    const messageList = matchHistoryCandidates(options.history(), draft)
    if (messageList.length && !(messageList.length === 1 && messageList[0].trim() === draft.trim())) {
      const ordered = [...messageList].sort((left, right) =>
        (cache.countByContent.get(right.trim()) ?? 0) - (cache.countByContent.get(left.trim()) ?? 0),
      )
      candidates.value = ordered
      candidateCounts.value = ordered.map((text) => cache.countByContent.get(text.trim()))
      candidateLabels.value = ordered.map(() => undefined)
      selectedIndex.value = 0
      mode.value = 'message'
      replaceRange.value = null
      popupOpen.value = true
      return ''
    }

    // 5) 兜底词级补全：整条草稿就是词（如 deP）或消息前缀无匹配时
    if (wordList.length) {
      candidates.value = wordList
      candidateCounts.value = wordList.map(() => undefined)
      candidateLabels.value = wordList.map(() => undefined)
      selectedIndex.value = 0
      mode.value = 'word'
      replaceRange.value = word
      popupOpen.value = true
      return ''
    }

    close()
    return `没有找到以「${draft.trim()}」开头的可补全历史消息或路径`
  }

  /** 确认补全；可选 index 指定要补全的候选（鼠标点击用）。返回是否真的补全了。 */
  function confirm(index?: number): boolean {
    if (!popupOpen.value) return false
    if (index !== undefined && index >= 0 && index < candidates.value.length) {
      selectedIndex.value = index
    }
    const text = candidates.value[selectedIndex.value]
    close()
    if ((mode.value === 'word' || mode.value === 'path') && replaceRange.value && text) {
      // 词级/路径级补全只替换光标前的片段，并把光标移到补全后的末尾
      const draft = options.getDraft()
      const { start, end } = replaceRange.value
      options.applyDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`, start + text.length)
    } else if (text) {
      options.applyDraft(text)
    }
    return true
  }

  /** 移动选中（键盘 ↑/↓ 或 Shift+Tab）。 */
  function move(delta: number) {
    if (!popupOpen.value || !candidates.value.length) return
    selectedIndex.value = (selectedIndex.value + delta + candidates.value.length) % candidates.value.length
  }

  /** 直接跳转到指定候选（鼠标悬停用）。 */
  function moveTo(index: number) {
    if (!popupOpen.value || index < 0 || index >= candidates.value.length) return
    selectedIndex.value = index
  }

  return {
    candidates,
    candidateCounts,
    candidateLabels,
    selectedIndex,
    popupOpen,
    refresh,
    confirm,
    move,
    moveTo,
    close,
  }
}
