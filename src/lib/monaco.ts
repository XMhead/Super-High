import type * as MonacoNamespace from 'monaco-editor'
import { initializeMonacoWorkers } from './monacoWorkers'

export type Monaco = typeof MonacoNamespace

/**
 * Monaco 把 `_os` 解析成 `zh-CN`，而易混淆字符表的键是 `zh-hans`/`zh-hant`，
 * 中文系统下全角 `，（）：` 仍会被当作 ASCII 易混字符加框；显式放行中文。
 */
export const MONACO_UNICODE_HIGHLIGHT: MonacoNamespace.editor.IUnicodeHighlightOptions = {
  allowedLocales: { _os: true, _vscode: true, 'zh-hans': true, 'zh-hant': true },
}

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
