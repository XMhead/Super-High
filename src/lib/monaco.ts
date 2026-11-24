import type * as MonacoNamespace from 'monaco-editor'
import { initializeMonacoWorkers } from './monacoWorkers'
import { isHttpExternalUrl } from './externalLinks'
import { backend } from './tauri'
import { useWorkspaceStore } from '@/stores/workspace'

export type Monaco = typeof MonacoNamespace

/**
 * Monaco 把 `_os` 解析成 `zh-CN`，而易混淆字符表的键是 `zh-hans`/`zh-hant`，
 * 中文系统下全角 `，（）：` 仍会被当作 ASCII 易混字符加框；显式放行中文。
 */
export const MONACO_UNICODE_HIGHLIGHT: MonacoNamespace.editor.IUnicodeHighlightOptions = {
  allowedLocales: { _os: true, _vscode: true, 'zh-hans': true, 'zh-hant': true },
}

let cached: Monaco | null = null
let loading: Promise<Monaco> | null = null

export async function loadMonaco(): Promise<Monaco> {
  if (cached) return cached
  loading ??= (async () => {
    initializeMonacoWorkers()
    const monaco = await import('monaco-editor/esm/vs/editor/editor.main.js')
    // Monaco's default window.open does not reach the system browser in WebView2.
    // Register once for both the source editor and the diff editor.
    monaco.editor.registerLinkOpener({
      async open(resource) {
        const url = resource.toString()
        if (!isHttpExternalUrl(url)) return false
        try { await backend.openUrl(url) }
        catch (error) {
          useWorkspaceStore().showErrorMessage(`打开网页失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return true
      },
    })
    cached = monaco
    return monaco
  })().catch((error) => { loading = null; throw error })
  return loading
}

export function getMonaco(): Monaco | null {
  return cached
}
