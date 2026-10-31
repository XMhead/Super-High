import { ref } from 'vue'

import skillOverviewHtml from '@/system-editors/skill-overview.html?raw'
import { backend } from '@/lib/tauri'
import { normalizePath } from '@/lib/path'
import { SOURCE_SCOPE_LABELS, type SourceScope } from '@/lib/sourceScopes'
import type { useWorkspaceStore } from '@/stores/workspace'

/** 系统编辑器随应用打包；全局编辑器位于应用数据目录（与全局脚本工具同根）；项目编辑器位于工作区 `.superhigh/editor`。 */
export type EditorScope = SourceScope

export interface EditorCatalogEntry {
  scope: EditorScope
  id: string
  entry: string
  /** 编辑器 HTML 的绝对路径。 */
  path: string
}

export interface EditorPageLocation {
  scope: EditorScope
  /** 编辑器清单所在目录（系统编辑器没有清单）。 */
  directory: string
  entry: string
}

export const EDITOR_SCOPE_ORDER: EditorScope[] = ['project', 'global', 'system']
export const EDITOR_SCOPE_LABELS = SOURCE_SCOPE_LABELS

const SYSTEM_EDITORS: Array<{ id: string; entry: string; source: string }> = [
  { id: 'Skill 概览', entry: 'skill-overview.html', source: skillOverviewHtml },
]
const RECENT_STORAGE_KEY = 'superhigh-editor-recent'
const RECENT_LIMIT = 3

let dataDirectoryPromise: Promise<string> | null = null
/** 已解析的应用数据目录，供同步判断标签是否为全局/系统编辑器。 */
export const knownDataDirectory = ref('')

function trimSlash(path: string) {
  return normalizePath(path).replace(/\/+$/, '')
}

export function editorPathKey(path: string) {
  return normalizePath(path).toLowerCase()
}

export async function appDataDirectory() {
  dataDirectoryPromise ??= Promise.resolve().then(() => backend.getAppStorageInfo()).then((info) => (knownDataDirectory.value = trimSlash(info.dataDir))).catch((error) => {
    dataDirectoryPromise = null
    throw error
  })
  return dataDirectoryPromise
}

export function projectEditorDirectory(workspaceRoot: string) {
  return `${trimSlash(workspaceRoot)}/.superhigh/editor`
}

export function globalEditorDirectory(dataDirectory: string) {
  return `${trimSlash(dataDirectory)}/editor`
}

export function systemEditorDirectory(dataDirectory: string) {
  return `${trimSlash(dataDirectory)}/system-editors`
}

/** 解析 editor.json 的 pages；排除模板与越出清单目录的入口。 */
export function parseEditorManifest(raw: string, directory: string, scope: Exclude<EditorScope, 'system'>): EditorCatalogEntry[] {
  try {
    const manifest = JSON.parse(raw) as { pages?: unknown }
    const pages = Array.isArray(manifest.pages) ? manifest.pages : []
    return pages.flatMap((page) => {
      if (!page || typeof page !== 'object') return []
      const entry = (page as { entry?: unknown }).entry
      if (typeof entry !== 'string' || !entry.trim()) return []
      const normalized = entry.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '')
      if (normalized.split('/').includes('..') || normalized.toLowerCase() === 'template.html') return []
      const id = (page as { id?: unknown }).id
      return [{ scope, id: typeof id === 'string' && id.trim() ? id.trim() : normalized, entry: normalized, path: `${trimSlash(directory)}/${normalized}` }]
    })
  } catch {
    return []
  }
}

export async function loadEditorCatalog(workspaceRoot: string | null | undefined): Promise<EditorCatalogEntry[]> {
  const dataDirectory = await appDataDirectory().catch(() => '')
  const roots = workspaceRoot ? await backend.listExtensionProjectRoots(workspaceRoot, 'editors') : []
  const readManifest = (directory: string) => backend.readFile(`${directory}/editor.json`).catch(() => '')
  const [projectEntries, globalRaw] = await Promise.all([
    Promise.all(roots.map(async (root) => parseEditorManifest(await readManifest(projectEditorDirectory(root)), projectEditorDirectory(root), 'project'))),
    dataDirectory ? readManifest(globalEditorDirectory(dataDirectory)) : Promise.resolve(''),
  ])
  const ids = new Set<string>()
  const projects = projectEntries.flat().filter((editor) => {
    if (ids.has(editor.id)) return false
    ids.add(editor.id)
    return true
  })
  return [
    ...projects,
    ...(dataDirectory ? parseEditorManifest(globalRaw, globalEditorDirectory(dataDirectory), 'global') : []),
    ...(dataDirectory ? SYSTEM_EDITORS.map(({ id, entry }) => ({ scope: 'system' as const, id, entry, path: `${systemEditorDirectory(dataDirectory)}/${entry}` })) : []),
  ]
}

/** 判断 HTML 标签属于哪一级编辑器，供宿主读取对应清单。 */
export function resolveEditorPage(path: string, workspaceRoot: string | null | undefined, dataDirectory: string | null | undefined, projectRoots: string[] = []): EditorPageLocation | null {
  const key = editorPathKey(path)
  const candidates: Array<[EditorScope, string]> = []
  if (workspaceRoot) candidates.push(['project', projectEditorDirectory(workspaceRoot)])
  for (const root of projectRoots) candidates.push(['project', projectEditorDirectory(root)])
  if (dataDirectory) candidates.push(['global', globalEditorDirectory(dataDirectory)], ['system', systemEditorDirectory(dataDirectory)])
  for (const [scope, directory] of candidates) {
    const prefix = `${editorPathKey(directory)}/`
    if (key.startsWith(prefix)) return { scope, directory, entry: normalizePath(path).slice(prefix.length) }
  }
  return null
}

/** 任意一级编辑器的 HTML 页面（项目编辑器沿用原 `/.superhigh/editor/` 路径判断）。 */
export function isEditorPagePath(path: string) {
  const normalized = normalizePath(path).toLowerCase()
  if (!normalized.endsWith('.html')) return false
  return normalized.includes('/.superhigh/editor/') || !!resolveEditorPage(path, null, knownDataDirectory.value)
}

/** 系统编辑器每次打开前用打包内容覆盖，保证与当前应用版本一致。 */
export async function prepareEditor(editor: EditorCatalogEntry) {
  if (editor.scope !== 'system') return
  const source = SYSTEM_EDITORS.find((item) => item.entry === editor.entry)?.source
  if (source === undefined) throw new Error(`未知的系统编辑器：${editor.entry}`)
  // 内容未变时不写盘，避免已打开标签收到无意义的外部修改。
  if (await backend.readFile(editor.path).catch(() => null) !== source) await backend.writeFile(editor.path, source)
}

/** 与管家面板的项目编辑器入口相同：切到项目视图、打开 HTML 预览并打开页面。 */
export async function openEditor(store: ReturnType<typeof useWorkspaceStore>, editor: EditorCatalogEntry) {
  await prepareEditor(editor)
  store.setSettingsOpen(false)
  store.setWorkspaceSurface('project')
  store.setPreviewMode('code')
  if (!store.settings.htmlPreviewEnabled) store.toggleHtmlPreview()
  const opened = await store.openFile(editor.path, { revealInExplorer: false })
  if (opened) rememberRecentEditor(editor.path)
  return opened
}

export function readRecentEditors(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

export function rememberRecentEditor(path: string) {
  const key = editorPathKey(path)
  const next = [key, ...readRecentEditors().filter((item) => item !== key)].slice(0, RECENT_LIMIT)
  try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore unavailable storage */ }
}
