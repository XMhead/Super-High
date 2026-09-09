<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { renderMarkdown } from '@/lib/markdown'
import { findScriptToolFileReferences, resolveScriptToolWorkspaceFile } from '@/lib/scriptToolOutput'
import { buildSurfaceVars, getTheme, themeToCssVariables } from '@/lib/theme'
import { backend } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ScriptToolDescriptor, ScriptToolRunResponse } from '@/types'

const props = defineProps<{ tool: ScriptToolDescriptor }>()

const store = useWorkspaceStore()
const extensionHost = ref<HTMLDivElement | null>(null)
const content = ref('')
const error = ref('')
const workspaceRoot = computed(() => store.workspace?.rootPath ?? '')
const outputClickBound = new WeakSet<HTMLElement>()

const extensionDocument = computed(() => {
  if (!content.value) return ''
  const theme = getTheme(store.settings.themeId)
  const variables = Object.entries({
    ...themeToCssVariables(theme),
    ...buildSurfaceVars(theme.id),
    '--font-ui': '"Segoe UI", "Microsoft YaHei UI", sans-serif',
    '--font-mono': '"Cascadia Code", Consolas, "SF Mono", monospace',
  }).map(([name, value]) => `${name}:${value};`).join('')
  const injected = `<style>:host{display:block;min-height:100%;color:var(--color-text-primary);background:var(--color-bg-primary);font-family:var(--font-ui)}*{box-sizing:border-box}button,input,select,textarea{font:inherit}textarea,pre,code,.sh-mono{font-family:var(--font-mono)}.sh-panel{border:1px solid var(--color-border);border-radius:4px;background:var(--surface-panel)}.sh-status{padding:6px 8px;color:var(--color-text-secondary);border:1px solid var(--surface-divider-muted);border-radius:4px;background:var(--surface-panel-soft)}.sh-markdown{color:var(--color-text-primary);font-size:12px;line-height:1.6}.sh-markdown>:first-child{margin-top:0}.sh-markdown>:last-child{margin-bottom:0}.sh-markdown h1,.sh-markdown h2,.sh-markdown h3,.sh-markdown h4,.sh-markdown h5,.sh-markdown h6{margin:1.1em 0 .45em;color:var(--color-text-primary);font-weight:600;line-height:1.3}.sh-markdown h1{font-size:1.4em;padding-bottom:.28em;border-bottom:1px solid var(--surface-divider-soft)}.sh-markdown h2{font-size:1.18em;padding-bottom:.18em;border-bottom:1px solid var(--surface-divider-muted)}.sh-markdown h3{font-size:1.05em}.sh-markdown h4,.sh-markdown h5,.sh-markdown h6{font-size:1em}.sh-markdown p,.sh-markdown ul,.sh-markdown ol,.sh-markdown pre,.sh-markdown table,.sh-markdown blockquote{margin:0 0 .8em}.sh-markdown ul,.sh-markdown ol{padding-left:1.4em}.sh-markdown li{margin:.2em 0}.sh-markdown a{color:var(--color-accent-blue);text-decoration:none;cursor:pointer}.sh-markdown a:hover{text-decoration:underline}.sh-markdown :not(pre)>code{padding:.12em .35em;border:1px solid var(--color-border);border-radius:4px;background:var(--surface-panel-soft);color:var(--color-accent-purple);font-family:var(--font-mono);word-break:break-word}.sh-markdown pre{padding:9px 10px;overflow:auto;border:1px solid var(--color-border);border-radius:4px;background:var(--color-bg-primary);font-family:var(--font-mono);white-space:pre}.sh-markdown pre code{padding:0;border:0;background:transparent;color:inherit;font-size:inherit}.sh-markdown .sh-code-highlight-yaml .sh-code-token-key{color:var(--color-accent-blue);font-weight:650}.sh-markdown .sh-code-highlight-yaml .sh-code-token-separator,.sh-markdown .sh-code-highlight-yaml .sh-code-token-listMarker{color:var(--color-text-muted)}.sh-markdown .sh-code-highlight-yaml .sh-code-token-string{color:var(--color-text-primary)}.sh-markdown .sh-code-highlight-yaml .sh-code-token-number{color:var(--color-accent-yellow)}.sh-markdown .sh-code-highlight-yaml .sh-code-token-literal{color:var(--color-accent-purple);font-weight:600}.sh-markdown .sh-code-highlight-yaml .sh-code-token-comment{color:var(--color-accent-green);font-style:italic}.sh-markdown .sh-code-highlight-yaml .sh-code-token-value{color:var(--color-text-secondary)}.sh-markdown blockquote{padding:.55em .7em;border-left:3px solid var(--surface-accent-blue-border);border-radius:0 4px 4px 0;background:var(--surface-panel-soft);color:var(--color-text-secondary)}.sh-markdown table{width:100%;border-collapse:collapse;border:1px solid var(--color-border);font-size:12px}.sh-markdown th,.sh-markdown td{padding:5px 7px;border:1px solid var(--surface-divider-soft);text-align:left;vertical-align:top}.sh-markdown th{background:var(--surface-panel-strong)}</style><style>:host{color-scheme:${theme.type};${variables}}</style>`
  return /<head(?:\s[^>]*)?>/i.test(content.value)
    ? content.value.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injected}`)
    : `${injected}${content.value}`
})

function formatError(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

function scriptOutputText(output: ScriptToolRunResponse | string): string {
  if (typeof output === 'string') return output
  return [output.stdout, output.stderr].filter(Boolean).join('\n\n')
}

function linkifyWorkspaceFiles(container: HTMLElement, rootPath: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)

  for (const textNode of textNodes) {
    if (textNode.parentElement?.closest('a, script, style')) continue
    const references = findScriptToolFileReferences(textNode.data)
      .filter((reference) => resolveScriptToolWorkspaceFile(rootPath, reference.filePath))
    if (!references.length) continue

    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const reference of references) {
      fragment.append(document.createTextNode(textNode.data.slice(cursor, reference.index)))
      const link = document.createElement('a')
      link.href = '#'
      link.textContent = reference.text
      link.dataset.superhighFilePath = reference.filePath
      if (reference.lineNumber) link.dataset.superhighLineNumber = String(reference.lineNumber)
      if (reference.column) link.dataset.superhighColumn = String(reference.column)
      link.title = '在 SuperHigh 代码预览中打开'
      fragment.append(link)
      cursor = reference.index + reference.text.length
    }
    fragment.append(document.createTextNode(textNode.data.slice(cursor)))
    textNode.replaceWith(fragment)
  }
}

async function openOutputFileLink(link: HTMLAnchorElement) {
  const targetPath = resolveScriptToolWorkspaceFile(workspaceRoot.value, link.dataset.superhighFilePath ?? '')
  if (!targetPath) {
    store.showErrorMessage('该输出路径不在当前工作区内，无法打开。')
    return
  }

  const lineNumber = Number(link.dataset.superhighLineNumber) || undefined
  const column = Number(link.dataset.superhighColumn) || 1
  store.setWorkspaceSurface('project')
  if (store.settings.activePreviewMode !== 'code') store.setPreviewMode('code')
  const opened = await store.openFile(targetPath)
  if (opened && lineNumber) {
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('superhigh:reveal-editor-position', {
      detail: { path: targetPath, lineNumber, column },
    })), 100)
  }
}

function renderScriptToolOutput(target: HTMLElement, output: ScriptToolRunResponse | string) {
  const text = scriptOutputText(output) || '脚本没有输出内容。'
  target.classList.add('sh-markdown')
  target.innerHTML = renderMarkdown(text)
  linkifyWorkspaceFiles(target, workspaceRoot.value)
  if (outputClickBound.has(target)) return
  outputClickBound.add(target)
  target.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[data-superhigh-file-path]')
    if (!link) return
    event.preventDefault()
    void openOutputFileLink(link)
  })
}

async function loadExtension() {
  const rootPath = workspaceRoot.value
  const uiPath = props.tool.uiPath
  content.value = ''
  error.value = ''
  if (!rootPath || !uiPath) return
  try {
    content.value = await backend.readFile(`${rootPath.replace(/[\\/]+$/, '')}/${uiPath}`)
  } catch (loadError) {
    error.value = `未加载脚本扩展 UI：${formatError(loadError)}`
  }
}

function mountExtensionDocument() {
  const host = extensionHost.value
  if (!host || !extensionDocument.value) return
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const page = new DOMParser().parseFromString(extensionDocument.value, 'text/html')
  const scripts = Array.from(page.scripts)
  const fragment = document.createDocumentFragment()

  for (const node of [...Array.from(page.head.children), ...Array.from(page.body.children)]) {
    if (node.tagName === 'SCRIPT') continue
    const copy = node.cloneNode(true) as HTMLElement
    if (copy.tagName === 'STYLE') copy.textContent = copy.textContent?.replace(/(^|[},])(\s*)body(?=\s*(?:[,{]))/g, '$1$2:host') ?? ''
    fragment.append(copy)
  }
  shadow.replaceChildren(fragment)

  const extensionDom = {
    getElementById: (id: string) => shadow.querySelector(`#${CSS.escape(id)}`),
    querySelector: shadow.querySelector.bind(shadow),
    querySelectorAll: shadow.querySelectorAll.bind(shadow),
    createElement: document.createElement.bind(document),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      if (type === 'DOMContentLoaded') queueMicrotask(() => typeof listener === 'function' ? listener(new Event(type)) : listener.handleEvent(new Event(type)))
      else shadow.addEventListener(type, listener, options)
    },
  }
  const extensionWindow = {
    superhighScriptTool: {
      context: () => ({
        id: props.tool.id,
        displayName: props.tool.displayName,
        sourcePath: props.tool.sourcePath,
      }),
      run: async (values: Record<string, unknown> = {}) => {
        const rootPath = workspaceRoot.value
        if (!rootPath || !values || Array.isArray(values) || typeof values !== 'object') throw new Error('脚本参数必须是键值对象。')
        const args = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value ?? '')]))
        return backend.runProjectScriptTool(rootPath, props.tool.id, args)
      },
      searchMonsterLibrary: async (query = '', options: { page?: number; pageSize?: number } = {}) => {
        const rootPath = workspaceRoot.value
        if (!rootPath) throw new Error('未打开工作区。')
        if (typeof query !== 'string') throw new Error('怪物查询内容必须是文本。')
        const page = Number.isInteger(options.page) && Number(options.page) > 0 ? Number(options.page) : undefined
        const pageSize = Number.isInteger(options.pageSize) && Number(options.pageSize) > 0 ? Number(options.pageSize) : undefined
        return backend.searchMonsterLibrary(rootPath, query, page, pageSize)
      },
      renderOutput: (target: HTMLElement, output: ScriptToolRunResponse | string) => {
        if (!(target instanceof HTMLElement)) throw new Error('renderOutput 的第一个参数必须是结果容器元素。')
        renderScriptToolOutput(target, output)
      },
      copy: async (text: string) => {
        if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持写入剪贴板。')
        await navigator.clipboard.writeText(text)
        store.showActivityMessage('已复制')
      },
      notify: (message: string, level: 'error' | 'info' = 'info') => {
        if (level === 'error') store.showErrorMessage(message)
        else store.showActivityMessage(message)
      },
    },
    addEventListener: shadow.addEventListener.bind(shadow),
    removeEventListener: shadow.removeEventListener.bind(shadow),
  }
  for (const script of scripts) new Function('document', 'window', script.textContent ?? '')(extensionDom, extensionWindow)
}

watch(() => [workspaceRoot.value, props.tool.id, props.tool.uiPath], () => { void loadExtension() }, { immediate: true })
watch(extensionDocument, () => { void nextTick(mountExtensionDocument) }, { flush: 'post' })
</script>

<template>
  <section class="script-tool-extension" :aria-label="`${tool.displayName} 扩展 UI`">
    <div v-if="error" class="script-tool-extension-error">{{ error }}</div>
    <div v-else ref="extensionHost" class="script-tool-extension-host" />
  </section>
</template>

<style scoped>
.script-tool-extension { min-width: 0; min-height: 0; overflow: auto; background: var(--color-bg-primary); }
.script-tool-extension-host { min-height: 100%; }
.script-tool-extension-error { margin: 12px; padding: 10px; border: 1px solid var(--surface-accent-red-border); border-radius: 4px; color: var(--color-accent-red); background: var(--surface-accent-red-soft); font-size: 12px; line-height: 1.45; }
</style>
