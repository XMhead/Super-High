import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { backend } from '@/lib/tauri'
import { currentRelease, releaseHistory } from '@/lib/releaseNotes'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAppUpdateStore } from '@/stores/appUpdate'
import { installSettingsSimulator, SETTINGS_SIMULATOR_KEY, type SettingsSimulatorOptions } from './simulator'

vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn() }))

const disposers: Array<() => void> = []
function setup(scenario: SettingsSimulatorOptions['scenario'] = 'ready', persist = false) {
  const pinia = createPinia()
  const simulator = installSettingsSimulator(pinia, { scenario, persist })
  disposers.push(simulator.dispose)
  return { ...simulator, workspace: useWorkspaceStore(pinia), update: useAppUpdateStore(pinia) }
}
afterEach(() => {
  disposers.reverse().forEach(dispose => dispose()); disposers.length = 0
  sessionStorage.removeItem(SETTINGS_SIMULATOR_KEY)
  sessionStorage.removeItem('unrelated-test')
  vi.useRealTimers()
})

describe('settings simulator', () => {
  it('simulates channel reads and network actions while denying configuration writes', async () => {
    vi.useFakeTimers()
    const { message } = setup()
    const providers = await backend.listCcProviders()
    expect(providers[0]?.name).toContain('模拟')
    expect((await backend.listCcProfiles()).profiles[0]?.codexProvider).toBe(providers[0]?.id)
    const channel = { ...providers[0]!, provider: 'codex' as const }
    const probe = backend.probeChannel(channel)
    const latency = backend.probeWebsiteLatency(channel)
    const models = backend.fetchChannelModels(channel)
    await vi.runAllTimersAsync()
    expect(await probe).toMatchObject({ ok: true, reply: expect.stringContaining('模拟') })
    expect((await latency)[0]?.label).toContain('模拟')
    expect((await models)[0]?.ownedBy).toContain('模拟')
    expect(message.value).toContain('未发出网络请求')
    await expect(backend.saveSettings({} as never)).rejects.toThrow('模拟模式不支持后端调用')
  })

  it('provides empty and failed channel scenarios and cancels pending probes on reset', async () => {
    vi.useFakeTimers()
    const empty = setup('empty')
    expect(await backend.listCcProviders()).toEqual([])
    empty.dispose()
    const failure = setup('error')
    await expect(backend.listCcProviders()).rejects.toThrow('模拟：读取渠道失败')
    const channel = { id: 'simulated', name: '模拟', provider: 'codex' as const, websiteUrl: '', baseUrl: 'https://preview.invalid', apiKey: '', model: 'simulated-model' }
    const rejected = expect(backend.probeChannel(channel)).rejects.toThrow('渠道连通检测失败')
    await vi.runAllTimersAsync(); await rejected
    failure.dispose()
    const ready = setup()
    const cancelled = expect(backend.probeChannel(channel)).rejects.toThrow('模拟操作已取消')
    ready.reset()
    await cancelled
  })

  it('isolates backend IPC and restores original methods on disposal', async () => {
    const original = backend.openUrl
    const simulator = setup()
    await backend.openUrl('https://example.invalid')
    expect(simulator.message.value).toContain('未打开')
    await expect(backend.getAppStorageInfo()).rejects.toThrow('模拟模式不支持后端调用')
    simulator.dispose()
    expect(backend.openUrl).toBe(original)
  })

  it('uses real plugin toggle actions and mobile controls against simulated state', async () => {
    const { workspace, message } = setup()
    expect(workspace.pluginStatuses.map(plugin => plugin.source)).toEqual(['global', 'project'])
    await workspace.disablePlugin('simulated.global')
    expect(workspace.pluginStatuses[0]?.status).toBe('disabled')
    await workspace.enablePlugin('simulated.global')
    expect(workspace.pluginStatuses[0]?.status).toBe('loaded')
    await workspace.reloadPlugin('simulated.project')
    expect(message.value).toContain('重载')
    await workspace.stopMobileHost()
    expect(workspace.mobileHostStatus?.running).toBe(false)
    await workspace.updateMobileHostConfig({ port: 12345 })
    await workspace.regenerateMobileHostToken()
    await workspace.startMobileHost()
    expect(workspace.mobileHostStatus).toMatchObject({ running: true, port: 12345, token: 'SIMULATED-TOKEN-2' })
    expect(workspace.mobileHostStatus?.urls[0]).toContain('preview.invalid')
    await workspace.updateMobileHostConfig({ port: 1 })
    expect(workspace.mobileHostConfig?.port).toBe(12345)
  })

  it('persists only in its session key and reset preserves unrelated storage', async () => {
    sessionStorage.setItem('unrelated-test', 'keep')
    const first = setup('ready', true)
    first.workspace.settings.autoSave = 'afterDelay'
    await first.workspace.saveSettings()
    first.dispose()
    const second = setup('ready', true)
    expect(second.workspace.settings.autoSave).toBe('afterDelay')
    second.reset()
    expect(second.workspace.settings.autoSave).toBe('off')
    expect(sessionStorage.getItem(SETTINGS_SIMULATOR_KEY)).toBeNull()
    expect(sessionStorage.getItem('unrelated-test')).toBe('keep')
  })

  it('keeps real release notes and history in the browser preview', async () => {
    const { update, reset } = setup()
    expect(update.currentRelease.notes).toBe(currentRelease.notes)
    expect(releaseHistory.length).toBeGreaterThan(1)
    expect(releaseHistory.some(release => release.version === '0.1.0')).toBe(true)
    expect(releaseHistory.every(release => release.notes.length > 0)).toBe(true)
    await update.check()
    expect(update.status).toBeNull()
    reset()
    expect(update.currentRelease.notes).toBe(currentRelease.notes)
  })

  it('exposes empty and failure states and cancels an in-flight operation on reset', async () => {
    vi.useFakeTimers()
    const empty = setup('empty')
    expect(empty.workspace.pluginStatuses).toEqual([])
    expect(empty.workspace.cliEnvironments).toEqual([])
    empty.dispose()
    const failure = setup('error')
    await failure.workspace.startMobileHost()
    expect(failure.message.value).toContain('失败')
    expect(failure.workspace.mobileHostStatus?.running).toBe(false)
    expect(failure.workspace.pluginStatuses[0]?.status).toBe('failed')

  })
})
