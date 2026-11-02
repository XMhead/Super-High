import { access, readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const MOUNT_PATH = '/__superhigh_workspace'
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const execFileAsync = promisify(execFile)

const CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
  ['.avif', 'image/avif'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
])

function toClientPath(value) {
  return value.replace(/\\/g, '/')
}

function sendJson(response, status, body) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

function isProbablyText(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  return !bytes.subarray(0, 8192).includes(0)
}

function appDataCandidates() {
  if (platform() === 'win32') {
    return [
      process.env.APPDATA && join(process.env.APPDATA, 'com.superhigh.desktop', 'super-high.db'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'com.superhigh.desktop', 'super-high.db'),
    ].filter(Boolean)
  }
  if (platform() === 'darwin') return [join(homedir(), 'Library', 'Application Support', 'com.superhigh.desktop', 'super-high.db')]
  return [
    process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'com.superhigh.desktop', 'super-high.db'),
    join(homedir(), '.local', 'share', 'com.superhigh.desktop', 'super-high.db'),
  ].filter(Boolean)
}

function sqliteCandidates() {
  return [
    process.env.SUPERHIGH_SQLITE3,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', platform() === 'win32' ? 'sqlite3.exe' : 'sqlite3'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', platform() === 'win32' ? 'sqlite3.exe' : 'sqlite3'),
    'sqlite3',
  ].filter(Boolean)
}

async function readRealThemeSettings() {
  const existingDatabase = []
  for (const candidate of appDataCandidates()) {
    try { await access(candidate); existingDatabase.push(candidate) } catch { /* Try the next app data location. */ }
  }
  if (!existingDatabase.length) return null
  const query = 'SELECT json FROM app_settings WHERE id = 1;'
  for (const sqlite of sqliteCandidates()) {
    try {
      const result = await execFileAsync(sqlite, ['-json', existingDatabase[0], query], { windowsHide: true, maxBuffer: 1024 * 1024 })
      const rows = JSON.parse(result.stdout)
      const settings = rows[0]?.json ? JSON.parse(rows[0].json) : null
      if (!settings || typeof settings !== 'object') return null
      return { themeId: typeof settings.themeId === 'string' ? settings.themeId : null, customThemes: Array.isArray(settings.customThemes) ? settings.customThemes : [] }
    } catch { /* The preview still works with the built-in theme when SQLite is unavailable. */ }
  }
  return null
}

/** Node-side data source for `--page desktop`: read-only access to one source tree. */
export function createDesktopPreviewOptions(root) {
  const sourceRoot = resolve(root)
  const clientRoot = toClientPath(sourceRoot)
  const stubPath = fileURLToPath(new URL('../src/preview/tauriEventStub.ts', import.meta.url))
  const insideSource = (target) => {
    const normalized = toClientPath(resolve(target)).toLowerCase()
    const base = clientRoot.toLowerCase()
    return normalized === base || normalized.startsWith(`${base}/`)
  }
  const middleware = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/info') {
        sendJson(response, 200, { rootPath: clientRoot, name: basename(sourceRoot), displayName: basename(sourceRoot) })
        return
      }
      if (url.pathname === '/theme') {
        sendJson(response, 200, await readRealThemeSettings() ?? { themeId: null, customThemes: [] })
        return
      }
      const target = url.searchParams.get('path') ?? ''
      if (!target) {
        sendJson(response, 400, { error: '缺少 path 参数' })
        return
      }
      if (!insideSource(target)) {
        sendJson(response, 403, { error: '预览界面只能访问源码目录内的路径' })
        return
      }
      if (url.pathname === '/stat') {
        try {
          const metadata = await stat(target)
          sendJson(response, 200, { exists: true, type: metadata.isDirectory() ? 'directory' : 'file' })
        } catch {
          sendJson(response, 200, { exists: false, type: null })
        }
        return
      }
      if (url.pathname === '/directory') {
        const items = await readdir(target, { withFileTypes: true })
        const entries = items.map((item) => {
          const itemPath = toClientPath(join(target, item.name))
          const isDirectory = item.isDirectory()
          return {
            name: item.name,
            path: itemPath,
            type: isDirectory ? 'directory' : 'file',
            extension: isDirectory ? undefined : extname(item.name),
            isHidden: item.name.startsWith('.'),
          }
        })
        entries.sort((left, right) => {
          if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
          return left.name.toLowerCase().localeCompare(right.name.toLowerCase())
        })
        sendJson(response, 200, { path: toClientPath(target), entries })
        return
      }
      if (url.pathname === '/file') {
        const metadata = await stat(target)
        if (!metadata.isFile()) {
          sendJson(response, 400, { error: `文本预览需要普通文件：${target}` })
          return
        }
        if (metadata.size > MAX_TEXT_BYTES) {
          sendJson(response, 400, { error: '文本文件超过内置编辑器的 10 MB 上限，请使用外部编辑器打开' })
          return
        }
        const bytes = await readFile(target)
        if (!isProbablyText(bytes)) {
          sendJson(response, 400, { error: '此文件不是可编辑的 UTF-8 文本，请使用系统应用打开' })
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(bytes)
        return
      }
      if (url.pathname === '/raw') {
        const bytes = await readFile(target)
        response.statusCode = 200
        response.setHeader('Content-Type', CONTENT_TYPES.get(extname(target).toLowerCase()) ?? 'application/octet-stream')
        response.setHeader('Cache-Control', 'no-store')
        response.end(bytes)
        return
      }
      sendJson(response, 404, { error: '未知的预览数据接口' })
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    plugins: [{
      name: 'superhigh-desktop-preview-source',
      configureServer(server) {
        server.middlewares.use(MOUNT_PATH, middleware)
      },
    }, {
      // This preview talks to Tauri events only through the local stub bus.
      // Resolving to the same file keeps one shared module instance with the simulator.
      name: 'superhigh-desktop-preview-event-stub',
      enforce: 'pre',
      resolveId(source) {
        if (source === '@tauri-apps/api/event') return stubPath
        return undefined
      },
    }],
    optimizeDeps: { exclude: ['@tauri-apps/api/event'] },
  }
}
