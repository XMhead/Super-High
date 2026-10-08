import { createApp, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MobileSettings from './MobileSettings.vue'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import { version } from '../../package.json'
const apkCheck = vi.fn()
vi.mock('@/lib/mobileApkUpdate', () => ({ useMobileApkUpdate: () => ({
  nativeAvailable: false, installedVersion: ref(''), state: ref('available'), latestVersion: ref('99.0.0'),
  progress: ref(-1), message: ref(''), downloadUrl: ref('https://github.com/XMhead/Super-High/releases/download/v99.0.0/SuperHigh-99.0.0-android.apk'),
  checkUpdate: apkCheck, installUpdate: vi.fn(),
}) }))
let root: HTMLDivElement
let dispose: () => void
let reload: ReturnType<typeof vi.fn>
const flush = async () => { for (let i = 0; i < 12; i++) await nextTick() }
async function click(label: string) {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  expect(button, label).toBeDefined()
  button!.click(); await flush()
}
function mount(install: () => Promise<unknown>, connected = true) {
  const api = {
    status: vi.fn().mockResolvedValue({ version }),
    checkAppUpdate: vi.fn().mockResolvedValue({ phase: 'available', version: '99.0.0', blockingSessions: [] }),
    downloadAppUpdate: vi.fn().mockResolvedValue({ phase: 'ready', version: '99.0.0', blockingSessions: [] }),
    installAppUpdate: vi.fn(install),
  }
  root = document.createElement('div'); document.body.append(root)
  const app = createApp(MobileSettings, { api: api as unknown as MobileHostApi, connected, status: null, loading: false, errorMessage: '', baseUrl: 'http://host', token: '' })
  app.mount(root); dispose = () => { app.unmount(); root.remove() }
  return api
}
async function prepare() {
  await click(`检查更新${version}`)
  await click('检查版本更新（含界面）')
  await click('下载更新')
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear(); reload = vi.fn()
  vi.stubGlobal('window', { location: { reload }, matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
})
afterEach(() => { dispose?.(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('mobile unified update installation', () => {
  it('allows Android updates without a computer and links directly to the APK', async () => {
    const api = mount(async () => ({}), false)
    await click(`检查更新${version}`)
    await click('检查手机应用更新')
    expect(apkCheck).toHaveBeenCalledOnce()
    const download = [...root.querySelectorAll('a')].find(a => a.textContent?.trim() === '下载手机安装包')
    expect(download?.href).toBe('https://github.com/XMhead/Super-High/releases/download/v99.0.0/SuperHigh-99.0.0-android.apk')
    expect(root.querySelector('a[href$="/releases/latest"]')).toBeNull()
    expect(api.checkAppUpdate).not.toHaveBeenCalled()
  })
  it('continues waiting when Windows exits before sending its install response', async () => {
    const api = mount(async () => { throw new Error('connection lost') })
    await prepare(); await click('安装并重启电脑端')
    expect(root.textContent).toContain('正在等待电脑更新')
    expect(root.textContent).not.toContain('connection lost')
    api.status.mockResolvedValue({ version: '99.0.0' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(reload).toHaveBeenCalledOnce()
    expect(api.installAppUpdate).toHaveBeenCalledOnce()
  })
  it('reports a definite server refusal without waiting or retrying installation', async () => {
    const api = mount(async () => { throw new MobileHostError('会话仍在运行', 500) })
    await prepare(); await click('安装并重启电脑端')
    expect(root.textContent).toContain('会话仍在运行')
    await vi.advanceTimersByTimeAsync(9000)
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(api.installAppUpdate).toHaveBeenCalledOnce()
  })
})
