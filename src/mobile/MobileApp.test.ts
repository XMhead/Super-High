import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileHostApi } from '@/lib/hostApi'
import MobileApp from './MobileApp.vue'

const native = vi.hoisted(() => ({ enabled: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.enabled } }))
vi.mock('./MobileSessions.vue', () => ({ default: { template: '<div />' } }))

const key = 'super-high-mobile-connection'
let dispose: (() => void) | undefined
const flush = async () => { for (let i = 0; i < 12; i++) await nextTick() }

function mount(path = '/mobile/', hash = '') {
  const location = { pathname: path, hash, search: '', origin: 'http://host.test:10320', assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }
  const history = { replaceState: vi.fn() }
  vi.stubGlobal('window', { location, history })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(MobileApp)
  app.mount(root)
  dispose = () => { app.unmount(); root.remove() }
  return { root, location, history }
}

beforeEach(() => {
  native.enabled = false
  localStorage.clear()
  vi.spyOn(MobileHostApi.prototype, 'status').mockResolvedValue({ recentProjectCount: 0 } as never)
  vi.spyOn(MobileHostApi.prototype, 'listRecentProjects').mockResolvedValue([])
  vi.spyOn(MobileHostApi.prototype, 'checkMobilePage').mockResolvedValue()
})
afterEach(() => { dispose?.(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Host-delivered mobile interface', () => {
  it('consumes the token fragment, clears history, and connects without redirecting again', async () => {
    native.enabled = true
    const { root, location, history } = mount('/mobile/', '#token=handoff-token')
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/mobile/')
    await flush()
    expect(root.textContent).toContain('已连接')
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ baseUrl: location.origin, token: 'handoff-token' })
    expect(location.assign).not.toHaveBeenCalled()
  })

  it('reconnects after a page refresh and offers a fresh interface load', async () => {
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://old-host', token: 'saved-token' }))
    const { root, location } = mount()
    await flush()
    expect(root.textContent).toContain('已连接')
    expect(JSON.parse(localStorage.getItem(key)!).baseUrl).toBe(location.origin)
    root.querySelector<HTMLButtonElement>('[title="从电脑加载最新界面"]')!.click()
    expect(location.reload).toHaveBeenCalledOnce()
    root.querySelector<HTMLButtonElement>('[aria-label="断开"]')!.click()
    await flush()
    expect(localStorage.getItem(key)).toBeNull()
    expect(root.querySelector('input[type="url"]')).not.toBeNull()
  })

  it('keeps the native connection screen until requested, then loads Host UI with a fragment', async () => {
    native.enabled = true
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://host.test:10320', token: 'saved-token' }))
    const { root, location } = mount('/')
    expect(MobileHostApi.prototype.status).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('.mobile-primary-button')!.click()
    await flush()
    expect(location.assign).toHaveBeenCalledWith('http://host.test:10320/mobile/#token=saved-token')
    expect(MobileHostApi.prototype.listRecentProjects).not.toHaveBeenCalled()
  })

  it('stays on the connection screen when an older Host has no mobile page', async () => {
    native.enabled = true
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://host.test:10320', token: 'saved-token' }))
    vi.mocked(MobileHostApi.prototype.checkMobilePage).mockRejectedValue(new Error('电脑 Host 未提供手机界面，请先更新电脑端 Super High。'))
    const { root, location } = mount('/')
    root.querySelector<HTMLButtonElement>('.mobile-primary-button')!.click()
    await flush()
    expect(location.assign).not.toHaveBeenCalled()
    expect(root.textContent).toContain('请先更新电脑端 Super High')
  })

  it('returns to the native connection screen on disconnect', async () => {
    native.enabled = true
    const { root, location } = mount('/mobile/', '#token=handoff-token')
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="断开"]')!.click()
    expect(location.replace).toHaveBeenCalledWith('http://localhost/')
    expect(localStorage.getItem(key)).toBeNull()
  })
})
