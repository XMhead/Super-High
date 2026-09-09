import type { AppUpdateStatus } from '@/lib/tauri'
import type {
  DirectoryListing,
  MobileHostApiStatus,
  ProjectSearchResult,
  RecentProject,
  CliProviderEnvironment,
  CliNativeConversationSummary,
  CliNativeConversationDetail,
  TerminalSession,
  TerminalProviderKind,
} from '@/types'

export interface MobileTerminalBuffer {
  buffer: string
  startByte: number
  endByte: number
  running: boolean
  reset: boolean
}

export class MobileHostError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

export interface MobileHostConnection {
  baseUrl: string
  token: string
}

export interface MobilePreferences {
  themeId: string
  hiddenCliProviderIds: string[]
}

export interface MobileAttachment {
  path: string
  name: string
  mimeType: string
  size: number
}

export class MobileHostApi {
  private readonly baseUrl: string
  private readonly token: string

  constructor(connection: MobileHostConnection) {
    this.baseUrl = connection.baseUrl.replace(/\/+$/, '')
    this.token = connection.token.trim()
  }

  status() {
    return this.getJson<MobileHostApiStatus>('/api/mobile/status')
  }

  updatePreferences(preferences: Partial<MobilePreferences>) {
    return this.postJson<MobilePreferences>('/api/mobile/preferences', preferences)
  }

  async uploadAttachment(root: string, file: File): Promise<MobileAttachment> {
    if (file.size > 32 * 1024 * 1024) throw new Error('附件不能超过 32 MiB。')
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取附件失败。'))
      reader.onerror = () => reject(new Error('读取附件失败。'))
      reader.onabort = () => reject(new Error('附件读取已取消。'))
      reader.readAsDataURL(file)
    })
    return this.postJson<MobileAttachment>('/api/mobile/attachments', { root, name: file.name, dataUrl })
  }

  async checkMobilePage() {
    try {
      const response = await this.request('/mobile/', undefined, false)
      if (!response.headers.get('content-type')?.includes('text/html')) {
        throw new Error('电脑 Host 未提供手机界面，请先更新电脑端 Super High。')
      }
    } catch (error) {
      if (error instanceof MobileHostError) {
        throw new Error('电脑 Host 未提供手机界面，请先更新电脑端 Super High。')
      }
      throw error
    }
  }

  getAppUpdateStatus() { return this.getJson<AppUpdateStatus>('/api/mobile/update') }
  checkAppUpdate() { return this.postJson<AppUpdateStatus>('/api/mobile/update/check', {}) }
  downloadAppUpdate() { return this.postJson<AppUpdateStatus>('/api/mobile/update/download', {}) }
  installAppUpdate() { return this.postJson<AppUpdateStatus>('/api/mobile/update/install', {}) }

  listRecentProjects() {
    return this.getJson<RecentProject[]>('/api/mobile/recent-projects')
  }

  listDirectory(path: string) {
    return this.getJson<DirectoryListing>(`/api/mobile/dirs?${new URLSearchParams({ path })}`)
  }

  readTextFile(path: string) {
    return this.getText(`/api/mobile/files/text?${new URLSearchParams({ path })}`)
  }

  readImageFile(path: string) {
    return this.getText(`/api/mobile/files/image?${new URLSearchParams({ path })}`)
  }

  search(root: string, q: string) {
    return this.getJson<ProjectSearchResult>(`/api/mobile/search?${new URLSearchParams({ root, q })}`)
  }

  listProviders() {
    return this.getJson<CliProviderEnvironment[]>('/api/mobile/providers')
  }

  listTerminals() {
    return this.getJson<TerminalSession[]>('/api/mobile/terminals')
  }

  createTerminal(cwd: string, providerKind: TerminalProviderKind) {
    return this.postJson<TerminalSession>('/api/mobile/terminals', { cwd, providerKind })
  }

  terminalBuffer(sessionId: string, after: number) {
    return this.getJson<MobileTerminalBuffer>(`/api/mobile/terminals/buffer?${new URLSearchParams({ sessionId, after: String(after) })}`)
  }

  writeTerminal(sessionId: string, input: string) {
    return this.postJson('/api/mobile/terminals/input', { sessionId, input })
  }

  resizeTerminal(sessionId: string, cols: number, rows: number) {
    return this.postJson('/api/mobile/terminals/resize', { sessionId, cols, rows })
  }

  closeTerminal(sessionId: string) {
    return this.postJson('/api/mobile/terminals/close', { sessionId })
  }

  listConversations(root: string) {
    return this.getJson<CliNativeConversationSummary[]>(`/api/mobile/conversations?${new URLSearchParams({ root })}`)
  }

  readConversation(root: string, sourcePath: string) {
    return this.getJson<CliNativeConversationDetail>(`/api/mobile/conversation?${new URLSearchParams({ root, sourcePath })}`)
  }

  resumeConversation(cwd: string, providerKind: string, nativeSessionId: string) {
    return this.postJson<TerminalSession>('/api/mobile/terminals/resume', { cwd, providerKind, nativeSessionId })
  }

  private async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, body)
    return response.json() as Promise<T>
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path)
    return response.json() as Promise<T>
  }

  private async getText(path: string): Promise<string> {
    const response = await this.request(path)
    return response.text()
  }

  private async request(path: string, body?: unknown, authenticated = true): Promise<Response> {
    const controller = new AbortController()
    const timeoutMs = path === '/api/mobile/update/download' ? 31 * 60 * 1000
      : path === '/api/mobile/attachments' ? 120000 : 35000
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('连接超时，请确认电脑 Host 已启动、地址正确，且手机与电脑在同一局域网。')
      }
      if (error instanceof TypeError) {
        throw new Error('无法连接电脑，请检查 Host 地址、网络和电脑防火墙。')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
    if (response.ok) return response

    let message = `${response.status} ${response.statusText}`
    try {
      const text = await response.text()
      try {
        const body = JSON.parse(text) as { error?: unknown }
        if (typeof body.error === 'string' && body.error.trim()) message = body.error
      } catch { if (text.trim()) message = text.trim() }
    } catch { /* Preserve HTTP status when the response body is unavailable. */ }
    throw new MobileHostError(message, response.status)
  }
}

export function normalizeHostBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}
