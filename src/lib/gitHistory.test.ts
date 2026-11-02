import { describe, expect, it } from 'vitest'

import { changelogForGroup, commitVersionMarker, groupCommitsByVersion } from './gitHistory'
import type { GitCommit } from '@/types'

function commit(subject: string, refs = ''): GitCommit {
  return { hash: subject, shortHash: subject.slice(0, 7), author: 'A', email: 'a@example.com', timestamp: 0, subject, refs, parents: [] }
}

describe('gitHistory', () => {
  it.each([
    ['chore: release v0.1.39', '0.1.39'],
    ['Prepare v0.1.37 Alpha release', '0.1.37'],
    ['Simplify terminal support and provider settings for v0.1.19', '0.1.19'],
    ['修正图片查看器卸载引号并准备 v0.1.18', '0.1.18'],
    ['Restore mobile terminal focus after command actions and prepare v0.1.25', '0.1.25'],
    ['Fix parser crash', ''],
    ['Align Android version for v0.1.36', '0.1.36'],
  ])('reads the version marker from %j', (subject, version) => {
    expect(commitVersionMarker(commit(subject))).toBe(version)
  })

  it('prefers tags over subjects', () => {
    expect(commitVersionMarker(commit('Publish public snapshot', 'HEAD -> main, tag: v2.0.1, origin/main'))).toBe('2.0.1')
  })

  it('groups newest-first commits under the release that closes them and keeps the first marker per version', () => {
    const groups = groupCommitsByVersion([
      commit('feat: pending work'),
      commit('chore: release v0.1.39'),
      commit('fix: shipped in 39'),
      commit('Prepare v0.1.37 Alpha release'),
      commit('Align Android version for v0.1.37'),
      commit('feat: shipped in 37'),
    ])
    expect(groups.map((group) => [group.key, group.commits.length])).toEqual([['pending', 1], ['0.1.39', 2], ['0.1.37', 3]])
  })

  it('returns no groups for repositories without version markers', () => {
    expect(groupCommitsByVersion([commit('a'), commit('b')])).toEqual([])
  })

  it('maps pending work to changelog sections newer than the latest release', () => {
    const groups = groupCommitsByVersion([commit('wip'), commit('chore: release v0.1.39')])
    const entries = [
      { version: '0.1.40', date: '', notes: 'next' },
      { version: '0.1.39', date: '', notes: 'shipped' },
    ]
    expect(changelogForGroup(groups[0]!, groups, entries).map((entry) => entry.notes)).toEqual(['next'])
    expect(changelogForGroup(groups[1]!, groups, entries).map((entry) => entry.notes)).toEqual(['shipped'])
  })
})
