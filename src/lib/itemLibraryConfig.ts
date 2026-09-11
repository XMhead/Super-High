import { backend } from '@/lib/tauri'
import type { ItemLibrarySource } from '@/types'

export function parseProjectItemLibraryMainSource(raw: string): ItemLibrarySource | null {
  try {
    const value = JSON.parse(raw) as { version?: unknown; mainSource?: unknown }
    if (value.version !== 1) return null
    return value.mainSource === 'ni' || value.mainSource === 'mm' ? value.mainSource : null
  } catch {
    return null
  }
}

export async function loadProjectItemLibraryMainSource(workspaceRoot: string): Promise<ItemLibrarySource | null> {
  try {
    const root = workspaceRoot.replace(/[\\/]+$/, '')
    return parseProjectItemLibraryMainSource(await backend.readFile(`${root}/.superhigh/item-library.json`))
  } catch {
    return null
  }
}
