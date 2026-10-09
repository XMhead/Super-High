import { createApp, defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileApkUpdate } from './mobileApkUpdate'

const mountedApps: ReturnType<typeof createApp>[] = []
const assetUrl = 'https://github.com/XMhead/Super-High/releases/download/v0.1.15/SuperHigh-0.1.15.apk'

function mountUpdater() {
  let api!: ReturnType<typeof useMobileApkUpdate>
  const app = createApp(defineComponent({ setup() { api = useMobileApkUpdate(); return () => h('div') } }))
  app.mount(document.createElement('div'))
  mountedApps.push(app)
  return api
}

function nativeBridge(initial = { state: 'idle', installedVersion: '0.1.14' }) {
  const bridge = { getStatus: vi.fn(() => JSON.stringify(initial)), check: vi.fn(), install: vi.fn() }
  Object.assign(window, { SuperHighApkUpdate: bridge })
  return bridge
}

function result(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('superhigh:apk-update', { detail }))
}

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
  delete (window as Window & { SuperHighApkUpdate?: unknown }).SuperHighApkUpdate
  vi.unstubAllGlobals()
})

describe('mobile APK updater', () => {
  it('uses the installed APK version and accepts the native current result', async () => {
    const bridge = nativeBridge()
    const api = mountUpdater()
    expect(api.installedVersion.value).toBe('0.1.14')
    await api.checkUpdate()
    expect(bridge.check).toHaveBeenCalledOnce()
    result({ state: 'current', latestVersion: '0.1.14' })
    expect(api.state.value).toBe('current')
    expect(api.latestVersion.value).toBe('0.1.14')
    await api.checkUpdate()
    expect(api.latestVersion.value).toBe('')
  })

  it('can retry checks after failure and after cancelling the system installer', async () => {
    const bridge = nativeBridge()
    const api = mountUpdater()
    await api.checkUpdate()
    result({ state: 'error', message: '网络错误' })
    await api.checkUpdate()
    expect(bridge.check).toHaveBeenCalledTimes(2)
    result({ state: 'installing', progress: 100 })
    api.installUpdate()
    expect(bridge.install).toHaveBeenCalledOnce()
    await api.checkUpdate()
    expect(bridge.check).toHaveBeenCalledTimes(3)
  })

  it('restores native download progress when returning to settings', () => {
    nativeBridge({ state: 'downloading', installedVersion: '0.1.14' })
    const api = mountUpdater()
    result({ state: 'downloading', progress: 42 })
    expect(api.state.value).toBe('downloading')
    expect(api.progress.value).toBe(42)
  })

  it('retries installation after unknown-source permission was denied', () => {
    const bridge = nativeBridge()
    const api = mountUpdater()
    result({ state: 'permission', progress: 100 })
    api.installUpdate()
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('offers a real APK asset link in browsers without claiming an installed version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.1.15', assets: [{ name: 'SuperHigh-0.1.15.apk', browser_download_url: assetUrl }] }) }))
    const api = mountUpdater()
    await api.checkUpdate()
    expect(api.nativeAvailable).toBe(false)
    expect(api.installedVersion.value).toBe('')
    expect(api.state.value).toBe('available')
    expect(api.downloadUrl.value).toBe(assetUrl)
  })

  it('rejects missing APKs and retries a failed browser request', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tag_name: 'v0.1.15', assets: [] }) })
    vi.stubGlobal('fetch', fetch)
    const api = mountUpdater()
    await api.checkUpdate()
    expect(api.state.value).toBe('error')
    await api.checkUpdate()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(api.state.value).toBe('error')
    expect(api.downloadUrl.value).toBe('')
  })

  it('does not accept APK links outside the fixed release repository', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.1.15', assets: [{ name: 'app.apk', browser_download_url: 'https://example.com/app.apk' }] }) }))
    const api = mountUpdater()
    await api.checkUpdate()
    expect(api.state.value).toBe('error')
    expect(api.downloadUrl.value).toBe('')
  })
})
