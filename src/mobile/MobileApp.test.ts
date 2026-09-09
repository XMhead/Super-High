import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileHostApi } from '@/lib/hostApi'
import MobileApp from './MobileApp.vue'

const native = vi.hoisted(() => ({ enabled: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.enabled } }))
vi.mock('./MobileSessions.vue', () => ({ default: { props: ['root', 'connected'], template: '<div class="test-terminal" :data-root="root" />' } }))
const key = 'super-high-mobile-connection'
let dispose: (() => void) | undefined
const flush = async () => { for (let i = 0; i < 16; i++) await nextTick() }
function mount(path = '/mobile/', hash = '') {
  const location = { pathname: path, hash, search: '', origin: 'http://host.test:10320', assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }
  const history = { replaceState: vi.fn() }
  vi.stubGlobal('window', { location, history, innerHeight: 844, matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(MobileApp)
  app.mount(root)
  dispose = () => { app.unmount(); root.remove() }
  return { root, location, history }
}
function clickText(root: HTMLElement, text: string) {
  const button = Array.from(root.querySelectorAll('button')).find(button => button.textContent?.trim() === text)
  expect(button, text).toBeDefined()
  button!.click()
}
beforeEach(() => {
  native.enabled = false
  localStorage.clear(); sessionStorage.clear()
  vi.spyOn(MobileHostApi.prototype, 'status').mockResolvedValue({ recentProjectCount: 0 } as never)
  vi.spyOn(MobileHostApi.prototype, 'listRecentProjects').mockResolvedValue([])
  vi.spyOn(MobileHostApi.prototype, 'checkMobilePage').mockResolvedValue()
})
afterEach(() => { dispose?.(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('Host-delivered mobile workspace', () => {
  it('opens the terminal home without forcing a connection form', async () => {
    const { root } = mount('/')
    await flush()
    expect(root.querySelector('.test-terminal')).not.toBeNull()
    expect((root.querySelector('.mobile-settings') as HTMLElement).style.display).toBe('none')
    expect(root.querySelector('input[type="url"]')).toBeNull()
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click()
    await flush(); clickText(root, '账号管理'); await flush()
    expect(root.querySelector('input[type="url"]')).not.toBeNull()
  })
  it('consumes the token fragment and connects without redirecting again', async () => {
    native.enabled = true
    const { root, location, history } = mount('/mobile/', '#token=handoff-token')
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/mobile/')
    await flush()
    expect(root.textContent).toContain('已连接')
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ baseUrl: location.origin, token: 'handoff-token' })
    expect(location.assign).not.toHaveBeenCalled()
  })
  it('selects the desktop active workspace and exposes its real files in the drawer', async () => {
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ activeProjectPath: 'D:/current' } as never)
    vi.mocked(MobileHostApi.prototype.listRecentProjects).mockResolvedValue([{ path: 'D:/old', name: 'Old', lastOpenedAt: '' }, { path: 'D:/current', name: 'Current', lastOpenedAt: '' }])
    vi.spyOn(MobileHostApi.prototype, 'listDirectory').mockResolvedValue({ path: 'D:/current', entries: [{ name: 'README.md', path: 'D:/current/README.md', type: 'file', extension: '.md' }] } as never)
    const { root } = mount('/mobile/', '#token=handoff-token')
    await flush()
    expect(root.querySelector('.test-terminal')?.getAttribute('data-root')).toBe('D:/current')
    root.querySelector<HTMLButtonElement>('[aria-label="打开工作区资源管理器"]')!.click(); await flush()
    expect(root.querySelector('.mobile-drawer')?.textContent).toContain('README.md')
  })
  it('reconnects a saved native connection and loads Host UI with a fragment', async () => {
    native.enabled = true
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://host.test:10320', token: 'saved-token' }))
    const { location } = mount('/')
    await flush()
    expect(location.assign).toHaveBeenCalledWith('http://host.test:10320/mobile/#token=saved-token')
    expect(MobileHostApi.prototype.listRecentProjects).not.toHaveBeenCalled()
  })
  it('keeps the terminal home and reports an older Host with no mobile page', async () => {
    native.enabled = true
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://host.test:10320', token: 'saved-token' }))
    vi.mocked(MobileHostApi.prototype.checkMobilePage).mockRejectedValue(new Error('电脑 Host 未提供手机界面，请先更新电脑端 Super High。'))
    const { root, location } = mount('/')
    await flush()
    expect(location.assign).not.toHaveBeenCalled()
    expect(root.textContent).toContain('请先更新电脑端 Super High')
    expect(root.querySelector('.test-terminal')).not.toBeNull()
  })
  it('disconnects through settings and returns to native home', async () => {
    native.enabled = true
    const { root, location } = mount('/mobile/', '#token=handoff-token')
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '退出登录')
    expect(location.replace).toHaveBeenCalledWith('http://localhost/')
    expect(localStorage.getItem(key)).toBeNull()
  })
})
