import { defineStore } from 'pinia'
import { backend, isTauri, type AppUpdateStatus } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'

const AUTO_UPDATE_KEY = 'superhigh.autoUpdate'
function autoUpdateEnabled() {
  try { return localStorage.getItem(AUTO_UPDATE_KEY) !== 'false' } catch { return true }
}

export const useAppUpdateStore = defineStore('appUpdate', {
  state: () => ({
    status: null as AppUpdateStatus | null,
    busy: false,
    installing: false,
    message: '',
    automatic: autoUpdateEnabled(),
  }),
  getters: {
    errorText(): string {
      const message = this.message || this.status?.error || ''
      if (message.includes('Could not fetch a valid release JSON')) {
        return '暂时无法获取更新信息，请检查网络或稍后重试。'
      }
      return message
    },
    statusText(): string {
      const status = this.status
      if (!isTauri() && !status) return '自动更新仅在桌面应用中可用'
      if (!status) return '尚未检查更新'
      switch (status.phase) {
        case 'checking': return '正在检查更新…'
        case 'upToDate': return '当前已是最新版本'
        case 'available': return `发现新版本 ${status.version}`
        case 'downloading': return status.totalBytes
          ? `正在下载 ${status.version} · ${Math.min(100, Math.floor(status.downloadedBytes / status.totalBytes * 100))}%`
          : `正在下载 ${status.version} · ${(status.downloadedBytes / 1024 / 1024).toFixed(1)} MB`
        case 'ready': return `新版本 ${status.version} 已下载`
        case 'installing': return '正在启动安装程序…'
        case 'error': return '更新未完成，可重试'
        default: return '尚未检查更新'
      }
    },
  },
  actions: {
    async refresh() {
      if (!isTauri() || this.busy) return
      try { this.status = await backend.getAppUpdateStatus() }
      catch (error) { this.message = String(error) }
    },
    setAutomatic(value: boolean) {
      this.automatic = value
      try { localStorage.setItem(AUTO_UPDATE_KEY, String(value)) }
      catch { this.message = '自动更新偏好无法保存，下次启动将恢复默认设置。' }
      if (value) void this.check(true)
    },
    async run(operation: () => Promise<AppUpdateStatus>) {
      if (!isTauri() || this.busy) return
      this.busy = true
      this.message = ''
      let polling = false
      let finished = false
      const poll = window.setInterval(async () => {
        if (polling) return
        polling = true
        try {
          const status = await backend.getAppUpdateStatus()
          if (!finished) this.status = status
        } catch { /* The operation reports its own error. */ }
        finally { polling = false }
      }, 700)
      try { this.status = await operation() }
      catch (error) { this.message = String(error) }
      finally {
        finished = true
        window.clearInterval(poll)
        this.busy = false
      }
    },
    async check(downloadAutomatically = false) {
      if (this.busy || this.status?.phase === 'ready' || this.installing) return
      await this.run(() => backend.checkAppUpdate())
      if (downloadAutomatically && this.automatic && this.status?.phase === 'available') {
        await this.download()
      }
    },
    async download() {
      await this.run(() => backend.downloadAppUpdate())
    },
    async install() {
      if (this.busy || this.installing || this.status?.phase !== 'ready') return
      const workspace = useWorkspaceStore()
      if (workspace.hasDirtyTextTabs) {
        this.message = '请先保存或关闭未保存的文件，再安装更新。'
        return
      }
      this.installing = true
      try {
        await workspace.persistOpenTerminalStates()
        if (workspace.hasDirtyTextTabs) {
          this.message = '请先保存或关闭未保存的文件，再安装更新。'
          return
        }
        await this.run(() => backend.installAppUpdate())
      } catch (error) { this.message = String(error) }
      finally { this.installing = false }
    },
  },
})
