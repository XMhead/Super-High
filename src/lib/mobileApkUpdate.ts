import { onBeforeUnmount, ref } from 'vue'

export type MobileApkUpdateState = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'permission' | 'installing' | 'error'

interface AndroidApkUpdateBridge {
  getStatus: () => string
  check: () => void
  install: () => void
}

const releaseApi = 'https://api.github.com/repos/XMhead/Super-High/releases/latest'
const assetPrefix = 'https://github.com/XMhead/Super-High/releases/download/'
const states = new Set<MobileApkUpdateState>(['idle', 'checking', 'available', 'current', 'downloading', 'permission', 'installing', 'error'])

/** APK version comes only from Android; the paired Host's UI version is independent. */
export function useMobileApkUpdate() {
  const bridge = (window as Window & { SuperHighApkUpdate?: AndroidApkUpdateBridge }).SuperHighApkUpdate
  const nativeAvailable = !!bridge && typeof bridge.getStatus === 'function' && typeof bridge.check === 'function' && typeof bridge.install === 'function'
  const installedVersion = ref('')
  const state = ref<MobileApkUpdateState>('idle')
  const latestVersion = ref('')
  const progress = ref(-1)
  const message = ref('')
  const downloadUrl = ref('')
  let controller: AbortController | undefined
  let disposed = false

  function applyStatus(value: unknown) {
    if (!value || typeof value !== 'object') return
    const detail = value as Record<string, unknown>
    if (typeof detail.state === 'string' && states.has(detail.state as MobileApkUpdateState)) state.value = detail.state as MobileApkUpdateState
    if (typeof detail.installedVersion === 'string') installedVersion.value = detail.installedVersion
    if (typeof detail.latestVersion === 'string') latestVersion.value = detail.latestVersion
    if (typeof detail.message === 'string') message.value = detail.message
    if (typeof detail.progress === 'number') progress.value = detail.progress
    if (typeof detail.downloadUrl === 'string' && detail.downloadUrl.startsWith(assetPrefix)) downloadUrl.value = detail.downloadUrl
  }

  function onStatus(event: Event) { applyStatus((event as CustomEvent).detail) }

  if (nativeAvailable) {
    window.addEventListener('superhigh:apk-update', onStatus)
    try { applyStatus(JSON.parse(bridge!.getStatus())) } catch { /* A fresh check can recover bridge state. */ }
  }

  async function checkUpdate() {
    if (state.value === 'checking' || state.value === 'downloading') return
    state.value = 'checking'
    message.value = ''
    progress.value = -1
    latestVersion.value = ''
    downloadUrl.value = ''
    try {
      if (nativeAvailable) { bridge!.check(); return }
      controller?.abort()
      controller = new AbortController()
      const timeout = window.setTimeout(() => controller?.abort(), 25000)
      let release: { draft?: boolean; prerelease?: boolean; tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }
      try {
        const response = await fetch(releaseApi, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
        if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? '更新服务暂时限流，请稍后重试' : '无法获取更新，请检查网络后重试')
        release = await response.json()
      } finally { window.clearTimeout(timeout) }
      if (disposed) return
      const version = release.tag_name?.replace(/^v/, '')
      if (release.draft || release.prerelease || !version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('正式版更新信息不正确')
      const assets = release.assets?.filter(asset => asset.name?.toLowerCase().endsWith('.apk') && asset.browser_download_url?.startsWith(assetPrefix)) ?? []
      if (assets.length !== 1) throw new Error(assets.length ? '正式版包含多个 APK，无法确定更新包' : '正式版尚未提供手机安装包，请稍后重试')
      latestVersion.value = version
      downloadUrl.value = assets[0]!.browser_download_url!
      state.value = 'available'
      message.value = '点击下载手机安装包，下载完成后打开文件安装'
    } catch (error) {
      if (disposed) return
      state.value = 'error'
      message.value = error instanceof TypeError ? '无法获取更新，请检查网络后重试'
        : error instanceof Error && error.name !== 'AbortError' ? error.message : '检查更新超时，请检查网络后重试'
    }
  }

  function installUpdate() {
    try {
      if (nativeAvailable) bridge!.install()
      else if (downloadUrl.value) window.location.assign(downloadUrl.value)
    } catch {
      state.value = 'error'
      message.value = '无法启动更新，请重试'
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    controller?.abort()
    if (nativeAvailable) window.removeEventListener('superhigh:apk-update', onStatus)
  })

  return { nativeAvailable, installedVersion, state, latestVersion, progress, message, downloadUrl, checkUpdate, installUpdate }
}
