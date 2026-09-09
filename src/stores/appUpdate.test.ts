import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AppUpdateStatus } from '@/lib/tauri'

const mocks = vi.hoisted(() => ({
  check: vi.fn(), download: vi.fn(), install: vi.fn(), status: vi.fn(),
  workspace: { hasDirtyTextTabs: false, persistOpenTerminalStates: vi.fn() },
}))
vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  backend: { checkAppUpdate: mocks.check, downloadAppUpdate: mocks.download, installAppUpdate: mocks.install, getAppUpdateStatus: mocks.status },
}))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => mocks.workspace }))
import { useAppUpdateStore } from './appUpdate'

const status = (phase: AppUpdateStatus['phase']): AppUpdateStatus => ({
  phase, currentVersion: '0.1.1', version: '0.1.2', notes: null,
  downloadedBytes: 0, totalBytes: null, error: null, blockingSessions: [],
})

describe('application update flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    mocks.workspace.hasDirtyTextTabs = false
    mocks.workspace.persistOpenTerminalStates.mockResolvedValue(undefined)
    mocks.check.mockResolvedValue(status('available'))
    mocks.download.mockResolvedValue(status('ready'))
    mocks.install.mockResolvedValue(status('installing'))
  })
  afterEach(() => vi.useRealTimers())

  it('automatically downloads a discovered release without starting installation', async () => {
    const update = useAppUpdateStore()
    await update.check(true)
    expect(update.status?.phase).toBe('ready')
    expect(mocks.download).toHaveBeenCalledOnce()
    expect(mocks.install).not.toHaveBeenCalled()
  })
  it('respects disabled background downloads while permitting a manual check', async () => {
    localStorage.setItem('superhigh.autoUpdate', 'false')
    const update = useAppUpdateStore()
    await update.check(true)
    expect(update.status?.phase).toBe('available')
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it('does not discard a downloaded update during periodic checks', async () => {
    const update = useAppUpdateStore()
    update.status = status('ready')
    await update.check(true)
    expect(mocks.check).not.toHaveBeenCalled()
  })
  it('blocks installation when files are unsaved', async () => {
    const update = useAppUpdateStore()
    update.status = status('ready')
    mocks.workspace.hasDirtyTextTabs = true
    await update.install()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(update.message).toContain('未保存')
  })
  it('keeps the downloaded update and shows backend session protection failures', async () => {
    const update = useAppUpdateStore()
    update.status = status('ready')
    mocks.install.mockResolvedValue({ ...status('ready'), error: '会话仍在运行', blockingSessions: [{ id: '1', title: 'Codex' }] })
    await update.install()
    expect(update.status?.phase).toBe('ready')
    expect(update.status?.blockingSessions[0].title).toBe('Codex')
    expect(update.installing).toBe(false)
  })
  it('does not install if saving terminal state fails', async () => {
    const update = useAppUpdateStore()
    update.status = status('ready')
    mocks.workspace.persistOpenTerminalStates.mockRejectedValue(new Error('persistence failed'))
    await update.install()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(update.message).toContain('persistence failed')
  })
  it('rechecks unsaved edits made while terminal state was being saved', async () => {
    const update = useAppUpdateStore()
    update.status = status('ready')
    mocks.workspace.persistOpenTerminalStates.mockImplementationOnce(async () => { mocks.workspace.hasDirtyTextTabs = true })
    await update.install()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(update.message).toContain('未保存')
  })
  it('ignores late progress responses after the download has completed', async () => {
    vi.useFakeTimers()
    const update = useAppUpdateStore()
    let finishDownload!: (value: AppUpdateStatus) => void
    let finishPoll!: (value: AppUpdateStatus) => void
    mocks.download.mockImplementation(() => new Promise(resolve => { finishDownload = resolve }))
    mocks.status.mockImplementation(() => new Promise(resolve => { finishPoll = resolve }))
    const pending = update.download()
    await vi.advanceTimersByTimeAsync(700)
    finishDownload(status('ready'))
    await pending
    finishPoll(status('downloading'))
    await Promise.resolve()
    expect(update.status?.phase).toBe('ready')
  })
})
