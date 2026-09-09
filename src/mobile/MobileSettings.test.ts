import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MobileSettings from './MobileSettings.vue'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import { version } from '../../package.json'
let root: HTMLDivElement
let dispose: () => void
let reload: ReturnType<typeof vi.fn>
const flush = async () => { for (let i = 0; i < 12; i++) await nextTick() }
async function click(label: string) {
  const button = [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  expect(button, label).toBeDefined()
  button!.click(); await flush()
}
function mount(install: () => Promise<unknown>) {
  const api = {
    status: vi.fn().mockResolvedValue({ version }),
    checkAppUpdate: vi.fn().mockResolvedValue({ phase: 'available', version: '99.0.0', blockingSessions: [] }),
    downloadAppUpdate: vi.fn().mockResolvedValue({ phase: 'ready', version: '99.0.0', blockingSessions: [] }),
    installAppUpdate: vi.fn(install),
  }
  root = document.createElement('div'); document.body.append(root)
  const app = createApp(MobileSettings, { api: api as unknown as MobileHostApi, connected: true, status: null, loading: false, errorMessage: '', baseUrl: 'http://host', token: '' })
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
