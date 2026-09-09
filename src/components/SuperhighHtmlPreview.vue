<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { buildExternalLinkBridgeScript } from '@/lib/externalLinks'
import { buildProjectEditorBridgeScript } from '@/lib/projectEditorBridge'
import { buildSurfaceVars, getTheme, themeToCssVariables } from '@/lib/theme'
import { backend, onWorkspaceFilesChanged } from '@/lib/tauri'
import { normalizePath } from '@/lib/path'
import { useWorkspaceStore } from '@/stores/workspace'
import type { EditorTab } from '@/types'

const props = defineProps<{
  tab: EditorTab
}>()

type EditorPageConfig = { id?: unknown; entry?: unknown; codePreviewRoot?: unknown }
type EditorManifest = { version?: unknown; pages?: unknown }
type PreviewContext = { pageId: string | null; codePreviewRoot: string | null }

const store = useWorkspaceStore()
const previewFrame = ref<HTMLIFrameElement | null>(null)
const context = ref<PreviewContext>({ pageId: null, codePreviewRoot: null })
const previewContextLoaded = ref(false)
const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
let stopWorkspaceFilesChanged: (() => void) | null = null

function normalizeWorkspaceRelativePath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('文件路径不能为空。')
  const path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!path || path.startsWith('/') || /^[a-zA-Z]:\//.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('项目编辑器只能访问当前工作区内的相对路径。')
  }
  return path
}

function isSameOrChildRelativePath(path: string, root: string) {
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
}

function workspaceRelativePath(path: string) {
  const root = normalizePath(workspaceRoot.value).replace(/\/+$/, '')
  const normalizedPath = normalizePath(path)
  if (!root || !normalizedPath.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null
  return normalizedPath.slice(root.length + 1)
}

function workspaceFilePath(relativePath: unknown) {
  return `${workspaceRoot.value.replace(/[\\/]+$/, '')}/${normalizeWorkspaceRelativePath(relativePath)}`
}

function editorEntryPath() {
  const relativePath = workspaceRelativePath(props.tab.path)
  const prefix = '.superhigh/editor/'
  if (!relativePath || !relativePath.toLowerCase().startsWith(prefix)) return null
  return relativePath.slice(prefix.length)
}

function editorDirectory() {
  return `${workspaceRoot.value.replace(/[\\/]+$/, '')}/.superhigh/editor`
}

function currentThemePayload() {
  const theme = getTheme(store.settings.themeId)
  return {
    type: 'superhigh-editor:theme',
    themeId: theme.id,
    colorScheme: theme.type,
    vars: {
      ...themeToCssVariables(theme),
      ...buildSurfaceVars(theme.id),
      '--font-ui': '"Segoe UI", "Microsoft YaHei UI", sans-serif',
      '--font-mono': '"Cascadia Code", Consolas, "SF Mono", monospace',
    },
  }
}

const previewDocument = computed(() => {
  const theme = currentThemePayload()
  const variables = Object.entries(theme.vars).map(([name, value]) => `${name}:${value};`).join('')
  // iframe 内脚本负责项目编辑器桥与外链桥，外链统一交给主窗口打开。
  const injected = `<style id="superhigh-editor-theme">:root{color-scheme:${theme.colorScheme};${variables}}</style><style id="superhigh-editor-base">*{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--color-text-primary);background:var(--color-bg-primary);font-family:var(--font-ui)}button,input,select,textarea{font:inherit}textarea,pre,code,.sh-mono{font-family:var(--font-mono)}.sh-toolbar{display:flex;align-items:center;gap:6px;min-height:40px;padding:5px 8px;overflow-x:auto;border-bottom:1px solid var(--color-border);background:var(--surface-panel-strong)}.sh-panel{border:1px solid var(--color-border);border-radius:4px;background:var(--surface-panel)}.sh-status{padding:6px 8px;color:var(--color-text-secondary);border:1px solid var(--surface-divider-muted);border-radius:4px;background:var(--surface-panel-soft)}</style><script id="superhigh-editor-preview-bridge">${buildProjectEditorBridgeScript()}<\/script><script id="superhigh-external-link-bridge">${buildExternalLinkBridgeScript()}<\/script>`
  return /<head(?:\s[^>]*)?>/i.test(props.tab.content)
    ? props.tab.content.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injected}`)
    : `${injected}${props.tab.content}`
})

function postToPreview(data: unknown) {
  previewFrame.value?.contentWindow?.postMessage(data, '*')
}

function postPreviewContext() {
  postToPreview(currentThemePayload())
  postToPreview({
    type: 'superhigh-editor:context',
    pageId: context.value.pageId,
    codePreviewRoot: context.value.codePreviewRoot,
  })
}

function onPreviewLoad() {
  postPreviewContext()
}

async function loadPreviewContext() {
  const entry = editorEntryPath()
  const root = workspaceRoot.value
  previewContextLoaded.value = false
  context.value = { pageId: null, codePreviewRoot: null }
  if (!entry || !root) {
    previewContextLoaded.value = true
    return
  }

  const rawManifest = await backend.readFile(`${editorDirectory()}/editor.json`).catch(() => '')
  if (entry !== editorEntryPath() || root !== workspaceRoot.value) return

  let page: EditorPageConfig | null = null
  try {
    const manifest = JSON.parse(rawManifest) as EditorManifest
    if (manifest.version === 1 && Array.isArray(manifest.pages)) {
      page = manifest.pages.find((item): item is EditorPageConfig => (
        !!item
        && typeof item === 'object'
        && typeof item.entry === 'string'
        && item.entry.replace(/\\/g, '/').toLowerCase() === entry.toLowerCase()
      )) ?? null
    }
  } catch {
    // The HTML itself remains previewable when no project-editor manifest is present.
  }
  context.value = {
    pageId: typeof page?.id === 'string' && page.id.trim() ? page.id.trim() : null,
    codePreviewRoot: page?.codePreviewRoot === undefined ? null : safeRelativePath(page.codePreviewRoot),
  }
  previewContextLoaded.value = true
  postPreviewContext()
}

function safeRelativePath(value: unknown) {
  try {
    return normalizeWorkspaceRelativePath(value)
  } catch {
    return null
  }
}

function formatError(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

function withPageId(data: Record<string, unknown>) {
  return context.value.pageId && typeof data.pageId !== 'string' ? { ...data, pageId: context.value.pageId } : data
}

async function handleFilesystemRequest(data: Record<string, unknown>) {
  if (data.type !== 'superhigh-editor:fs') return false
  if (typeof data.requestId !== 'string' || typeof data.operation !== 'string' || !workspaceRoot.value) return true
  try {
    const path = workspaceFilePath(data.path)
    let result: unknown
    if (data.operation === 'list') {
      const listing = await backend.listDirectory(path)
      result = {
        path: String(data.path).trim().replace(/\\/g, '/'),
        entries: listing.entries.map(({ name, type, extension }) => ({ name, type, extension })),
      }
    } else if (data.operation === 'read') result = await backend.readFile(path)
    else if (data.operation === 'read-data-url') result = await backend.readMediaAsDataUrl(path)
    else if (data.operation === 'write' && typeof data.content === 'string') {
      await backend.writeFile(path, data.content)
      result = true
    } else if (data.operation === 'mkdir') {
      await backend.createDirectory(path)
      result = true
    } else if (data.operation === 'rename') {
      await backend.renamePath(path, workspaceFilePath(data.newPath))
      result = true
    } else if (data.operation === 'delete') {
      result = window.confirm(`确定删除“${String(data.path).trim()}”吗？这会直接从磁盘删除。`)
      if (result) await backend.deletePath(path)
    } else throw new Error('不支持的项目编辑器文件操作。')
    postToPreview({ type: 'superhigh-editor:fs-result', requestId: data.requestId, result })
  } catch (error) {
    postToPreview({ type: 'superhigh-editor:fs-error', requestId: data.requestId, error: formatError(error) })
  }
  return true
}

async function handleUiRequest(data: Record<string, unknown>) {
  if (data.type !== 'superhigh-editor:ui') return false
  if (typeof data.requestId !== 'string' || typeof data.operation !== 'string') return true
  try {
    const message = typeof data.message === 'string' ? data.message.trim() : ''
    let result: unknown
    if (data.operation === 'toast') {
      if (!message) throw new Error('提示内容不能为空。')
      if (data.level === 'error') store.showErrorMessage(message)
      else store.showActivityMessage(message)
      result = true
    } else if (data.operation === 'confirm') {
      if (!message) throw new Error('确认内容不能为空。')
      result = window.confirm(message)
    } else if (data.operation === 'copy') {
      if (typeof data.text !== 'string' || !navigator.clipboard?.writeText) throw new Error('当前环境不支持写入剪贴板。')
      await navigator.clipboard.writeText(data.text)
      result = true
    } else throw new Error('不支持的项目编辑器原生交互。')
    postToPreview({ type: 'superhigh-editor:ui-result', requestId: data.requestId, result })
  } catch (error) {
    postToPreview({ type: 'superhigh-editor:ui-error', requestId: data.requestId, error: formatError(error) })
  }
  return true
}

async function handleScriptToolRequest(data: Record<string, unknown>) {
  if (data.type !== 'superhigh-editor:script-tool') return false
  if (typeof data.requestId !== 'string' || !workspaceRoot.value) return true
  try {
    if (typeof data.toolId !== 'string' || !data.toolId.trim()) throw new Error('脚本工具 ID 不能为空。')
    if (!data.values || typeof data.values !== 'object' || Array.isArray(data.values)) throw new Error('脚本工具参数必须是对象。')
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(data.values as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`脚本工具参数必须是文本：${key}`)
      values[key] = value
    }
    const result = await backend.runProjectScriptTool(workspaceRoot.value, data.toolId.trim(), values)
    postToPreview({ type: 'superhigh-editor:script-tool-result', requestId: data.requestId, result })
  } catch (error) {
    postToPreview({ type: 'superhigh-editor:script-tool-error', requestId: data.requestId, error: formatError(error) })
  }
  return true
}

async function handleCodePreviewRequest(data: Record<string, unknown>) {
  if (!['superhigh-editor:code-preview', 'superhigh-editor:code-preview-bind', 'superhigh-editor:code-preview-set-content'].includes(String(data.type))) return false
  if (!workspaceRoot.value) return true
  const requestId = typeof data.requestId === 'string' ? data.requestId : null
  try {
    const root = context.value.codePreviewRoot
    if (!root) throw new Error('此编辑器页面未配置代码预览目录。')
    const path = normalizeWorkspaceRelativePath(data.path)
    if (!isSameOrChildRelativePath(path, root)) throw new Error('代码预览只能打开该编辑器目录内的文件。')
    if (data.type === 'superhigh-editor:code-preview-set-content') {
      if (typeof data.content !== 'string') throw new Error('代码预览内容必须是文本。')
      if (!store.setScopedCodePreviewContent(workspaceFilePath(path), data.content, { isDirty: data.isDirty === false ? false : true })) throw new Error('当前文件尚未绑定代码预览。')
    } else {
      const opened = await store.openScopedCodePreview(workspaceFilePath(path), workspaceFilePath(root), { keepWorkspaceSurface: true })
      if (!opened) throw new Error('无法打开代码预览文件。')
      await store.revealPathInExplorer(workspaceFilePath(path))
      if (Number.isFinite(Number(data.lineNumber)) || Number.isFinite(Number(data.column))) {
        window.dispatchEvent(new CustomEvent('superhigh:reveal-editor-position', {
          detail: {
            path: workspaceFilePath(path),
            lineNumber: Math.max(1, Number(data.lineNumber) || 1),
            column: Math.max(1, Number(data.column) || 1),
          },
        }))
      }
    }
    if (requestId) postToPreview({ type: 'superhigh-editor:code-preview-result', requestId, result: true })
  } catch (error) {
    if (requestId) postToPreview({ type: 'superhigh-editor:code-preview-error', requestId, error: formatError(error) })
  }
  return true
}

async function onMessage(event: MessageEvent) {
  if (event.source !== previewFrame.value?.contentWindow || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return
  const data = withPageId(event.data as Record<string, unknown>)
  if (data.type === 'superhigh-editor:preview-ready' || data.type === 'superhigh-editor:theme-ready') {
    postPreviewContext()
    return
  }
  if (await handleFilesystemRequest(data)) return
  if (await handleUiRequest(data)) return
  if (await handleScriptToolRequest(data)) return
  if (await handleCodePreviewRequest(data)) return
}

watch(() => [props.tab.path, workspaceRoot.value], () => { void loadPreviewContext() }, { immediate: true })
watch(() => store.settings.themeId, postPreviewContext)

onMounted(() => {
  window.addEventListener('message', onMessage)
  void onWorkspaceFilesChanged((event) => {
    const root = normalizePath(workspaceRoot.value).replace(/\/+$/, '').toLowerCase()
    if (!root || normalizePath(event.rootPath).replace(/\/+$/, '').toLowerCase() !== root) return
    const paths = (event.changedPaths ?? []).map(workspaceRelativePath).filter((path): path is string => !!path)
    if (paths.length) postToPreview({ type: 'superhigh-editor:workspace-files-changed', paths, kind: event.kind })
  }).then((unlisten) => { stopWorkspaceFilesChanged = unlisten })
})

onBeforeUnmount(() => {
  stopWorkspaceFilesChanged?.()
  stopWorkspaceFilesChanged = null
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <div class="html-preview-shell">
    <iframe v-if="previewContextLoaded" ref="previewFrame" class="html-preview-frame" :srcdoc="previewDocument" sandbox="allow-scripts" title="SuperHigh HTML 预览" @load="onPreviewLoad" />
  </div>
</template>
