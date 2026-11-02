import { createApp, h, nextTick, reactive, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import GitReplayView from './GitReplayView.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({
  githubRepoList: vi.fn(),
  githubAccountStatus: vi.fn(),
  gitReplayStatus: vi.fn(),
  gitReplayPrepare: vi.fn(),
  gitReplayStart: vi.fn(),
  closeTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  terminalCreated: vi.fn(),
  terminalDisposed: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: mocks,
  isTauri: () => false,
  onTerminalOutput: vi.fn(async () => () => {}),
  onTerminalExit: vi.fn(async () => () => {}),
}))
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn(), loadMonaco: vi.fn() }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {}
    cols = 80
    rows = 24
    constructor() { mocks.terminalCreated() }
    loadAddon() {}
    open() {}
    onData() {}
    reset() {}
    focus() {}
    dispose() { mocks.terminalDisposed() }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

let app: App | null = null

async function settle() {
  for (let index = 0; index < 15; index += 1) await Promise.resolve()
  await nextTick()
}

async function mountView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useWorkspaceStore().workspace = { id: 'w', name: 'Repo', displayName: 'Repo', rootPath: 'D:/Repo', openedAt: '' }
  const props = reactive({ active: true, workspaceIsRepo: true })
  const root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(GitReplayView, props) })
  app.use(pinia)
  app.mount(root)
  await settle()
  return { root, props }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  mocks.githubRepoList.mockResolvedValue([{ nameWithOwner: 'Dev/example', description: 'Example repo', isEmpty: false }])
  mocks.githubAccountStatus.mockResolvedValue({ authenticated: true, login: 'Dev' })
  mocks.gitReplayStatus.mockResolvedValue({ installed: true })
  mocks.gitReplayPrepare.mockResolvedValue({ repoPath: 'D:/Repo' })
  mocks.gitReplayStart.mockResolvedValue({ id: 'replay-1' })
  mocks.closeTerminal.mockResolvedValue(undefined)
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('GitReplayView caching', () => {
  it('reuses the list, filter and terminal on reentry and stops the hidden replay', async () => {
    const { root, props } = await mountView()
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'example'
    search.dispatchEvent(new Event('input'))
    root.querySelector<HTMLButtonElement>('.replay-row')!.click()
    await settle()
    expect(mocks.gitReplayStart).toHaveBeenCalledTimes(1)
    props.active = false
    await settle()
    expect(mocks.closeTerminal).toHaveBeenCalledWith('replay-1', true)
    props.active = true
    await settle()
    expect(search.value).toBe('example')
    expect(mocks.githubRepoList).toHaveBeenCalledTimes(1)
    expect(mocks.githubAccountStatus).toHaveBeenCalledTimes(1)
    expect(mocks.terminalCreated).toHaveBeenCalledTimes(1)
    expect(mocks.terminalDisposed).not.toHaveBeenCalled()
  })

  it('refreshes expired data in the background, deduplicates refreshes and retains the list on failure', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { root, props } = await mountView()
    props.active = false
    await settle()
    clock.mockReturnValue(1_300_001)
    let rejectRefresh!: (error: Error) => void
    mocks.githubRepoList.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRefresh = reject }))
    props.active = true
    await settle()
    root.querySelector<HTMLButtonElement>('.replay-icon-button')!.click()
    await settle()
    expect(mocks.githubRepoList).toHaveBeenCalledTimes(2)
    expect(root.textContent).toContain('Example repo')
    rejectRefresh(new Error('offline'))
    await settle()
    expect(root.textContent).toContain('offline')
    expect(root.textContent).toContain('Example repo')
  })
})
