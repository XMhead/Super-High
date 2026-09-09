<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RefreshCw } from 'lucide-vue-next'

import { buildSurfaceVars, getTheme, themeToCssVariables } from '@/lib/theme'
import { buildProjectEditorBridgeScript } from '@/lib/projectEditorBridge'
import { backend, onWorkspaceFilesChanged } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { FileEntry } from '@/types'
import EditorPane from './EditorPane.vue'
import ExplorerPane from './ExplorerPane.vue'

const props = defineProps<{
  embedded?: boolean
}>()

type EditorPageConfig = { id?: unknown; title?: unknown; entry?: unknown; codePreviewRoot?: unknown }
type EditorManifest = { version?: unknown; pages?: unknown }
type LoadedEditorPage = { id: string; title: string; entry: string; content: string; codePreviewRoot: string | null }
type EditorFilesystemRequest = {
  type?: unknown
  requestId?: unknown
  operation?: unknown
  path?: unknown
  content?: unknown
  newPath?: unknown
  pageId?: unknown
}
type EditorUiRequest = {
  type?: unknown
  requestId?: unknown
  operation?: unknown
  message?: unknown
  text?: unknown
  level?: unknown
}
type EditorCodePreviewRequest = {
  type?: unknown
  requestId?: unknown
  path?: unknown
  content?: unknown
  pageId?: unknown
  lineNumber?: unknown
  column?: unknown
  isDirty?: unknown
}
type EditorScriptToolRequest = {
  type?: unknown
  requestId?: unknown
  toolId?: unknown
  values?: unknown
}
type EditorThemePayload = {
  type: 'superhigh-editor:theme'
  themeId: string
  colorScheme: 'dark' | 'light'
  vars: Record<string, string>
}

const store = useWorkspaceStore()
const editorHost = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const error = ref('')
const pages = ref<LoadedEditorPage[]>([])
const activePageId = ref('')
const embeddedExplorerWidth = ref(192)
const embeddedPreviewWidth = ref(360)
const editorMessageListeners = new Set<EventListenerOrEventListenerObject>()
const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
const hasEmbeddedCodePreview = computed(() => !!activePage.value?.codePreviewRoot)
let previewResize: { target: 'preview' | 'explorer'; startX: number; width: number } | null = null
let stopWorkspaceFilesChanged: (() => void) | null = null
let editorReloadTimer: number | null = null

function editorDirectory(rootPath: string) {
  return `${rootPath.replace(/[\\/]+$/, '')}/.superhigh/editor`
}

function isValidEntry(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('.html') && !value.includes('..') && !value.includes('\\') && !value.startsWith('/')
}

function normalizeWorkspaceRelativePath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('文件路径不能为空。')
  const path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!path || path.startsWith('/') || /^[a-zA-Z]:\//.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('项目编辑器只能访问当前工作区内的相对路径。')
  }
  return path
}

function isSameOrChildRelativePath(path: string, root: string) {
  const normalizedPath = path.toLowerCase()
  const normalizedRoot = root.toLowerCase()
  return normalizedPath.startsWith(`${normalizedRoot}/`)
}

function currentThemePayload(): EditorThemePayload {
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

const activePage = computed(() => pages.value.find((page) => page.id === activePageId.value) ?? null)
const activeCodePreviewRootPath = computed(() => {
  const root = activePage.value?.codePreviewRoot
  if (!root || !workspaceRoot.value) return ''
  return `${workspaceRoot.value.replace(/[\\/]+$/, '')}/${root}`
})

function selectRequestedPage() {
  const activeTabPath = store.activeTab?.path.replace(/\\/g, '/').toLowerCase()
  const directory = editorDirectory(workspaceRoot.value).replace(/\\/g, '/').toLowerCase()
  const activePage = activeTabPath
    ? pages.value.find((page) => `${directory}/${page.entry}` === activeTabPath)
    : null
  const requestedPath = store.projectEditorEntryPath?.replace(/\\/g, '/').toLowerCase()
  const requestedPage = activePage ?? (requestedPath
    ? pages.value.find((page) => `${directory}/${page.entry}` === requestedPath)
    : null)
  activePageId.value = requestedPage?.id ?? pages.value[0]?.id ?? ''
}

function syncScopedCodePreview() {
  const rootPath = activeCodePreviewRootPath.value
  if (!rootPath) {
    store.codePreviewScopePath = null
    return
  }
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const activeTab = store.activeTab
  const activeTabMatchesScope = activeTab?.path.replace(/\\/g, '/').toLowerCase().startsWith(`${normalizedRoot}/`)
  store.codePreviewScopePath = rootPath
  if (activeTabMatchesScope) return
  store.activeTabId = store.tabs.find((tab) => tab.path.replace(/\\/g, '/').toLowerCase().startsWith(`${normalizedRoot}/`))?.id ?? null
}

const projectDocument = computed(() => {
  const page = activePage.value
  if (!page) return ''
  const theme = currentThemePayload()
  const variables = Object.entries(theme.vars).map(([name, value]) => `${name}:${value};`).join('')
  const injected = `<style id="superhigh-editor-theme">:root{color-scheme:${theme.colorScheme};${variables}}</style><style id="superhigh-editor-base">*{box-sizing:border-box}body{min-height:100vh;margin:0;color:var(--color-text-primary);background:var(--color-bg-primary);font-family:var(--font-ui)}button,input,select,textarea{font:inherit}textarea,pre,code,.sh-mono{font-family:var(--font-mono)}.sh-toolbar{display:flex;align-items:center;gap:6px;min-height:40px;padding:5px 8px;overflow-x:auto;border-bottom:1px solid var(--color-border);background:var(--surface-panel-strong)}.sh-panel{border:1px solid var(--color-border);border-radius:4px;background:var(--surface-panel)}.sh-status{padding:6px 8px;color:var(--color-text-secondary);border:1px solid var(--surface-divider-muted);border-radius:4px;background:var(--surface-panel-soft)}</style>`
  return /<head(?:\s[^>]*)?>/i.test(page.content)
    ? page.content.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injected}`)
    : `${injected}${page.content}`
})

function mountProjectDocument() {
  const host = editorHost.value
  if (!host || !projectDocument.value) return
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  editorMessageListeners.clear()
  const page = new DOMParser().parseFromString(projectDocument.value, 'text/html')
  const scripts = Array.from(page.scripts)
  const content = document.createDocumentFragment()

  for (const node of [...Array.from(page.head.children), ...Array.from(page.body.children)]) {
    if (node.tagName === 'SCRIPT') continue
    const copy = node.cloneNode(true) as HTMLElement
    if (copy.tagName === 'STYLE') copy.textContent = copy.textContent?.replace(/(^|[},])(\s*)body(?=\s*(?:[,{]))/g, '$1$2:host') ?? ''
    content.append(copy)
  }
  shadow.replaceChildren(content)

  const editorDocument = {
    getElementById: (id: string) => shadow.querySelector(`#${CSS.escape(id)}`),
    querySelector: shadow.querySelector.bind(shadow),
    querySelectorAll: shadow.querySelectorAll.bind(shadow),
    createElement: document.createElement.bind(document),
    execCommand: document.execCommand.bind(document),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      if (type === 'DOMContentLoaded') queueMicrotask(() => typeof listener === 'function' ? listener(new Event(type)) : listener.handleEvent(new Event(type)))
      else shadow.addEventListener(type, listener, options)
    },
  }
  const editorWindow = {
    parent: {
      postMessage: (data: unknown) => {
        const message = data && typeof data === 'object' && !Array.isArray(data)
          ? { pageId: activePageId.value, ...(data as Record<string, unknown>) }
          : data
        void onMessage({ data: message } as MessageEvent)
      },
    },
    prompt: window.prompt.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    crypto: window.crypto,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      if (type === 'message') editorMessageListeners.add(listener)
      else window.addEventListener(type, listener, options)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
      if (type === 'message') editorMessageListeners.delete(listener)
      else window.removeEventListener(type, listener, options)
    },
  }
  new Function('window', buildProjectEditorBridgeScript())(editorWindow)
  for (const script of scripts) new Function('document', 'window', script.textContent ?? '')(editorDocument, editorWindow)
  publishCodePreviewContent()
}

function postToProjectEditor(data: unknown) {
  const event = { data } as MessageEvent
  for (const listener of editorMessageListeners) {
    if (typeof listener === 'function') listener(event)
    else listener.handleEvent(event)
  }
}

function workspaceRelativePath(path: string) {
  const root = workspaceRoot.value.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const normalizedPath = path.replace(/\\/g, '/')
  if (!root || !normalizedPath.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null
  return normalizedPath.slice(root.length + 1)
}

function publishCodePreviewContent() {
  const page = activePage.value
  const tab = store.activeTab
  if (!page?.codePreviewRoot || !tab || tab.contentType !== 'text') return
  const path = workspaceRelativePath(tab.path)
  if (!path || !isSameOrChildRelativePath(path, page.codePreviewRoot)) return
  postToProjectEditor({ type: 'superhigh-editor:code-preview-content', path, content: tab.content, isDirty: tab.isDirty })
}

async function openScopedPreviewFile(path: string) {
  const rootPath = activeCodePreviewRootPath.value
  if (!rootPath) return
  const opened = await store.openScopedCodePreview(path, rootPath, { keepWorkspaceSurface: true })
  if (opened) await store.revealPathInExplorer(path)
}

async function openScopedExplorerFile(entry: FileEntry) {
  await openScopedPreviewFile(entry.path)
}

function startPreviewResize(event: PointerEvent) {
  startPanelResize('preview', event)
}

function startExplorerResize(event: PointerEvent) {
  startPanelResize('explorer', event)
}

function startPanelResize(target: 'preview' | 'explorer', event: PointerEvent) {
  event.preventDefault()
  previewResize = {
    target,
    startX: event.clientX,
    width: props.embedded
      ? (target === 'preview' ? embeddedPreviewWidth.value : embeddedExplorerWidth.value)
      : (target === 'preview' ? store.settings.panelLayout.previewWidth : store.settings.panelLayout.explorerWidth),
  }
  document.documentElement.classList.add('is-resizing-panels')
  window.addEventListener('pointermove', resizePreview)
  window.addEventListener('pointerup', stopPreviewResize)
}

function resizePreview(event: PointerEvent) {
  if (!previewResize) return
  const width = previewResize.width + event.clientX - previewResize.startX
  if (props.embedded) {
    if (previewResize.target === 'preview') embeddedPreviewWidth.value = Math.max(140, Math.min(560, width))
    else embeddedExplorerWidth.value = Math.max(160, Math.min(320, width))
    return
  }
  store.setPanelLayoutSize(previewResize.target === 'preview' ? 'previewWidth' : 'explorerWidth', width)
}

function stopPreviewResize() {
  if (!previewResize) return
  previewResize = null
  document.documentElement.classList.remove('is-resizing-panels')
  window.removeEventListener('pointermove', resizePreview)
  window.removeEventListener('pointerup', stopPreviewResize)
  if (!props.embedded) void store.saveSettings()
}

function scheduleProjectEditorReload() {
  if (editorReloadTimer !== null) window.clearTimeout(editorReloadTimer)
  editorReloadTimer = window.setTimeout(() => {
    editorReloadTimer = null
    void loadProjectEditor()
  }, 120)
}

watch(projectDocument, () => { void nextTick(mountProjectDocument) }, { flush: 'post' })
watch(() => [activePageId.value, store.activeTabId, store.activeTab?.path, store.activeTab?.content, store.activeTab?.isDirty], () => {
  publishCodePreviewContent()
}, { flush: 'post' })

async function loadProjectEditor() {
  const rootPath = workspaceRoot.value
  pages.value = []
  error.value = ''
  if (!rootPath) return

  loading.value = true
  try {
    const directory = editorDirectory(rootPath)
    const raw = await backend.readFile(`${directory}/editor.json`)
    const manifest = JSON.parse(raw) as EditorManifest
    if (manifest.version !== 1 || !Array.isArray(manifest.pages)) throw new Error('editor.json 必须是 version: 1，并包含 pages 数组。')
    const configuredPages = manifest.pages.filter((page): page is EditorPageConfig => !!page && typeof page === 'object')
    const nextPages = await Promise.all(configuredPages.map(async (page) => {
      if (typeof page.id !== 'string' || !page.id.trim() || typeof page.title !== 'string' || !page.title.trim() || !isValidEntry(page.entry)) {
        throw new Error('每个页面必须包含 id、title 和同目录下的 .html entry。')
      }
      const codePreviewRoot = page.codePreviewRoot === undefined ? null : normalizeWorkspaceRelativePath(page.codePreviewRoot)
      return {
        id: page.id.trim(),
        title: page.title.trim(),
        entry: page.entry,
        content: await backend.readFile(`${directory}/${page.entry}`),
        codePreviewRoot,
      }
    }))
    pages.value = nextPages
    selectRequestedPage()
  } catch (loadError) {
    error.value = `未加载项目编辑器：${formatError(loadError)}`
  } finally {
    loading.value = false
  }
}

function workspaceFilePath(relativePath: unknown) {
  const path = normalizeWorkspaceRelativePath(relativePath)
  return `${workspaceRoot.value.replace(/[\\/]+$/, '')}/${path}`
}

async function handleEditorFilesystemRequest(data: EditorFilesystemRequest) {
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
    } else if (data.operation === 'read') {
      result = await backend.readFile(path)
    } else if (data.operation === 'read-data-url') {
      result = await backend.readMediaAsDataUrl(path)
    } else if (data.operation === 'write' && typeof data.content === 'string') {
      await backend.writeFile(path, data.content)
      result = true
    } else if (data.operation === 'mkdir') {
      await backend.createDirectory(path)
      result = true
    } else if (data.operation === 'rename') {
      await backend.renamePath(path, workspaceFilePath(data.newPath))
      result = true
    } else if (data.operation === 'delete') {
      if (!window.confirm(`确定删除“${String(data.path).trim()}”吗？这会直接从磁盘删除。`)) {
        result = false
      } else {
        await backend.deletePath(path)
        result = true
      }
    } else {
      throw new Error('不支持的项目编辑器文件操作。')
    }
    postToProjectEditor({ type: 'superhigh-editor:fs-result', requestId: data.requestId, result })
  } catch (requestError) {
    postToProjectEditor({ type: 'superhigh-editor:fs-error', requestId: data.requestId, error: formatError(requestError) })
  }
  return true
}

async function handleEditorUiRequest(data: EditorUiRequest) {
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
      if (typeof data.text !== 'string') throw new Error('复制内容必须是文本。')
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持写入剪贴板。')
      await navigator.clipboard.writeText(data.text)
      result = true
    } else {
      throw new Error('不支持的项目编辑器原生交互。')
    }
    postToProjectEditor({ type: 'superhigh-editor:ui-result', requestId: data.requestId, result })
  } catch (requestError) {
    postToProjectEditor({ type: 'superhigh-editor:ui-error', requestId: data.requestId, error: formatError(requestError) })
  }
  return true
}

async function handleEditorScriptToolRequest(data: EditorScriptToolRequest) {
  if (data.type !== 'superhigh-editor:script-tool') return false
  if (typeof data.requestId !== 'string' || !workspaceRoot.value) return true

  try {
    if (typeof data.toolId !== 'string' || !data.toolId.trim()) throw new Error('脚本工具 ID 不能为空。')
    if (!data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
      throw new Error('脚本工具参数必须是对象。')
    }
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(data.values as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`脚本工具参数必须是文本：${key}`)
      values[key] = value
    }
    const result = await backend.runProjectScriptTool(workspaceRoot.value, data.toolId.trim(), values)
    postToProjectEditor({ type: 'superhigh-editor:script-tool-result', requestId: data.requestId, result })
  } catch (requestError) {
    postToProjectEditor({ type: 'superhigh-editor:script-tool-error', requestId: data.requestId, error: formatError(requestError) })
  }
  return true
}

async function handleEditorCodePreviewRequest(data: EditorCodePreviewRequest) {
  if (!['superhigh-editor:code-preview', 'superhigh-editor:code-preview-bind', 'superhigh-editor:code-preview-set-content'].includes(String(data.type))) return false
  if (typeof data.pageId !== 'string' || !workspaceRoot.value) return true

  try {
    const page = pages.value.find((item) => item.id === data.pageId)
    if (!page?.codePreviewRoot) throw new Error('此编辑器页面未配置代码预览目录。')
    const relativePath = normalizeWorkspaceRelativePath(data.path)
    if (!isSameOrChildRelativePath(relativePath, page.codePreviewRoot)) {
      throw new Error('代码预览只能打开该编辑器目录内的文件。')
    }
    if (data.type === 'superhigh-editor:code-preview-set-content') {
      if (typeof data.content !== 'string') throw new Error('代码预览内容必须是文本。')
      const updated = store.setScopedCodePreviewContent(workspaceFilePath(relativePath), data.content, {
        isDirty: data.isDirty === false ? false : true,
      })
      if (!updated) throw new Error('当前文件尚未绑定代码预览。')
      if (typeof data.requestId === 'string') {
        postToProjectEditor({ type: 'superhigh-editor:code-preview-result', requestId: data.requestId, result: true })
      }
      return true
    }
    const opened = await store.openScopedCodePreview(
      workspaceFilePath(relativePath),
      workspaceFilePath(page.codePreviewRoot),
      { keepWorkspaceSurface: data.type === 'superhigh-editor:code-preview-bind' },
    )
    if (!opened) throw new Error('无法打开代码预览文件。')
    await store.revealPathInExplorer(workspaceFilePath(relativePath))
    if (Number.isFinite(Number(data.lineNumber)) || Number.isFinite(Number(data.column))) {
      window.dispatchEvent(new CustomEvent('superhigh:reveal-editor-position', {
        detail: {
          path: workspaceFilePath(relativePath),
          lineNumber: Math.max(1, Number(data.lineNumber) || 1),
          column: Math.max(1, Number(data.column) || 1),
        },
      }))
    }
    if (typeof data.requestId === 'string') {
      postToProjectEditor({ type: 'superhigh-editor:code-preview-result', requestId: data.requestId, result: true })
    }
  } catch (requestError) {
    if (typeof data.requestId === 'string') {
      postToProjectEditor({ type: 'superhigh-editor:code-preview-error', requestId: data.requestId, error: formatError(requestError) })
    }
  }
  return true
}

async function onMessage(event: MessageEvent) {
  const data = event.data as EditorFilesystemRequest & EditorCodePreviewRequest & EditorUiRequest & EditorScriptToolRequest
  if (data?.type === 'superhigh-editor:navigate' && typeof data.pageId === 'string' && pages.value.some((page) => page.id === data.pageId)) {
    activePageId.value = data.pageId
    return
  }
  if (await handleEditorFilesystemRequest(data)) return
  if (await handleEditorUiRequest(data)) return
  if (await handleEditorScriptToolRequest(data)) return
  if (await handleEditorCodePreviewRequest(data)) return
}

function formatError(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

watch(workspaceRoot, () => { void loadProjectEditor() }, { immediate: true })
watch(() => store.projectEditorEntryPath, selectRequestedPage)
watch(activePageId, (pageId) => {
  const page = pages.value.find((item) => item.id === pageId)
  if (!page || !workspaceRoot.value) return
  store.projectEditorEntryPath = `${editorDirectory(workspaceRoot.value)}/${page.entry}`
})
watch([activePageId, activeCodePreviewRootPath], syncScopedCodePreview)
onMounted(() => {
  window.addEventListener('message', onMessage)
  void onWorkspaceFilesChanged((event) => {
    const root = workspaceRoot.value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
    if (!root || event.rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== root) return
    const relativePaths = (event.changedPaths ?? [])
      .map((path) => workspaceRelativePath(path))
      .filter((path): path is string => !!path)
    const editorPaths = new Set([
      '.superhigh/editor/editor.json',
      ...pages.value.map((page) => `.superhigh/editor/${page.entry}`),
    ].map((path) => path.toLowerCase()))
    if (relativePaths.some((path) => editorPaths.has(path.toLowerCase()))) scheduleProjectEditorReload()
    if (relativePaths.length) postToProjectEditor({ type: 'superhigh-editor:workspace-files-changed', paths: relativePaths, kind: event.kind })
  }).then((unlisten) => { stopWorkspaceFilesChanged = unlisten })
  void nextTick(mountProjectDocument)
})
onBeforeUnmount(() => {
  stopPreviewResize()
  stopWorkspaceFilesChanged?.()
  stopWorkspaceFilesChanged = null
  if (editorReloadTimer !== null) window.clearTimeout(editorReloadTimer)
  editorReloadTimer = null
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <section class="project-editor-panel" :class="{ embedded: props.embedded }" aria-label="编辑器预览">
    <div v-if="pages.length > 1" class="project-editor-tabs">
      <nav class="project-editor-page-tabs" aria-label="项目编辑器页面">
        <button
          v-for="page in pages"
          :key="page.id"
          class="project-editor-tab"
          :class="{ active: page.id === activePageId }"
          type="button"
          :aria-current="page.id === activePageId ? 'page' : undefined"
          @click="activePageId = page.id"
        >
          {{ page.title }}
        </button>
      </nav>
      <button class="ghost-button small project-editor-refresh" type="button" title="刷新页面" aria-label="刷新页面" :disabled="loading" @click="loadProjectEditor">
        <RefreshCw :size="13" :class="{ spinning: loading }" />
      </button>
    </div>
    <div class="project-editor-body" :class="{ 'with-code-preview': hasEmbeddedCodePreview, embedded: props.embedded }">
      <ExplorerPane
        v-if="!error && projectDocument && hasEmbeddedCodePreview"
        class="project-editor-explorer"
        :root-path="activeCodePreviewRootPath"
        :title="activePage?.title ? `${activePage.title} 文件` : '资源管理器'"
        searchable
        custom-file-open
        @file-open="openScopedExplorerFile"
      />
      <div
        v-if="!error && projectDocument && hasEmbeddedCodePreview"
        class="project-editor-resizer"
        role="separator"
        aria-label="调整资源管理器宽度"
        @pointerdown="startExplorerResize"
      />
      <div v-if="!error && projectDocument && hasEmbeddedCodePreview" class="project-editor-code-preview">
        <EditorPane :on-breadcrumb-file-open="openScopedPreviewFile" />
      </div>
      <div
        v-if="!error && projectDocument && hasEmbeddedCodePreview"
        class="project-editor-resizer"
        role="separator"
        aria-label="调整代码预览宽度"
        aria-orientation="vertical"
        :aria-valuemin="props.embedded ? 140 : 340"
        :aria-valuemax="props.embedded ? 560 : 1040"
        :aria-valuenow="props.embedded ? embeddedPreviewWidth : store.settings.panelLayout.previewWidth"
        @pointerdown="startPreviewResize"
      />
      <div v-if="!error && projectDocument" ref="editorHost" class="project-editor-frame" aria-label="项目编辑器页面" />
      <div v-else class="project-editor-empty">
        <div class="panel-title">{{ error ? '项目编辑器不可用' : loading ? '正在加载项目编辑器' : '尚未添加编辑器页面' }}</div>
        <div v-if="error" class="dialog-subtitle">{{ error }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.project-editor-panel { grid-column: 2 / -1; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; border-left: 1px solid var(--color-border); background: var(--color-bg-primary); }
.project-editor-panel.embedded { grid-column: auto; border: 0; }
.project-editor-tabs { display: flex; flex: none; align-items: center; min-height: 36px; border-bottom: 1px solid var(--color-border); background: var(--surface-panel); }
.project-editor-page-tabs { display: flex; flex: 1; min-width: 0; align-self: stretch; overflow-x: auto; }
.project-editor-tabs > .ghost-button { flex: none; margin: 0 6px; }
.project-editor-refresh { width: 28px; min-width: 28px; padding: 0; }
.project-editor-tab { flex: none; min-height: 36px; padding: 0 12px; border: 0; border-bottom: 2px solid transparent; color: var(--color-text-secondary); background: transparent; font: inherit; cursor: pointer; }
.project-editor-tab:hover { color: var(--color-text-primary); background: var(--color-bg-hover); }
.project-editor-tab.active { border-bottom-color: var(--color-accent-blue); color: var(--color-text-primary); background: var(--surface-panel-strong); }
.project-editor-body { position: relative; flex: 1; min-height: 0; }
.project-editor-body.with-code-preview { display: grid; grid-template-columns: minmax(160px, v-bind('store.settings.panelLayout.explorerWidth + "px"')) 6px minmax(360px, v-bind('store.settings.panelLayout.previewWidth + "px"')) 6px minmax(320px, 1fr); }
.project-editor-body.with-code-preview.embedded { grid-template-columns: minmax(160px, v-bind('embeddedExplorerWidth + "px"')) 6px minmax(140px, v-bind('embeddedPreviewWidth + "px"')) 6px minmax(320px, 1fr); }
.project-editor-frame { width: 100%; height: 100%; min-width: 0; border: 0; background: var(--color-bg-primary); }
.project-editor-resizer { cursor: col-resize; background: var(--surface-divider-muted); touch-action: none; }
.project-editor-resizer:hover { background: var(--color-accent-blue); }
.project-editor-code-preview { min-width: 0; min-height: 0; overflow: hidden; border-right: 1px solid var(--color-border); }
.project-editor-code-preview :deep(.editor-panel) { height: 100%; border: 0; }
.project-editor-explorer { min-width: 0; min-height: 0; border: 0; }
.project-editor-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px; color: var(--color-text-muted); text-align: center; }
.spinning { animation: project-editor-spin 1s linear infinite; }
@keyframes project-editor-spin { to { transform: rotate(360deg); } }
</style>
