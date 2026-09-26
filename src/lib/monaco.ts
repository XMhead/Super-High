import type * as MonacoNamespace from 'monaco-editor'

export type Monaco = typeof MonacoNamespace

let cached: Monaco | null = null

export async function loadMonaco(): Promise<Monaco> {
  if (cached) return cached
  cached = await import('monaco-editor')
  return cached
}

export function getMonaco(): Monaco | null {
  return cached
}
