import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { MobileHostApi } from '@/lib/hostApi'
import { cliProviderLabel } from '@/lib/cliProviders'
import { formatWorkDuration } from '@/lib/cliCompletion'
import type { MobileCliNotice } from '@/types'

type NativeNotify = { show(json: string): boolean; start?(json: string): boolean; stop?(): void }
const POLL_MS = 3000

export function noticeText(notice: MobileCliNotice) {
  const duration = formatWorkDuration(notice.durationMs)
  const title = notice.title.trim() || cliProviderLabel(notice.provider)
  const meta = [cliProviderLabel(notice.provider), notice.plan ? '等待回答' : duration && `工作了 ${duration}`].filter(Boolean).join(' · ')
  return { title, body: notice.body.replace(/\s+/g, ' ').trim(), meta }
}

/** 轮询电脑管家通知；安卓 App 发系统通知，浏览器在页面内显示横幅。 */
export function useMobileNotices(api: Readonly<Ref<MobileHostApi>>, connected: Readonly<Ref<boolean>>, connection?: Readonly<Ref<{ baseUrl: string; token: string } | null>>) {
  const banners = ref<Array<MobileCliNotice & { key: number }>>([])
  let after: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let bannerKey = 0
  let nativeStarted = false

  function show(notice: MobileCliNotice) {
    const text = noticeText(notice)
    const native = (window as Window & { SuperHighNotify?: NativeNotify }).SuperHighNotify
    // 安卓优先使用系统通知，前台和后台保持一致；不可用时保留页面提示。
    if (native && native.show(JSON.stringify({ id: notice.seq, ...text }))) return
    const key = ++bannerKey
    banners.value = [...banners.value.slice(-2), { ...notice, key }]
    setTimeout(() => dismiss(key), 8000)
  }

  function dismiss(key: number) { banners.value = banners.value.filter(item => item.key !== key) }

  async function poll(epoch: number) {
    if (epoch !== generation) return
    try {
      const result = await api.value.notices(after)
      if (epoch !== generation) return
      if (after !== undefined) result.notices.forEach(show)
      after = result.latest
    } catch { /* 连接状态由主界面负责提示 */ }
    if (epoch === generation) timer = setTimeout(() => void poll(epoch), POLL_MS)
  }

  watch([api, connected], () => {
    generation += 1
    clearTimeout(timer)
    after = undefined
    banners.value = []
    const native = (window as Window & { SuperHighNotify?: NativeNotify }).SuperHighNotify
    if (!connected.value) {
      if (nativeStarted) native?.stop?.()
      nativeStarted = false
    } else {
      nativeStarted = !!(connection?.value && native?.start?.(JSON.stringify(connection.value)))
      if (!nativeStarted) void poll(generation)
    }
  }, { immediate: true })
  onBeforeUnmount(() => { generation += 1; clearTimeout(timer) })
  return { banners, dismiss, noticeText }
}
