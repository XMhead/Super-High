import type { WorkspaceFileWatch } from '@/types'

export function parseEditorFileWatch(value: unknown): WorkspaceFileWatch[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('fileWatch 必须是范围数组。')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('fileWatch 范围必须是对象。')
    const item = entry as Record<string, unknown>
    if (typeof item.path !== 'string') throw new Error('fileWatch 必须声明相对路径。')
    const path = item.path.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!path || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('fileWatch 必须限定工作区内的具体文件或目录。')
    if (item.kind !== 'file' && item.kind !== 'directory') throw new Error('fileWatch kind 必须是 file 或 directory。')
    if (item.recursive !== undefined && typeof item.recursive !== 'boolean') throw new Error('fileWatch recursive 必须是布尔值。')
    if (item.extensions !== undefined && (!Array.isArray(item.extensions) || item.extensions.some(extension => typeof extension !== 'string' || !/^\.[^/\\.]+$/.test(extension)))) throw new Error('fileWatch extensions 必须是带点的扩展名数组。')
    const extensions = (item.extensions as string[] | undefined)?.map(extension => extension.toLowerCase()) ?? []
    if (item.kind === 'file' && (item.recursive || extensions.length)) throw new Error('精确文件监听不能声明递归或扩展名。')
    return { path, kind: item.kind, recursive: item.recursive === true, extensions }
  })
}

export function editorWatchPaths(scopes: WorkspaceFileWatch[], paths: string[], kind: string): string[] {
  if (kind === 'rescan') return Array.from(new Set(scopes.map(scope => scope.path)))
  return paths.filter(path => scopes.some(scope => {
    const target = scope.path.toLowerCase()
    const changed = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (target === changed || target.startsWith(changed + '/')) return true
    if (scope.kind === 'file' || !changed.startsWith(target + '/')) return false
    const relative = changed.slice(target.length + 1)
    if (!scope.recursive && relative.includes('/')) return false
    return !scope.extensions?.length || scope.extensions.some(extension => changed.endsWith(extension))
      || (kind !== 'modify' && !relative.split('/').at(-1)?.includes('.'))
  }))
}
