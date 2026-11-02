import type { PluginDescriptor } from '@/types'

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/\?\//, '').replace(/\/+$/, '').toLowerCase()
}

function contains(parent: string, path: string): boolean {
  return parent === path || path.startsWith(`${parent}/`)
}

// A matching event also requires rediscovery when no current descriptor exists:
// it may have created a plugin or introduced a project override.
export function pluginFileChanges(paths: string[], root: string, plugins: PluginDescriptor[]) {
  const rootKey = pathKey(root)
  if (!paths.length || !rootKey) return { relevant: true, ids: plugins.map((plugin) => plugin.id) }
  const changed = paths.map(pathKey).filter(Boolean).filter((path) => contains(rootKey, path) || contains(path, rootKey))
  const ids = plugins.filter((plugin) => {
    const pluginRoot = pathKey(plugin.rootPath)
    return pluginRoot && changed.some((path) => contains(pluginRoot, path) || contains(path, pluginRoot))
  }).map((plugin) => plugin.id)
  return { relevant: changed.length > 0, ids }
}
