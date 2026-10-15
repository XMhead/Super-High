import type * as MonacoNamespace from 'monaco-editor'
import { initializeMonacoWorkers } from './monacoWorkers'

export type Monaco = typeof MonacoNamespace

let cached: Monaco | null = null

export async function loadMonaco(): Promise<Monaco> {
  if (cached) return cached
  initializeMonacoWorkers()
  cached = await import('monaco-editor')
  return cached
}

export function getMonaco(): Monaco | null {
  return cached
}
