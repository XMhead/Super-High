import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export function localPreviewRequest(request: IncomingMessage): boolean {
  const local = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  if (!local.has(request.socket.remoteAddress ?? '')) return false
  const host = request.headers.host ?? ''
  try {
    const url = new URL(`http://${host}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false
    if (request.headers.origin && new URL(request.headers.origin).host !== host) return false
    return !request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))
  } catch { return false }
}

export function readLocalMobileHost(databasePath = join(process.env.APPDATA ?? '', 'com.superhigh.desktop', 'super-high.db')) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = db.prepare('SELECT json FROM app_settings WHERE id = 1').get()
    const host = JSON.parse(String(row?.json)).mobileHost
    if (!host || typeof host.token !== 'string' || !host.token.trim() || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('本机手机服务配置不可用')
    return { token: host.token, target: `http://127.0.0.1:${host.port}` }
  } finally { db.close() }
}
