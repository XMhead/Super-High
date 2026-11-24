import { createApp, h, KeepAlive, nextTick, ref, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceStore } from '@/stores/workspace'
import type { GitCommit } from '@/types'
import GitPanel from './GitPanel.vue'

const mocks = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  gitCommitDetail: vi.fn(),
  gitWorkingDiff: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: mocks,
  isTauri: () => false,
  onProjectServiceStatus: vi.fn(),
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn(), loadMonaco: vi.fn() }))
vi.mock('./GitDiffViewer.vue', () => ({ default: { props: ['path', 'oldText', 'newText'], template: '<div class="diff-stub">{{ path }}</div>' } }))
vi.mock('./GitReplayView.vue', () => ({ default: { props: ['active', 'workspaceIsRepo'], template: '<div class="replay-stub" />' } }))

let app: App<Element> | null = null

function commit(hash: string, subject: string): GitCommit {
  return { hash, shortHash: hash.slice(0, 7), author: 'Dev', email: 'dev@example.com', timestamp: 1_760_000_000, subject, refs: '', parents: ['p'] }
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await nextTick()
}

async function mountPanel(visible = ref(true)) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.workspace = { id: 'w', name: 'Repo', displayName: 'Repo', rootPath: 'D:/Repo', openedAt: '2026-10-01T00:00:00.000Z' }
  mocks.gitStatus.mockResolvedValue({
    repoRoot: 'D:/Repo', branch: 'private', upstream: null, ahead: 0, behind: 0,
    files: [
      { path: 'src/components/GitPanel.vue', oldPath: null, status: 'M', indexStatus: '.', worktreeStatus: 'M', untracked: false, additions: 12, deletions: 3 },
      { path: 'CHANGELOG.md', oldPath: null, status: 'M', indexStatus: '.', worktreeStatus: 'M', untracked: false, additions: 2, deletions: 0 },
    ],
  })
  mocks.gitWorkingDiff.mockImplementation(async (_root: string, path: string) => ({ path, oldText: 'a', newText: 'b', binary: false, truncated: false, tooLarge: false }))
  mocks.gitLog.mockResolvedValue([
    commit('c3', 'feat: pending work'),
    commit('c2', 'chore: release v0.1.39'),
    commit('c1', 'fix: shipped bug'),
  ])
  mocks.readFile.mockResolvedValue('# 更新日志\n\n## [0.1.40] - 2026-10-16\n\n- 下一版内容\n\n## [0.1.39] - 2026-10-10\n\n- 已发布内容\n')
  mocks.gitCommitDetail.mockImplementation(async (_root: string, hash: string) => ({
    commit: commit(hash, hash === 'c1' ? 'fix: shipped bug' : 'x'),
    body: 'details\n\nCo-Authored-By: Bot <bot@example.com>',
    files: [{ path: 'src/a.ts', oldPath: null, status: 'M', additions: 4, deletions: 1 }],
  }))
  mocks.gitCommitFileDiff.mockImplementation(async (_root: string, _hash: string, path: string) => ({ path, oldText: '1', newText: '2', binary: false, truncated: false, tooLarge: false }))
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(KeepAlive, () => visible.value ? h(GitPanel) : null) })
  app.use(pinia)
  app.mount(root)
  await settle()
  return root
}

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('GitPanel', () => {
  it('retains the replay view, diff editor and cached history across tab and surface switches', async () => {
    const visible = ref(true)
    const root = await mountPanel(visible)
    const diff = root.querySelector('.diff-stub')
    root.querySelectorAll<HTMLButtonElement>('.git-tab')[1]!.click()
    await settle()
    root.querySelectorAll<HTMLButtonElement>('.git-tab')[2]!.click()
    await settle()
    const replay = root.querySelector('.replay-stub')
    expect(root.querySelector('.diff-stub')).toBe(diff)
    root.querySelectorAll<HTMLButtonElement>('.git-tab')[0]!.click()
    await settle()
    root.querySelectorAll<HTMLButtonElement>('.git-tab')[2]!.click()
    await settle()
    expect(root.querySelector('.replay-stub')).toBe(replay)
    visible.value = false
    await settle()
    visible.value = true
    await settle()
    expect(root.querySelector('.replay-stub')).toBe(replay)
    expect(mocks.gitStatus).toHaveBeenCalledTimes(1)
    expect(mocks.gitLog).toHaveBeenCalledTimes(1)
    expect(mocks.gitWorkingDiff).toHaveBeenCalledTimes(1)
  })

  it('lists changes as single-line rows with line stats and opens the first diff without a duplicate path header', async () => {
    const root = await mountPanel()
    const rows = root.querySelectorAll('.git-file-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('GitPanel.vue')
    expect(rows[0]!.textContent).toContain('src/components')
    expect(rows[0]!.textContent).toContain('+12')
    expect(rows[1]!.querySelector('.git-file-dir')!.textContent).toBe('')
    expect(root.querySelector('.git-totals')!.textContent).toContain('+14')
    expect(root.querySelector('.git-detail-header')).toBeNull()
    expect(root.querySelector('.diff-stub')!.textContent).toBe('src/components/GitPanel.vue')
    expect(mocks.gitWorkingDiff).toHaveBeenCalledTimes(1)
  })

  it('groups history by version, shows the changelog for the pending version and opens a commit in three columns', async () => {
    const root = await mountPanel()
    root.querySelectorAll<HTMLButtonElement>('.git-tab')[1]!.click()
    await settle()
    const groups = [...root.querySelectorAll('.git-group-name')].map((node) => node.textContent)
    expect(groups).toEqual(['v0.1.40 待发布', 'v0.1.39'])
    expect(root.querySelector('.git-version-notes')!.textContent).toContain('下一版内容')
    expect(root.querySelector('.git-version-notes')!.textContent).not.toContain('已发布内容')
    expect(root.querySelector('.git-body--version')).not.toBeNull()

    root.querySelectorAll<HTMLButtonElement>('.git-group-main')[1]!.click()
    await settle()
    expect(root.querySelector('.git-version-notes')!.textContent).toContain('已发布内容')
    const subjects = [...root.querySelectorAll('.git-commit-subject')].map((node) => node.textContent)
    expect(subjects).toEqual(['feat: pending work', 'chore: release v0.1.39', 'fix: shipped bug'])

    root.querySelectorAll<HTMLButtonElement>('.git-commit-row')[2]!.click()
    await settle()
    expect(root.querySelector('.git-body--commit')).not.toBeNull()
    expect(root.querySelector('.git-commit-title')!.textContent).toBe('fix: shipped bug')
    expect(root.querySelector('.git-commit-body')!.textContent).toBe('details')
    expect(root.querySelector('.git-files-header')!.textContent).toContain('1 个文件')
    expect(mocks.gitCommitFileDiff).toHaveBeenCalledWith('D:/Repo', 'c1', 'src/a.ts', null)
    expect(root.querySelector('.diff-stub')!.textContent).toBe('src/a.ts')
  })
})
