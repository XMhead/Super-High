import type {
  DirectoryListing,
  MobileHostApiStatus,
  ProjectSearchResult,
  RecentProject,
} from '@/types'

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

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path)
    return response.json() as Promise<T>
  }

  private async getText(path: string): Promise<string> {
    const response = await this.request(path)
    return response.text()
  }

  private async request(path: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    })
    if (response.ok) return response

    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body.error === 'string' && body.error.trim()) message = body.error
    } catch {
      const text = await response.text().catch(() => '')
      if (text.trim()) message = text.trim()
    }
    throw new Error(message)
  }
}

export function normalizeHostBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}
