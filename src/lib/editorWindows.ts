import { backend } from '@/lib/tauri'
import { editorPathKey, loadEditorCatalog, prepareEditor, type EditorScope } from '@/lib/editorCatalog'
import type { Workspace } from '@/types'

export interface EditorWindowOpenOptions {
  id?: string
  path?: string
  scope?: EditorScope
  parameters?: Record<string, unknown>
}

export interface EditorWindowPage {
  path: string
  title: string
  parameters: Record<string, unknown>
}

export interface EditorWindowInbox {
  workspace: Workspace
  pages: EditorWindowPage[]
}

/** Both the title-bar entry and ctx.editor.openWindow use this catalog. */
export async function openEditorWindow(workspace: Workspace | null, options?: EditorWindowOpenOptions): Promise<string> {
  if (!workspace) throw new Error('请先打开工作区。')
  let page: EditorWindowPage | undefined
  if (options) {
    if (!options.id && !options.path) throw new Error('请指定编辑器 id 或 path。')
    const catalog = await loadEditorCatalog(workspace.rootPath)
    const matches = catalog.filter(editor => (!options.scope || editor.scope === options.scope)
      && (!options.id || editor.id === options.id)
      && (!options.path || editorPathKey(editor.path) === editorPathKey(options.path) || editor.entry === options.path))
    const editor = matches[0]
    if (!editor) throw new Error(`找不到已登记的编辑器：${options.id ?? options.path}`)
    await prepareEditor(editor)
    page = { path: editor.path, title: editor.id, parameters: options.parameters ?? {} }
  }
  return backend.openEditorWindow(workspace, page)
}
