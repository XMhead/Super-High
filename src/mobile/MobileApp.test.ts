import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEMES } from '@/lib/theme'
import { MobileHostApi, MobileHostError } from '@/lib/hostApi'
import MobileApp from './MobileApp.vue'

const native = vi.hoisted(() => ({ enabled: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.enabled } }))
vi.mock('./MobileSessions.vue', () => ({ default: { props: ['root', 'connected', 'api'], template: '<div class="test-terminal" :data-root="root"><button class="probe-active-host" @click="api.status()">Probe</button></div>' } }))
const key = 'super-high-mobile-connection'
let dispose: (() => void) | undefined
const flush = async () => { for (let i = 0; i < 16; i++) await nextTick() }
function mount(path = '/mobile/', hash = '', voiceBridge = false) {
  const location = { pathname: path, hash, search: '', origin: 'http://host.test:10320', assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }
  const history = { replaceState: vi.fn() }
  vi.stubGlobal('window', { location, history, innerHeight: 844, SuperHighVoice: voiceBridge ? {} : undefined, matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(MobileApp)
  app.mount(root)
  dispose = () => { app.unmount(); root.remove() }
  return { root, location, history, unmount: dispose }
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
afterEach(() => { dispose?.(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('Host-delivered mobile workspace', () => {
  it('toggles the uppercase Markdown badge and remembers source mode for the next file', async () => {
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ activeProjectPath: 'D:/docs' } as never)
    vi.spyOn(MobileHostApi.prototype, 'listDirectory').mockResolvedValue({ path: 'D:/docs', entries: [{ path: 'D:/docs/README.md', name: 'README.md', type: 'file', extension: '.md' }] } as never)
    vi.spyOn(MobileHostApi.prototype, 'readTextFile').mockResolvedValue('# Heading')
    const { root } = mount('/mobile/', '#token=saved-token'); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="打开工作区资源管理器"]')!.click(); await flush()
    expect(root.querySelector('.mobile-file-row .tree-kind-icon.document')).not.toBeNull()
    root.querySelector<HTMLButtonElement>('.mobile-file-row')!.click(); await flush()
    const badge = root.querySelector<HTMLButtonElement>('.mobile-file-type')!
    expect(badge.textContent).toBe('MARKDOWN')
    expect(root.querySelector('.mobile-markdown-rendered h1')?.textContent).toBe('Heading')
    badge.click(); await flush()
    expect(root.querySelector('.mobile-markdown-rendered')).toBeNull()
    expect(root.querySelector('.mobile-viewer pre')?.textContent).toBe('# Heading')
    expect(badge.getAttribute('aria-pressed')).toBe('false')
    root.querySelector<HTMLButtonElement>('[aria-label="关闭文件"]')!.click(); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="打开工作区资源管理器"]')!.click(); await flush()
    root.querySelector<HTMLButtonElement>('.mobile-file-row')!.click(); await flush()
    expect(root.querySelector('.mobile-markdown-rendered')).toBeNull()
    root.querySelector<HTMLButtonElement>('.mobile-file-type')!.click(); await flush()
    expect(root.querySelector('.mobile-markdown-rendered h1')).not.toBeNull()
  })
  it('follows desktop workspace changes and refreshes visible resources', async () => {
    vi.useFakeTimers()
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ activeProjectPath: 'D:/first' } as never)
    const dirs = vi.spyOn(MobileHostApi.prototype, 'listDirectory').mockImplementation(async path => ({ path, entries: [{ name: 'README.md', path: `${path}/README.md`, type: 'file', extension: '.md' }] }) as never)
    const { root } = mount('/mobile/', '#token=saved-token'); await flush()
    expect(root.querySelector('.test-terminal')?.getAttribute('data-root')).toBe('D:/first')
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ activeProjectPath: 'D:/second' } as never)
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root.querySelector('.test-terminal')?.getAttribute('data-root')).toBe('D:/second')
    root.querySelector<HTMLButtonElement>('[aria-label="打开工作区资源管理器"]')!.click(); await flush()
    dirs.mockResolvedValue({ path: 'D:/second', entries: [{ name: 'new.txt', path: 'D:/second/new.txt', type: 'file' }] } as never)
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root.querySelector('.mobile-drawer')?.textContent).toContain('new.txt')
    expect(root.querySelector('.mobile-drawer')?.textContent).not.toContain('README.md')
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ activeProjectPath: null } as never)
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root.querySelector('.test-terminal')?.getAttribute('data-root')).toBe('')
    expect(root.querySelector('.mobile-path')).toBeNull()
  })

  it('ignores a directory refresh that finishes after disconnect', async () => {
    vi.useFakeTimers()
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ activeProjectPath: 'D:/first' } as never)
    const dirs = vi.spyOn(MobileHostApi.prototype, 'listDirectory').mockResolvedValue({ path: 'D:/first', entries: [] } as never)
    const { root } = mount('/mobile/', '#token=saved-token'); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="打开工作区资源管理器"]')!.click(); await flush()
    let resolve!: (value: never) => void
    dirs.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await vi.advanceTimersByTimeAsync(3000); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="关闭资源管理器"]')!.click(); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '退出登录'); await flush()
    resolve({ path: 'D:/first', entries: [{ name: 'stale.txt' }] } as never); await flush()
    expect(root.textContent).toContain('未连接电脑')
    expect(root.textContent).not.toContain('stale.txt')
  })

  it('retries saved connections until the restarted desktop becomes available', async () => {
    vi.useFakeTimers()
    native.enabled = true
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://host.test:10320', token: 'saved-token' }))
    vi.mocked(MobileHostApi.prototype.status).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    const { root, location } = mount('/'); await flush()
    expect(root.textContent).toContain('正在重连')
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(location.assign).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(location.assign).toHaveBeenCalledWith('http://host.test:10320/mobile/#token=saved-token')
  })

  it('recovers after a temporary outage without replacing the current terminal view', async () => {
    vi.useFakeTimers()
    const { root } = mount('/mobile/', '#token=saved-token'); await flush()
    const terminal = root.querySelector('.test-terminal')
    vi.mocked(MobileHostApi.prototype.status).mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root.textContent).toContain('正在重连')
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root.textContent).toContain('已连接工作区')
    expect(root.querySelector('.test-terminal')).toBe(terminal)
  })

  it('cancels pending retries when the user logs out', async () => {
    vi.useFakeTimers()
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://host.test:10320', token: 'saved-token' }))
    vi.mocked(MobileHostApi.prototype.status).mockRejectedValue(new Error('offline'))
    const { root } = mount('/'); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '数据管理'); await flush()
    clickText(root, '清除已保存连接并退出'); await flush()
    vi.mocked(MobileHostApi.prototype.status).mockClear()
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(MobileHostApi.prototype.status).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBeNull()
    expect(root.textContent).not.toContain('正在重连')
  })

  it('stops retrying rejected credentials and after unmount', async () => {
    vi.useFakeTimers()
    vi.mocked(MobileHostApi.prototype.status).mockRejectedValue(new MobileHostError('unauthorized', 401))
    mount('/mobile/', '#token=saved-token'); await flush()
    await vi.advanceTimersByTimeAsync(15000)
    expect(MobileHostApi.prototype.status).toHaveBeenCalledTimes(1)
    dispose?.(); dispose = undefined
    vi.mocked(MobileHostApi.prototype.status).mockRejectedValue(new Error('offline')).mockClear()
    const { unmount } = mount('/mobile/', '#token=saved-token'); await flush()
    unmount(); dispose = undefined
    await vi.advanceTimersByTimeAsync(15000)
    expect(MobileHostApi.prototype.status).toHaveBeenCalledTimes(1)
  })

  it('ignores older preference polls and late responses after disconnect', async () => {
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ themeId: 'dark', hiddenCliProviderIds: ['codex'] } as never)
    const { root } = mount('/mobile/', '#token=handoff-token'); await flush()
    let resolveOld!: (value: never) => void
    vi.mocked(MobileHostApi.prototype.status).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValueOnce({ themeId: 'shen-dian', hiddenCliProviderIds: [] } as never)
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    resolveOld({ themeId: 'light', hiddenCliProviderIds: ['codex'] } as never); await flush()
    expect(localStorage.getItem('super-high-mobile-theme-cache')).toBe('shen-dian')
    vi.mocked(MobileHostApi.prototype.status).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '退出登录'); await flush()
    resolveOld({ themeId: 'light', hiddenCliProviderIds: ['codex'] } as never); await flush()
    expect(root.textContent).toContain('未连接电脑')
    expect(localStorage.getItem('super-high-mobile-theme-cache')).toBe('shen-dian')
  })

  it('uses the desktop theme and persists mobile theme and CLI visibility changes', async () => {
    vi.mocked(MobileHostApi.prototype.status).mockResolvedValue({ themeId: 'shen-dian', hiddenCliProviderIds: ['codex'] } as never)
    const save = vi.spyOn(MobileHostApi.prototype, 'updatePreferences').mockImplementation(async value => {
      const result = { themeId: value.themeId ?? 'light', hiddenCliProviderIds: value.hiddenCliProviderIds ?? ['codex'] }
      vi.mocked(MobileHostApi.prototype.status).mockResolvedValue(result as never)
      return result
    })
    const { root } = mount('/mobile/', '#token=handoff-token'); await flush()
    expect(localStorage.getItem('super-high-mobile-theme-cache')).toBe('shen-dian')
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '外观'); await flush()
    const select = root.querySelector<HTMLSelectElement>('.mobile-settings-field select')!
    expect(select.value).toBe('shen-dian')
    expect([...select.options].map(option => option.value)).toEqual(Object.keys(THEMES))
    select.value = 'light'; select.dispatchEvent(new Event('change')); await flush()
    expect(save).toHaveBeenCalledWith({ themeId: 'light' })
    expect(localStorage.getItem('super-high-mobile-theme-cache')).toBe('light')
    root.querySelector<HTMLButtonElement>('.mobile-settings [aria-label="返回"]')!.click(); await flush()
    clickText(root, 'CLI 显示'); await flush()
    const codex = root.querySelector<HTMLInputElement>('input[role="switch"][aria-label="Codex CLI"]')!
    expect(codex.checked).toBe(false)
    codex.checked = true; codex.dispatchEvent(new Event('change')); await flush()
    expect(save).toHaveBeenLastCalledWith({ hiddenCliProviderIds: [] })
  })

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
    expect(location.replace).toHaveBeenCalledWith('http://localhost/#disconnect=1')
    expect(localStorage.getItem(key)).toBeNull()
  })
  it('consumes native logout marker before reading old localhost credentials', async () => {
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://old-host', token: 'old-token' }))
    const { root, history } = mount('/', '#disconnect=1', true)
    await flush()
    expect(localStorage.getItem(key)).toBeNull()
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(MobileHostApi.prototype.status).not.toHaveBeenCalled()
    expect(root.querySelector('.test-terminal')).not.toBeNull()
  })
  it('recognizes the Android voice bridge on a hosted page when Capacitor reports web', async () => {
    const { root, location } = mount('/mobile/', '#token=handoff-token', true)
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '退出登录')
    expect(location.replace).toHaveBeenCalledWith('http://localhost/#disconnect=1')
  })
  it('keeps the verified host while editing credentials and after failed validation', async () => {
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://old-host', token: 'old-token' }))
    const { root } = mount('/')
    await flush()
    const existingTerminal = root.querySelector('.test-terminal')
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '账号管理'); await flush()
    const address = root.querySelector<HTMLInputElement>('input[type="url"]')!
    const credential = root.querySelector<HTMLInputElement>('input[type="password"]')!
    address.value = 'http://new-host'; address.dispatchEvent(new Event('input'))
    credential.value = 'candidate-secret'; credential.dispatchEvent(new Event('input')); await flush()
    root.querySelector<HTMLButtonElement>('.probe-active-host')!.click(); await flush()
    const contexts = vi.mocked(MobileHostApi.prototype.status).mock.contexts
    expect((contexts.at(-1) as unknown as { baseUrl: string }).baseUrl).toBe('http://old-host')
    vi.mocked(MobileHostApi.prototype.status).mockRejectedValueOnce(new Error('Rejected candidate-secret'))
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(root.querySelector('.test-terminal')).toBe(existingTerminal)
    expect(root.textContent).not.toContain('candidate-secret')
    expect(root.textContent).toContain('令牌已隐藏')
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ baseUrl: 'http://old-host', token: 'old-token' })
    root.querySelector<HTMLButtonElement>('.probe-active-host')!.click(); await flush()
    expect((contexts.at(-1) as unknown as { baseUrl: string }).baseUrl).toBe('http://old-host')
    vi.mocked(MobileHostApi.prototype.listRecentProjects).mockRejectedValueOnce(new Error('Projects unavailable'))
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(root.querySelector('.test-terminal')).toBe(existingTerminal)
    expect(JSON.parse(localStorage.getItem(key)!).baseUrl).toBe('http://old-host')
  })
  it('commits a verified new host and remounts the terminal even for the same workspace path', async () => {
    localStorage.setItem(key, JSON.stringify({ baseUrl: 'http://old-host', token: 'old-token' }))
    vi.mocked(MobileHostApi.prototype.listRecentProjects).mockResolvedValue([{ path: 'D:/same', name: 'Same', lastOpenedAt: '' }])
    vi.spyOn(MobileHostApi.prototype, 'listDirectory').mockResolvedValue({ path: 'D:/same', entries: [] } as never)
    const { root } = mount('/')
    await flush()
    const existingTerminal = root.querySelector('.test-terminal')
    root.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click(); await flush()
    clickText(root, '账号管理'); await flush()
    const address = root.querySelector<HTMLInputElement>('input[type="url"]')!
    address.value = 'http://new-host'; address.dispatchEvent(new Event('input')); await flush()
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(root.querySelector('.test-terminal')).not.toBe(existingTerminal)
    expect(root.querySelector('.test-terminal')?.getAttribute('data-root')).toBe('D:/same')
    expect(JSON.parse(localStorage.getItem(key)!).baseUrl).toBe('http://new-host')
    root.querySelector<HTMLButtonElement>('.probe-active-host')!.click(); await flush()
    expect((vi.mocked(MobileHostApi.prototype.status).mock.contexts.at(-1) as unknown as { baseUrl: string }).baseUrl).toBe('http://new-host')
  })
})
