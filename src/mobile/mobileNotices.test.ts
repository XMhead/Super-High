import { createApp, h, nextTick, ref, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileHostApi } from '@/lib/hostApi'
import { useMobileNotices } from './mobileNotices'

const notice = { seq: 2, title: '任务完成', provider: 'codex', workspace: 'C:/work', body: '完成', durationMs: null, plan: false }

async function exercise(show?: (json: string) => boolean) {
  if (show) Object.assign(window, { SuperHighNotify: { show } })
  const api = { notices: vi.fn().mockResolvedValueOnce({ latest: 1, notices: [] }).mockResolvedValue({ latest: 2, notices: [notice] }) }
  let result!: ReturnType<typeof useMobileNotices>
  const root = document.createElement('div')
  const app = createApp({ setup() { result = useMobileNotices(shallowRef(api as unknown as MobileHostApi), ref(true)); return () => h('div') } })
  app.mount(root)
  await nextTick()
  await vi.advanceTimersByTimeAsync(3000)
  return { result, app, api }
}

afterEach(() => { delete (window as Window & { SuperHighNotify?: unknown }).SuperHighNotify; vi.useRealTimers() })

describe('mobile notices', () => {
  it('sends a foreground notice to Android without duplicating the banner', async () => {
    vi.useFakeTimers()
    const show = vi.fn((_json: string) => true)
    const { result, app } = await exercise(show)
    expect(show).toHaveBeenCalledOnce()
    expect(JSON.parse(show.mock.calls[0][0])).toMatchObject({ id: 2, title: '任务完成', body: '完成' })
    expect(result.banners.value).toEqual([])
    app.unmount()
  })

  it('keeps a banner when native notifications are unavailable', async () => {
    vi.useFakeTimers()
    const { result, app } = await exercise(() => false)
    expect(result.banners.value).toHaveLength(1)
    app.unmount()
  })

  it('lets the native service own polling and stops it when disconnected', async () => {
    vi.useFakeTimers()
    const native = { show: vi.fn(), start: vi.fn(() => true), stop: vi.fn() }
    Object.assign(window, { SuperHighNotify: native })
    const api = { notices: vi.fn() }
    const connected = ref(true)
    const connection = ref<{ baseUrl: string; token: string } | null>({ baseUrl: 'http://localhost:1234', token: 'secret' })
    const app = createApp({ setup() { useMobileNotices(shallowRef(api as unknown as MobileHostApi), connected, connection); return () => h('div') } })
    app.mount(document.createElement('div'))
    await vi.advanceTimersByTimeAsync(6000)
    expect(native.start).toHaveBeenCalledOnce()
    expect(api.notices).not.toHaveBeenCalled()
    connected.value = false
    await nextTick()
    expect(native.stop).toHaveBeenCalledOnce()
    app.unmount()
  })
})
