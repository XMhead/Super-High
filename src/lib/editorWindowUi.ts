import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { watch } from 'vue'
import { normalizePath } from './path'
import { isSuperhighUiPath } from './superhighUi'
import type { UiDraftResult } from './superhighUiDraft'
import type { EditorTab } from '@/types'

export interface EditorUiSnapshot {
  rootPath: string
  tabs: EditorTab[]
  activePath?: string
}

type UiRequest = {
  id: string
  replyTo: string
  rootPath: string
  operation: 'snapshot' | 'submit' | 'source'
  path?: string
  text?: string
  previous?: string
}
type UiReply = { id: string; result?: unknown; error?: string }
const REQUEST = 'editor-window-ui-request'
const REPLY = 'editor-window-ui-reply'
const UPDATED = 'editor-window-ui-updated'
const key = (path: string) => normalizePath(path).replace(/\/+$/, '').toLowerCase()

export function editorUiSnapshot(rootPath: string, tabs: EditorTab[], activePath?: string): EditorUiSnapshot {
  return { rootPath, activePath, tabs: tabs.filter(tab => tab.contentType === 'text' && isSuperhighUiPath(tab.path)).map(tab => ({ ...tab })) }
}

export async function bindEditorWindowUiHost(
  snapshots: () => EditorUiSnapshot[],
  submit: (path: string, text: string) => Promise<UiDraftResult>,
  saveSource: (rootPath: string, path: string, text: string, previous: string) => Promise<void>,
  report: (error: unknown) => void,
) {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const unlisten = await listen<UiRequest>(REQUEST, async ({ payload: request }) => {
    if (disposed || !request.replyTo.startsWith('editor-')) return
    try {
      const snapshot = snapshots().find(item => key(item.rootPath) === key(request.rootPath))
      let result: unknown
      if (request.operation === 'snapshot') result = snapshot ?? { rootPath: request.rootPath, tabs: [] }
      else {
        const tab = snapshot?.tabs.find(item => key(item.path) === key(request.path ?? ''))
        if (!tab) throw new Error('原代码预览标签已关闭，请重新打开界面。')
        if (request.operation === 'submit') result = await submit(tab.path, request.text ?? '')
        else if (request.operation === 'source') {
          await saveSource(snapshot!.rootPath, tab.path, request.text ?? '', request.previous ?? '')
          result = true
        }
      }
      await emitTo(request.replyTo, REPLY, { id: request.id, result })
    } catch (error) {
      if (!disposed) await emitTo(request.replyTo, REPLY, { id: request.id, error: String(error) }).catch(report)
    }
  })
  const stop = watch(() => JSON.stringify(snapshots()), () => {
    clearTimeout(timer)
    timer = setTimeout(() => { if (!disposed) void emit(UPDATED, snapshots()).catch(report) }, 60)
  })
  return () => { disposed = true; clearTimeout(timer); stop(); unlisten() }
}

export async function connectEditorWindowUi(rootPath: string, apply: (snapshot: EditorUiSnapshot) => void) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let disposed = false
  const unlistenReply = await listen<UiReply>(REPLY, ({ payload }) => {
    const entry = pending.get(payload.id)
    if (!entry) return
    pending.delete(payload.id)
    clearTimeout(entry.timer)
    if (payload.error) entry.reject(new Error(payload.error))
    else entry.resolve(payload.result)
  })
  let unlistenUpdates: () => void
  try {
    unlistenUpdates = await listen<EditorUiSnapshot[]>(UPDATED, ({ payload }) => {
      if (!disposed) apply(payload.find(item => key(item.rootPath) === key(rootPath)) ?? { rootPath, tabs: [] })
    })
  } catch (error) { unlistenReply(); throw error }
  function request(operation: UiRequest['operation'], fields: Partial<UiRequest> = {}) {
    if (disposed) return Promise.reject(new Error('编辑器连接已关闭。'))
    return new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('主窗口未响应，请重试。')) }, 8000)
      pending.set(id, { resolve, reject, timer })
      void emitTo('main', REQUEST, { ...fields, id, replyTo: getCurrentWindow().label, rootPath, operation }).catch(error => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        reject(error)
      })
    })
  }
  const connection = {
    async refresh() { apply(await request('snapshot') as EditorUiSnapshot) },
    async submit(path: string, text: string) { return await request('submit', { path, text }) as UiDraftResult },
    async saveSource(path: string, text: string, previous: string) { await request('source', { path, text, previous }) },
    destroy() {
      disposed = true
      unlistenReply(); unlistenUpdates()
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('编辑器连接已关闭。')) }
      pending.clear()
    },
  }
  try { await connection.refresh(); return connection }
  catch (error) { connection.destroy(); throw error }
}
