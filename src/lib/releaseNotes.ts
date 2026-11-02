import changelog from '../../CHANGELOG.md?raw'
import { version } from '../../package.json'

export interface ReleaseEntry { version: string, date: string, notes: string }

// 解析 `## [版本] - 日期` 段落；Git 视图读取仓库自身的 CHANGELOG 时复用。
export function parseChangelog(text: string): ReleaseEntry[] {
  return [...text.matchAll(/^## \[([^\]]+)\](?: - ([^\r\n]+))?\r?\n([\s\S]*?)(?=^## \[|(?![\s\S]))/gm)]
    .map(([, version, date, notes]) => ({ version: version!, date: date ?? '', notes: notes!.replace(/^\[[^\]]+\]:[^\r\n]*$/gm, '').trim() }))
}

export const releaseHistory = parseChangelog(changelog)

export const currentRelease = releaseHistory.find(release => release.version === version)
  ?? { version, date: '', notes: '' }
