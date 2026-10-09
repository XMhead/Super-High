import type { DirectoryListing, FileEntry } from '@/types'

export const SOURCE_MOUNT = '/__superhigh_workspace'

export interface PreviewSourceInfo {
  rootPath: string
  name: string
  displayName: string
}

export interface OverlayFile {
  path: string
  content: string
}

/** 浏览器内的可写覆盖层：真实源码只读，新建与编辑只保留在当前预览页面。 */
export interface SourceOverlayState {
  files: Map<string, OverlayFile>
  directories: Map<string, string>
  removed: Set<string>
  renamed: Map<string, string>
}

export function createSourceOverlay(): SourceOverlayState {
  return { files: new Map(), directories: new Map(), removed: new Set(), renamed: new Map() }
}

export function normalizePreviewPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function parentPathKey(key: string): string {
  const index = key.lastIndexOf('/')
  if (index < 0) return ''
  if (index === 2 && key[1] === ':') return key.slice(0, 3)
  return key.slice(0, index)
}

export function previewParentPath(path: string): string {
  return parentPathKey(normalizePreviewPathKey(path))
}

export function previewPathName(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

export function previewFileExtension(path: string): string | undefined {
  const name = previewPathName(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index) : undefined
}

/** 改名后的展示路径 -> 原始路径；未改名时返回 null。 */
function resolveRenamedSource(path: string, overlay: SourceOverlayState): string | null {
  const key = normalizePreviewPathKey(path)
  for (const [sourceKey, nextPath] of overlay.renamed) {
    const nextKey = normalizePreviewPathKey(nextPath)
    if (key === nextKey) return sourceKey
    if (key.startsWith(`${nextKey}/`)) return sourceKey + path.slice(nextKey.length)
  }
  return null
}

function resolveRenamedDisplay(path: string, overlay: SourceOverlayState): string {
  const key = normalizePreviewPathKey(path)
  for (const [sourceKey, nextPath] of overlay.renamed) {
    if (key === sourceKey) return nextPath
    if (key.startsWith(`${sourceKey}/`)) return nextPath + path.slice(sourceKey.length)
  }
  return path
}

function isRemoved(key: string, overlay: SourceOverlayState): boolean {
  if (overlay.removed.has(key)) return true
  for (const removed of overlay.removed) {
    if (key.startsWith(`${removed}/`)) return true
  }
  return false
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name.toLowerCase().localeCompare(right.name.toLowerCase())
  })
}

/** 把真实目录列表与浏览器内覆盖层合并成文件树读取结果。 */
export function mergeDirectoryListing(listing: DirectoryListing, overlay: SourceOverlayState): DirectoryListing {
  const directoryKey = normalizePreviewPathKey(listing.path)
  const entries: FileEntry[] = []
  const overlaidKeys = new Set<string>()
  for (const [key] of overlay.files) overlaidKeys.add(key)
  for (const [key] of overlay.directories) overlaidKeys.add(key)

  for (const entry of listing.entries) {
    const entryKey = normalizePreviewPathKey(entry.path)
    if (isRemoved(entryKey, overlay) || overlaidKeys.has(entryKey)) continue
    const display = resolveRenamedDisplay(entry.path, overlay)
    const displayKey = normalizePreviewPathKey(display)
    if (isRemoved(displayKey, overlay) || overlaidKeys.has(displayKey)) continue
    if (parentPathKey(displayKey) !== directoryKey) continue
    entries.push(display === entry.path ? entry : { ...entry, path: display, name: previewPathName(display), extension: previewFileExtension(display) })
  }

  for (const [key, file] of overlay.files) {
    if (parentPathKey(key) !== directoryKey) continue
    entries.push({ name: previewPathName(file.path), path: file.path, type: 'file', extension: previewFileExtension(file.path) })
  }
  for (const [key, path] of overlay.directories) {
    if (parentPathKey(key) !== directoryKey) continue
    entries.push({ name: previewPathName(path), path, type: 'directory' })
  }
  return { path: listing.path, entries: sortEntries(entries) }
}

export interface PreviewSource extends PreviewSourceInfo {
  listDirectory(path: string): Promise<DirectoryListing>
  statPath(path: string): Promise<'file' | 'directory' | null>
  readTextFile(path: string): Promise<string>
  readRawFile(path: string): Promise<{ bytes: Uint8Array; contentType: string }>
  writeFile(path: string, content: string): void
  createFile(path: string): void
  createDirectory(path: string): void
  renamePath(path: string, nextPath: string): void
  deletePath(path: string): void
}

async function requestJson<T>(query: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${SOURCE_MOUNT}${query}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(message || `预览源码接口失败（${response.status}）`)
  }
  return await response.json() as T
}

export async function openPreviewSource(fetchImpl: typeof fetch = fetch): Promise<PreviewSource> {
  const info = await requestJson<PreviewSourceInfo>('/info', fetchImpl)
  const overlay = createSourceOverlay()
  const removedError = (path: string) => new Error(`预览中已删除：${path}`)

  function overlayPathKey(path: string): string {
    return normalizePreviewPathKey(path)
  }

  function migrateOverlay(sourceKey: string, nextPath: string) {
    for (const [key, file] of [...overlay.files]) {
      if (key === sourceKey || key.startsWith(`${sourceKey}/`)) {
        overlay.files.delete(key)
        const moved = nextPath + file.path.slice(sourceKey.length)
        overlay.files.set(normalizePreviewPathKey(moved), { path: moved, content: file.content })
      }
    }
    for (const [key, dirPath] of [...overlay.directories]) {
      if (key === sourceKey || key.startsWith(`${sourceKey}/`)) {
        overlay.directories.delete(key)
        const moved = nextPath + dirPath.slice(sourceKey.length)
        overlay.directories.set(normalizePreviewPathKey(moved), moved)
      }
    }
  }

  return {
    ...info,
    async listDirectory(path: string) {
      const listing = await requestJson<DirectoryListing>(`/directory?path=${encodeURIComponent(path)}`, fetchImpl)
      return mergeDirectoryListing(listing, overlay)
    },
    async statPath(path: string) {
      const key = overlayPathKey(path)
      if (isRemoved(key, overlay)) return null
      if (overlay.files.has(key)) return 'file'
      if (overlay.directories.has(key)) return 'directory'
      const sourcePath = resolveRenamedSource(path, overlay)
      const response = await requestJson<{ exists: boolean; type: 'file' | 'directory' | null }>(`/stat?path=${encodeURIComponent(sourcePath ?? path)}`, fetchImpl)
      return response.exists ? response.type : null
    },
    async readTextFile(path: string) {
      const key = overlayPathKey(path)
      if (isRemoved(key, overlay)) throw removedError(path)
      const file = overlay.files.get(key)
      if (file) return file.content
      const sourcePath = resolveRenamedSource(path, overlay)
      if (sourcePath && isRemoved(normalizePreviewPathKey(sourcePath), overlay)) throw removedError(path)
      const response = await fetchImpl(`${SOURCE_MOUNT}/file?path=${encodeURIComponent(sourcePath ?? path)}`)
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
        throw new Error(message || `无法读取文件：${path}`)
      }
      return await response.text()
    },
    async readRawFile(path: string) {
      const key = overlayPathKey(path)
      const file = overlay.files.get(key)
      if (file) {
        return { bytes: new TextEncoder().encode(file.content), contentType: 'text/plain; charset=utf-8' }
      }
      const sourcePath = resolveRenamedSource(path, overlay) ?? path
      const response = await fetchImpl(`${SOURCE_MOUNT}/raw?path=${encodeURIComponent(sourcePath)}`)
      if (!response.ok) throw new Error(`无法读取文件内容：${path}`)
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
    },
    writeFile(path: string, content: string) {
      const key = overlayPathKey(path)
      overlay.removed.delete(key)
      overlay.files.set(key, { path, content })
    },
    createFile(path: string) {
      const key = overlayPathKey(path)
      overlay.removed.delete(key)
      overlay.files.set(key, { path, content: '' })
    },
    createDirectory(path: string) {
      const key = overlayPathKey(path)
      overlay.removed.delete(key)
      overlay.directories.set(key, path)
    },
    renamePath(path: string, nextPath: string) {
      const key = overlayPathKey(path)
      if (overlay.files.has(key) || overlay.directories.has(key) || isRemoved(key, overlay)) {
        migrateOverlay(key, nextPath)
      }
      if (!overlay.files.has(overlayPathKey(nextPath)) && !overlay.directories.has(overlayPathKey(nextPath))) {
        overlay.renamed.set(key, nextPath)
      }
    },
    deletePath(path: string) {
      const key = overlayPathKey(path)
      for (const existing of [...overlay.files.keys()]) {
        if (existing === key || existing.startsWith(`${key}/`)) overlay.files.delete(existing)
      }
      for (const existing of [...overlay.directories.keys()]) {
        if (existing === key || existing.startsWith(`${key}/`)) overlay.directories.delete(existing)
      }
      for (const [sourceKey] of [...overlay.renamed]) {
        if (sourceKey === key || sourceKey.startsWith(`${key}/`)) overlay.renamed.delete(sourceKey)
      }
      overlay.removed.add(key)
    },
  }
}
