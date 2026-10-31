<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { buildExternalLinkBridgeScript } from '@/lib/externalLinks'
import { buildHtmlPreviewLongPressScript, isHtmlPreviewLongPressMessage, sendHtmlPreviewPathToChat } from '@/lib/htmlPreviewLongPress'
import { buildHtmlPreviewResourceBridge, inlineHtmlPreviewAssets, HTML_PREVIEW_DOWNLOAD_MESSAGE, HTML_PREVIEW_RESOURCE_ERROR_MESSAGE, HTML_PREVIEW_RESOURCE_MESSAGE, HTML_PREVIEW_RESOURCE_RESULT_MESSAGE, resolveHtmlPreviewResourcePath, saveHtmlPreviewDownload } from '@/lib/htmlPreviewResources'
import { prepareHtmlPreviewScripts } from '@/lib/htmlPreviewScripts'
import { persistHtmlPreviewStorage } from '@/lib/htmlPreviewStorage'
import { HTML_PREVIEW_OPEN_FILE_MESSAGE } from '@/lib/externalLinks'
import { buildProjectEditorBridgeScript } from '@/lib/projectEditorBridge'
import { embeddedFontFaceCss, fontStyleCssVariables } from '@/lib/fontStyles'
import { buildSurfaceVars, getTheme, themeToCssVariables } from '@/lib/theme'
import { backend, onWorkspaceFilesChanged } from '@/lib/tauri'
import { normalizePath } from '@/lib/path'
import { useWorkspaceStore } from '@/stores/workspace'
import { appConfirm } from '@/lib/appDialog'
import { appDataDirectory, knownDataDirectory, resolveEditorPage } from '@/lib/editorCatalog'
import { registerMobileHtmlPreview, replyMobileHtml } from '@/lib/mobileHtmlBridge'
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
const previewFontFaces = ref<string | null>(null)
const assetSource = ref<string | null>(null)
watch(() => [props.tab.path, props.tab.content] as const, async ([path, source], _old, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  assetSource.value = null
  try {
    const html = await inlineHtmlPreviewAssets(source, path, backend, store.workspace?.rootPath)
    if (!cancelled) assetSource.value = html
  } catch (error) {
    if (!cancelled) store.showErrorMessage(`HTML 预览加载失败：${String(error)}`)
  }
}, { immediate: true })
let fontLoadSequence = 0
const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
const editorProjectRoots = ref<string[]>([])
const boundTab = computed(() => {
  const binding = store.projectEditorBindings[normalizePath(props.tab.path).toLowerCase()]
  return binding && store.tabs.find((tab) => normalizePath(tab.path).toLowerCase() === normalizePath(binding.path).toLowerCase())
})
let stopWorkspaceFilesChanged: (() => void) | null = null
let stopMobileHtml: (() => void) | null = null

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

function editorLocation() {
  return resolveEditorPage(props.tab.path, workspaceRoot.value, knownDataDirectory.value, editorProjectRoots.value)
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
      ...fontStyleCssVariables(store.settings.fontStyleId, store.settings.customFonts, store.settings.customFontStyles),
    },
  }
}

const previewSource = computed(() => {
  const theme = currentThemePayload()
  const variables = Object.entries(theme.vars).map(([name, value]) => `${name}:${value};`).join('')
  // iframe 内脚本负责项目编辑器桥与外链桥，外链统一交给主窗口打开。
  const injected = `<style id="superhigh-editor-fonts">${previewFontFaces.value ?? ''}</style><style id="superhigh-editor-theme">:root{color-scheme:${theme.colorScheme};${variables}}</style><style id="superhigh-editor-base">*{box-sizing:border-box}html{font-family:var(--font-ui);font-weight:var(--font-ui-weight)}body{min-height:100vh;margin:0;color:var(--color-text-primary);background:var(--color-bg-primary);font-family:var(--font-ui);font-weight:var(--font-ui-weight)}button,input,select,textarea{font:inherit}textarea,pre,code,.sh-mono{font-family:var(--font-mono);font-weight:var(--font-mono-weight)}.sh-toolbar{display:flex;align-items:center;gap:6px;min-height:40px;padding:5px 8px;overflow-x:auto;border-bottom:1px solid var(--color-border);background:var(--surface-panel-strong)}.sh-panel{border:1px solid var(--color-border);border-radius:4px;background:var(--surface-panel)}.sh-status{padding:6px 8px;color:var(--color-text-secondary);border:1px solid var(--surface-divider-muted);border-radius:4px;background:var(--surface-panel-soft)}</style><script id="superhigh-editor-preview-bridge">${buildProjectEditorBridgeScript()}<\/script><script id="superhigh-external-link-bridge">${buildExternalLinkBridgeScript()}<\/script><script id="superhigh-long-press-bridge">${buildHtmlPreviewLongPressScript()}<\/script><script id="superhigh-resource-bridge">${buildHtmlPreviewResourceBridge(props.tab.path)}<\/script>`
  const source = assetSource.value ?? ''
  return /<head(?:\s[^>]*)?>/i.test(source)
    ? source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injected}`)
    : `${injected}${source}`
})

const previewDocument = computed(() => prepareHtmlPreviewScripts(
  previewSource.value,
  new URL('/html-preview-bootstrap.js', window.location.href).href,
))

function postToPreview(data: unknown) {
  if (data && typeof data === 'object' && replyMobileHtml(data as Record<string, unknown>)) return
  previewFrame.value?.contentWindow?.postMessage(data, '*')
}

function postPreviewContext() {
  postToPreview(currentThemePayload())
  postToPreview({
    type: 'superhigh-editor:context',
    pageId: context.value.pageId,
    codePreviewRoot: context.value.codePreviewRoot,
  })
  postBoundContent()
}

function postBoundContent() {
  const tab = boundTab.value
  const path = tab && workspaceRelativePath(tab.path)
  if (tab?.contentType === 'text' && path) {
    postToPreview({ type: 'superhigh-editor:code-preview-content', path, content: tab.content, isDirty: tab.isDirty })
  }
}

function onPreviewLoad() {
  postPreviewContext()
}

async function loadPreviewContext() {
  const root = workspaceRoot.value
  previewContextLoaded.value = false
  context.value = { pageId: null, codePreviewRoot: null }
  // Restored editor tabs can mount before the workspace has finished loading.
  // Do not create the iframe in that window: its first bridge requests would
  // be dropped while `workspaceRoot` is empty and the page would stay pending.
  if (!root) return
  editorProjectRoots.value = await backend.listExtensionProjectRoots(root, 'editors').catch((error) => {
    store.showErrorMessage(`编辑器项目引用读取失败：${String(error)}`)
    return []
  })
  if (!editorLocation() && !knownDataDirectory.value) await appDataDirectory().catch(() => '')
  const location = editorLocation()
  if (!location || root !== workspaceRoot.value) return
  const { entry } = location

  // 系统编辑器没有清单；全局与项目编辑器读取各自目录的 editor.json。
  const rawManifest = location.scope === 'system' ? '' : await backend.readFile(`${location.directory}/editor.json`).catch(() => '')
  if (entry !== editorLocation()?.entry || root !== workspaceRoot.value) return

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
    codePreviewRoot: page?.codePreviewRoot === undefined ? null : codePreviewRootPath(page.codePreviewRoot),
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

// "." 表示整个工作区可作为代码预览范围
function codePreviewRootPath(value: unknown) {
  return typeof value === 'string' && value.trim() === '.' ? '.' : safeRelativePath(value)
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
      result = await appConfirm(`确定删除“${String(data.path).trim()}”吗？这会直接从磁盘删除。`)
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
      result = await appConfirm(message)
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

async function handleSkillOverviewRequest(data: Record<string, unknown>) {
  if (data.type !== 'superhigh-editor:skill-overview') return false
  if (typeof data.requestId !== 'string') return true
  try {
    const result = await backend.listSkillOverview(workspaceRoot.value || null)
    postToPreview({ type: 'superhigh-editor:skill-overview-result', requestId: data.requestId, result })
  } catch (error) {
    postToPreview({ type: 'superhigh-editor:skill-overview-error', requestId: data.requestId, error: formatError(error) })
  }
  return true
}

async function handleResourceRequest(data: Record<string, unknown>) {
  if (data.type !== HTML_PREVIEW_RESOURCE_MESSAGE) return false
  if (typeof data.requestId !== 'string') return true
  const documentPath = props.tab.path
  const target = previewFrame.value?.contentWindow
  const current = () => documentPath === props.tab.path && target === previewFrame.value?.contentWindow
  try {
    const path = resolveHtmlPreviewResourcePath(props.tab.path, typeof data.path === 'string' ? data.path : '', workspaceRoot.value, data.kind === 'media')
    if (!path) throw new Error('HTML 预览资源不在当前工作区内。')
    const payload = data.kind === 'text' ? { text: await backend.readFile(path) } : { dataUrl: await backend.readMediaAsDataUrl(path) }
    if (!current()) return true
    postToPreview({ type: HTML_PREVIEW_RESOURCE_RESULT_MESSAGE, requestId: data.requestId, ...payload })
  } catch (error) {
    if (!current()) return true
    postToPreview({ type: HTML_PREVIEW_RESOURCE_ERROR_MESSAGE, requestId: data.requestId, error: formatError(error) })
  }
  return true
}

async function handleScriptToolRequest(data: Record<string, unknown>) {
  if (!['superhigh-editor:script-tool', 'superhigh-editor:script-tools'].includes(String(data.type))) return false
  if (typeof data.requestId !== 'string' || !workspaceRoot.value) return true
  try {
    if (data.type === 'superhigh-editor:script-tools') {
      const result = await backend.listProjectScriptTools(workspaceRoot.value, true)
      postToPreview({ type: 'superhigh-editor:script-tools-result', requestId: data.requestId, result })
      return true
    }
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
    postToPreview({ type: `${data.type}-error`, requestId: data.requestId, error: formatError(error) })
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
    if (root !== '.' && !isSameOrChildRelativePath(path, root)) throw new Error('代码预览只能打开该编辑器目录内的文件。')
    if (data.type === 'superhigh-editor:code-preview-set-content') {
      if (typeof data.content !== 'string') throw new Error('代码预览内容必须是文本。')
      if (!store.setScopedCodePreviewContent(workspaceFilePath(path), data.content, { isDirty: data.isDirty === false ? false : true, keepActiveTab: true })) throw new Error('当前文件尚未绑定代码预览。')
    } else {
      const scopePath = root === '.' ? workspaceRoot.value.replace(/[\\/]+$/, '') : workspaceFilePath(root)
      const opened = data.type === 'superhigh-editor:code-preview-bind'
        ? await store.bindScopedCodePreview(workspaceFilePath(path), scopePath, props.tab.path)
        : await store.openScopedCodePreview(workspaceFilePath(path), scopePath, { keepWorkspaceSurface: true, originPath: props.tab.path })
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
  if (persistHtmlPreviewStorage(props.tab.path, event.data)) return
  if (event.data.type === HTML_PREVIEW_OPEN_FILE_MESSAGE) {
    const path = resolveHtmlPreviewResourcePath(props.tab.path, String(event.data.path ?? ''), workspaceRoot.value)
    if (path) await store.openFile(path)
    return
  }
  if (isHtmlPreviewLongPressMessage(event.data)) {
    sendHtmlPreviewPathToChat(props.tab.path)
    return
  }
  if (event.data.type === 'superhigh-editor:toggle-explorer') {
    window.dispatchEvent(new CustomEvent('superhigh:toggle-explorer'))
    return
  }
  if (event.data.type === 'superhigh-editor:toggle-editor-picker') {
    window.dispatchEvent(new CustomEvent('superhigh:toggle-editor-picker'))
    return
  }
  const data = withPageId(event.data as Record<string, unknown>)
  if (data.type === HTML_PREVIEW_DOWNLOAD_MESSAGE) {
    try {
      await saveHtmlPreviewDownload(props.tab.path, data, backend)
    } catch (error) {
      store.showErrorMessage(`HTML 下载失败：${formatError(error)}`)
    }
    return
  }
  if (data.type === 'superhigh-editor:preview-ready' || data.type === 'superhigh-editor:theme-ready') {
    postPreviewContext()
    return
  }
  if (await handleFilesystemRequest(data)) return
  if (await handleResourceRequest(data)) return
  if (await handleUiRequest(data)) return
  if (await handleSkillOverviewRequest(data)) return
  if (await handleScriptToolRequest(data)) return
  if (await handleCodePreviewRequest(data)) return

}

watch(() => [props.tab.path, workspaceRoot.value], () => { void loadPreviewContext() }, { immediate: true })
watch(() => [store.settings.fontStyleId, store.settings.customFonts, store.settings.customFontStyles], async () => {
  const sequence = ++fontLoadSequence
  previewFontFaces.value = null
  try {
    const css = await embeddedFontFaceCss(store.settings.fontStyleId, store.settings.customFonts, store.settings.customFontStyles)
    if (sequence === fontLoadSequence) previewFontFaces.value = css
  } catch (error) {
    if (sequence === fontLoadSequence) store.showErrorMessage(`项目编辑器字体加载失败：${formatError(error)}`)
  }
}, { immediate: true, deep: true })
watch(() => store.settings.themeId, postPreviewContext)
watch(() => [boundTab.value?.path, boundTab.value?.content, boundTab.value?.isDirty], postBoundContent)

onMounted(() => {
  window.addEventListener('superhigh:extension-projects-changed', loadPreviewContext)
  stopMobileHtml = registerMobileHtmlPreview(() => props.tab.path, async () => {
    if (!previewContextLoaded.value) await loadPreviewContext()
    if (previewFontFaces.value === null) previewFontFaces.value = await embeddedFontFaceCss(store.settings.fontStyleId, store.settings.customFonts, store.settings.customFontStyles)
    const tab = boundTab.value
    const path = tab && workspaceRelativePath(tab.path)
    const boundContent = tab?.contentType === 'text' && path ? [{ type: 'superhigh-editor:code-preview-content', path, content: tab.content, isDirty: tab.isDirty }] : []
    return { document: previewDocument.value, contextMessages: [currentThemePayload(), { type: 'superhigh-editor:context', ...context.value }, ...boundContent] }
  }, data => onMessage({ source: previewFrame.value?.contentWindow, data } as MessageEvent))
  window.addEventListener('message', onMessage)
  void onWorkspaceFilesChanged((event) => {
    const root = normalizePath(workspaceRoot.value).replace(/\/+$/, '').toLowerCase()
    if (!root || normalizePath(event.rootPath).replace(/\/+$/, '').toLowerCase() !== root) return
    const paths = (event.changedPaths ?? []).map(workspaceRelativePath).filter((path): path is string => !!path)
    if (paths.length) postToPreview({ type: 'superhigh-editor:workspace-files-changed', paths, kind: event.kind })
  }).then((unlisten) => { stopWorkspaceFilesChanged = unlisten })
})

onBeforeUnmount(() => {
  window.removeEventListener('superhigh:extension-projects-changed', loadPreviewContext)
  stopMobileHtml?.()
  fontLoadSequence++
  stopWorkspaceFilesChanged?.()
  stopWorkspaceFilesChanged = null
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <div class="html-preview-shell">
    <iframe v-if="previewContextLoaded && previewFontFaces !== null && assetSource !== null" ref="previewFrame" class="html-preview-frame" :srcdoc="previewDocument" sandbox="allow-scripts allow-downloads allow-modals" title="SuperHigh HTML 预览" @load="onPreviewLoad" />
  </div>
</template>
