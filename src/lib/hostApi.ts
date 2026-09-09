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

  private async request(path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
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
