import type { ReleaseEntry } from '@/lib/releaseNotes'
import type { GitCommit } from '@/types'

export interface GitVersionGroup {
  /** 稳定键：版本号或 `pending`。 */
  key: string
  /** 版本号（不带 v）；待发布分组为空。 */
  version: string
  commits: GitCommit[]
}

const TAG_VERSION = /(?:^|,\s*)tag:\s*v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/
// 版本发布类提交：`chore: release v1.2.3`、`Prepare v1.2.3 Alpha release`、`...并准备 v1.2.3`、`... for v1.2.3`。
const RELEASE_SUBJECT = /(?:\b(?:release|prepare|publish|bump)\b|准备|发布|发版|\bfor\b)[^\n]*?\bv(\d+\.\d+\.\d+)\b|^\s*v?(\d+\.\d+\.\d+)\s*$/i

/** 从标签或发布类提交标题识别该提交标记的版本；没有版本标记时返回空字符串。 */
export function commitVersionMarker(commit: Pick<GitCommit, 'subject' | 'refs'>) {
  const tag = commit.refs.match(TAG_VERSION)
  if (tag) return tag[1]!
  const subject = commit.subject.match(RELEASE_SUBJECT)
  return subject?.[1] ?? subject?.[2] ?? ''
}

/**
 * 按版本标记把从新到旧的提交切成分组：每个版本标记提交及其之前（更旧）的提交属于该版本，
 * 最新标记之后的提交归入“待发布”。同一版本号只取最新的一次标记，避免“对齐版本”类提交拆出重复分组。
 * 没有任何版本标记时返回空数组，调用方按平铺列表显示。
 */
export function groupCommitsByVersion(commits: GitCommit[]): GitVersionGroup[] {
  const seen = new Set<string>()
  const groups: GitVersionGroup[] = []
  let current: GitVersionGroup = { key: 'pending', version: '', commits: [] }
  for (const commit of commits) {
    const version = commitVersionMarker(commit)
    if (version && !seen.has(version)) {
      seen.add(version)
      if (current.commits.length) groups.push(current)
      current = { key: version, version, commits: [] }
    }
    current.commits.push(commit)
  }
  if (!seen.size) return []
  if (current.commits.length) groups.push(current)
  return groups
}

export function compareVersions(left: string, right: string) {
  const a = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff) return diff
  }
  return 0
}

/**
 * 为分组匹配更新日志：已发布分组取同版本段落；待发布分组取比最新已发布版本更新的段落
 * （如 CHANGELOG 已写好的下一版本），没有已发布分组时取首段。
 */
export function changelogForGroup(group: GitVersionGroup, groups: GitVersionGroup[], entries: ReleaseEntry[]) {
  if (group.version) return entries.filter((entry) => entry.version === group.version)
  const newest = groups.find((item) => item.version)?.version
  if (!newest) return entries.slice(0, 1)
  return entries.filter((entry) => /^\d/.test(entry.version) && compareVersions(entry.version, newest) > 0)
}
