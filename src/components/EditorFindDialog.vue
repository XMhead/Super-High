<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type * as MonacoTypes from 'monaco-editor'
import { X } from 'lucide-vue-next'

import { getMonaco } from '@/lib/monaco'
import { backend } from '@/lib/tauri'
import type { EditorTab } from '@/types'

type FindDialogMode = 'find' | 'replace' | 'findInFiles' | 'findInProjects' | 'mark'
type FindDialogTab = FindDialogMode
type SearchMode = 'normal' | 'extended' | 'regex'
type ResultRow = { key: string; path: string; lineNumber: number; column: number; preview: string }
type TextMatch = { index: number; length: number }
type SearchScope = { text: string; start: number }
type EditorContext = { editor: MonacoTypes.editor.IStandaloneCodeEditor; model: MonacoTypes.editor.ITextModel }

const props = defineProps<{
  open: boolean
  mode: FindDialogMode
  getEditor: () => MonacoTypes.editor.IStandaloneCodeEditor | null
  tabs: EditorTab[]
  workspaceRoot: string | null
  activePath: string | null
  applyTabContent: (tabId: string, content: string) => void
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  navigate: [payload: { path: string; lineNumber: number; column: number }]
}>()

const dialogTab = ref<FindDialogTab>('find')
const findText = ref('')
const replaceText = ref('')
const filterText = ref('*')
const directoryText = ref('')
const matchCase = ref(false)
const wholeWord = ref(false)
const loopSearch = ref(true)
const backwards = ref(false)
const inSelection = ref(false)
const searchMode = ref<SearchMode>('normal')
const dotMatchesNewline = ref(false)
const transparencyEnabled = ref(true)
const transparencyMode = ref<'lostFocus' | 'always'>('lostFocus')
const transparencyValue = ref(92)
const statusMessage = ref('')
const statusTone = ref<'info' | 'error'>('info')
const results = ref<ResultRow[]>([])
const resultTitle = ref('')
const resultLoading = ref(false)
const searchConsumerId = `editor-find-${crypto.randomUUID()}`
let fileSearchRequest = 0
const findInput = ref<HTMLInputElement | null>(null)
const dialogElement = ref<HTMLElement | null>(null)
const dialogFocused = ref(true)
const position = ref({ left: 0, top: 0 })
const selectionScope = ref<{ start: number; end: number } | null>(null)
let markCollection: MonacoTypes.editor.IEditorDecorationsCollection | null = null
let dragState: { startX: number; startY: number; originLeft: number; originTop: number } | null = null

const dialogTabLabel = computed(() => {
  if (dialogTab.value === 'find') return '查找'
  if (dialogTab.value === 'replace') return '替换'
  if (dialogTab.value === 'findInFiles') return '文件中查找'
  if (dialogTab.value === 'findInProjects') return '项目中查找'
  return '标记'
})

const dialogTabs: Array<{ id: FindDialogTab; label: string }> = [
  { id: 'find', label: '查找' },
  { id: 'replace', label: '替换' },
  { id: 'findInFiles', label: '文件中查找' },
  { id: 'findInProjects', label: '项目中查找' },
  { id: 'mark', label: '标记' },
]

const dialogOpacity = computed(() => {
  if (!transparencyEnabled.value) return 1
  if (transparencyMode.value === 'always' || !dialogFocused.value) return transparencyValue.value / 100
  return 1
})

const dialogStyle = computed(() => ({
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  opacity: dialogOpacity.value,
}))

const showResults = computed(() => results.value.length > 0 || resultTitle.value !== '')

function tabFromMode(mode: FindDialogMode): FindDialogTab {
  return mode
}

function setStatus(message: string, tone: 'info' | 'error' = 'info') {
  statusMessage.value = message
  statusTone.value = tone
}

function selectedEditorText(): string {
  const editor = props.getEditor()
  const model = editor?.getModel()
  const selection = editor?.getSelection()
  if (!editor || !model || !selection || selection.isEmpty()) return ''
  const text = model.getValueInRange(selection)
  if (!text || text.length > 300 || text.includes('\n') || text.includes('\r')) return ''
  return text
}

function defaultDirectory(): string {
  const path = props.activePath ?? props.workspaceRoot ?? ''
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : normalized
}

function positionDialog() {
  const dom = props.getEditor()?.getDomNode()
  const rect = dom?.getBoundingClientRect()
  const width = Math.min(560, window.innerWidth - 24)
  if (rect && rect.width > 0) {
    position.value = {
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + (rect.width - width) / 2)),
      top: Math.max(12, Math.min(window.innerHeight - 140, rect.top + 28)),
    }
    return
  }
  position.value = {
    left: Math.max(12, (window.innerWidth - width) / 2),
    top: Math.max(12, (window.innerHeight - 460) / 2),
  }
}

function activate() {
  dialogTab.value = tabFromMode(props.mode)
  const selected = selectedEditorText()
  if (selected && (dialogTab.value === 'find' || dialogTab.value === 'replace')) findText.value = selected
  results.value = []
  resultTitle.value = ''
  statusMessage.value = ''
  statusTone.value = 'info'
  directoryText.value = defaultDirectory()
  positionDialog()
  captureSelectionScope()
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}

defineExpose({ activate })

function requestClose() {
  emit('update:open', false)
}

function selectTab(tab: FindDialogTab) {
  dialogTab.value = tab
  results.value = []
  resultTitle.value = ''
  if (tab === 'findInFiles') directoryText.value = defaultDirectory()
  void nextTick(() => findInput.value?.focus())
}

function captureSelectionScope() {
  const editor = props.getEditor()
  const model = editor?.getModel()
  const selection = editor?.getSelection()
  if (!editor || !model || !selection || selection.isEmpty()) {
    selectionScope.value = null
    return
  }
  selectionScope.value = {
    start: model.getOffsetAt(selection.getStartPosition()),
    end: model.getOffsetAt(selection.getEndPosition()),
  }
}

function onInSelectionChange() {
  if (inSelection.value) {
    captureSelectionScope()
    if (!selectionScope.value) setStatus('请先在编辑器中选择要查找的范围。', 'error')
  } else {
    selectionScope.value = null
  }
}

function onDialogFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (!next || !dialogElement.value?.contains(next)) dialogFocused.value = false
}

function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  if ((event.target as HTMLElement | null)?.closest('button')) return
  dragState = {
    startX: event.clientX,
    startY: event.clientY,
    originLeft: position.value.left,
    originTop: position.value.top,
  }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
}

function onDragMove(event: PointerEvent) {
  if (!dragState) return
  const width = Math.min(560, window.innerWidth - 24)
  const height = dialogElement.value?.getBoundingClientRect().height ?? 420
  position.value = {
    left: Math.max(0, Math.min(window.innerWidth - width, dragState.originLeft + event.clientX - dragState.startX)),
    top: Math.max(0, Math.min(window.innerHeight - Math.min(height, window.innerHeight), dragState.originTop + event.clientY - dragState.startY)),
  }
}

function stopDrag() {
  dragState = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeExtended(value: string): string {
  return value.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|n|r|t|0|\\)/g, (all, sequence: string) => {
    if (sequence === 'n') return '\n'
    if (sequence === 'r') return '\r'
    if (sequence === 't') return '\t'
    if (sequence === '0') return '\0'
    if (sequence === '\\') return '\\'
    if (sequence.startsWith('x') || sequence.startsWith('u')) {
      return String.fromCharCode(parseInt(sequence.slice(1), 16))
    }
    return all
  })
}

function compileSearch(): { regex: RegExp; tester: RegExp } | null {
  const query = findText.value
  if (!query) {
    setStatus('请输入查找目标。', 'error')
    return null
  }
  let body = searchMode.value === 'regex'
    ? query
    : escapeRegExp(searchMode.value === 'extended' ? decodeExtended(query) : query)
  if (wholeWord.value) body = `(?<!\\w)(?:${body})(?!\\w)`
  const flags = `${matchCase.value ? '' : 'i'}${searchMode.value === 'regex' && dotMatchesNewline.value ? 's' : ''}`
  try {
    return {
      regex: new RegExp(body, `g${flags}`),
      tester: new RegExp(body, flags),
    }
  } catch (error) {
    setStatus(`查找表达式无效：${error instanceof Error ? error.message : String(error)}`, 'error')
    return null
  }
}

function collectMatches(text: string, pattern: RegExp): TextMatch[] {
  const matches: TextMatch[] = []
  pattern.lastIndex = 0
  let guard = 0
  while (guard < 100000) {
    guard += 1
    const match = pattern.exec(text)
    if (!match) break
    matches.push({ index: match.index, length: match[0].length })
    if (match[0].length === 0) pattern.lastIndex = match.index + 1
  }
  return matches
}

function editorContext(): EditorContext | null {
  const editor = props.getEditor()
  const model = editor?.getModel()
  if (!editor || !model) {
    setStatus('当前没有可查找的文本文件。', 'error')
    return null
  }
  return { editor, model }
}

function readScope(model: MonacoTypes.editor.ITextModel): SearchScope | null {
  const text = model.getValue()
  if (!inSelection.value || dialogTab.value !== 'replace') return { text, start: 0 }
  if (!selectionScope.value) {
    setStatus('请先在编辑器中选择要查找的范围。', 'error')
    return null
  }
  const start = Math.min(Math.max(0, selectionScope.value.start), text.length)
  const end = Math.min(Math.max(start, selectionScope.value.end), text.length)
  if (end <= start) {
    setStatus('选区为空。', 'error')
    return null
  }
  return { text: text.slice(start, end), start }
}

function selectMatch(editor: MonacoTypes.editor.IStandaloneCodeEditor, model: MonacoTypes.editor.ITextModel, index: number, length: number) {
  const monaco = getMonaco()
  const start = model.getPositionAt(index)
  const end = model.getPositionAt(index + length)
  if (monaco) {
    editor.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column))
  }
  editor.revealRangeInCenter({
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  })
}

function findNext(silent = false): { context: EditorContext; scope: SearchScope; match: TextMatch; matches: TextMatch[] } | null {
  const context = editorContext()
  const compiled = compileSearch()
  if (!context || !compiled) return null
  const scope = readScope(context.model)
  if (!scope) return null
  const matches = collectMatches(scope.text, compiled.regex)
  if (!matches.length) {
    if (!silent) setStatus('未找到匹配项。', 'error')
    return null
  }
  const selection = context.editor.getSelection()
  const selectionStart = selection ? context.model.getOffsetAt(selection.getStartPosition()) - scope.start : -1
  const selectionEnd = selection ? context.model.getOffsetAt(selection.getEndPosition()) - scope.start : -1
  let target: TextMatch | null = null
  if (backwards.value) {
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index]
      if (match.index + match.length <= Math.max(selectionStart, 0)) {
        target = match
        break
      }
    }
    if (!target && loopSearch.value) target = matches[matches.length - 1]
  } else {
    for (const match of matches) {
      if (match.index >= Math.max(selectionEnd, 0)) {
        target = match
        break
      }
    }
    if (!target && loopSearch.value) target = matches[0]
  }
  if (!target) {
    if (!silent) setStatus('未找到匹配项。', 'error')
    return null
  }
  selectMatch(context.editor, context.model, scope.start + target.index, target.length)
  if (!silent) {
    const lineNumber = context.model.getPositionAt(scope.start + target.index).lineNumber
    setStatus(`第 ${lineNumber} 行，共 ${matches.length} 处。`)
  }
  return { context, scope, match: target, matches }
}

function countMatches() {
  const context = editorContext()
  const compiled = compileSearch()
  if (!context || !compiled) return
  const scope = readScope(context.model)
  if (!scope) return
  const count = collectMatches(scope.text, compiled.regex).length
  setStatus(inSelection.value ? `选区内共 ${count} 处。` : `当前文件共 ${count} 处。`)
}

function buildResultRows(text: string, matches: TextMatch[], path: string, limit: number): ResultRow[] {
  const rows: ResultRow[] = []
  let line = 1
  let lineStart = 0
  let cursor = 0
  for (const match of matches) {
    if (rows.length >= limit) break
    for (let index = cursor; index < match.index; index += 1) {
      if (text.charCodeAt(index) === 10) {
        line += 1
        lineStart = index + 1
      }
    }
    cursor = match.index
    const lineBreak = text.indexOf('\n', match.index)
    const lineEnd = lineBreak === -1 ? text.length : lineBreak
    rows.push({
      key: `${path}:${match.index}:${rows.length}`,
      path,
      lineNumber: line,
      column: match.index - lineStart + 1,
      preview: text.slice(lineStart, lineEnd).trim().slice(0, 180),
    })
  }
  return rows
}

function findInCurrentFile() {
  const context = editorContext()
  const compiled = compileSearch()
  if (!context || !compiled) return
  const scope = readScope(context.model)
  if (!scope) return
  const matches = collectMatches(scope.text, compiled.regex)
  results.value = buildResultRows(scope.text, matches, props.activePath ?? '', 500)
  resultTitle.value = '当前文件'
  setStatus(`当前文件共 ${matches.length} 处。`)
}

function findInOpenFiles() {
  const compiled = compileSearch()
  if (!compiled) return
  const rows: ResultRow[] = []
  for (const tab of props.tabs) {
    if (tab.contentType !== 'text') continue
    if (rows.length >= 500) break
    const matches = collectMatches(tab.content, new RegExp(compiled.regex.source, compiled.regex.flags))
    if (!matches.length) continue
    rows.push(...buildResultRows(tab.content, matches, tab.path, 500 - rows.length))
  }
  results.value = rows
  resultTitle.value = '打开的文件'
  setStatus(`在打开的文件中已列出 ${rows.length} 个匹配行。`)
}

async function findInFiles(projectWide: boolean) {
  const compiled = compileSearch()
  if (!compiled) return
  const query = searchMode.value === 'extended' ? decodeExtended(findText.value) : findText.value
  if (query.includes('\n') || query.includes('\r') || (searchMode.value === 'regex' && dotMatchesNewline.value)) {
    setStatus('文件搜索仅支持单行；跨行及点号匹配换行请使用当前文件查找。', 'error')
    return
  }
  const root = projectWide ? props.workspaceRoot : directoryText.value.trim()
  if (!root) {
    setStatus(projectWide ? '当前没有工作区。' : '请输入要查找的目录。', 'error')
    return
  }
  const request = ++fileSearchRequest
  let acceptingBatches = true
  resultLoading.value = true
  setStatus('正在查找…')
  try {
    const rows: ResultRow[] = []
    const append = (items: import('@/types').TextSearchMatch[]) => {
      if (!acceptingBatches || request !== fileSearchRequest) return
      for (const item of items) rows.push({
        key: `${item.path}:${item.lineNumber}:${rows.length}`, path: item.path,
        lineNumber: item.lineNumber, column: item.column, preview: item.preview,
      })
      results.value = [...rows]
    }
    results.value = []
    const response = await backend.searchProjectFiles(query, [root], {
      includeText: true, includeFiles: false,
      buffers: props.tabs.filter((tab) => tab.contentType === 'text').map((tab) => ({ path: tab.path, content: tab.content })),
      preserveWhitespace: true, contentRegex: searchMode.value === 'regex', caseSensitive: matchCase.value,
      wholeWord: wholeWord.value, includeFilter: filterText.value, limit: 500,
    }, searchConsumerId, append)
    if (request !== fileSearchRequest) return
    // The final response is authoritative even if a channel callback arrives late.
    rows.length = 0
    append(response.textMatches)
    acceptingBatches = false
    results.value = rows
    resultTitle.value = projectWide ? '项目中查找' : '文件中查找'
    setStatus(`已列出 ${rows.length} 个匹配行${rows.length >= 500 ? "（达到 500 行上限）" : "（扫描完成）"}。${searchMode.value === 'regex' ? '单行正则不支持环视和反向引用。' : ''}`)
  } catch (error) {
    if (request !== fileSearchRequest) return
    setStatus(`查找失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    acceptingBatches = false
    if (request === fileSearchRequest) resultLoading.value = false
  }
}

function replacementText(): string {
  let value = replaceText.value
  if (searchMode.value === 'extended') value = decodeExtended(value)
  if (searchMode.value !== 'regex') value = value.replace(/\$/g, '$$$$')
  return value
}

function anchoredTester(compiled: { tester: RegExp }): RegExp {
  return new RegExp(`^(?:${compiled.tester.source})$`, compiled.tester.flags)
}

function replaceCurrent() {
  const context = editorContext()
  const compiled = compileSearch()
  if (!context || !compiled) return
  const selection = context.editor.getSelection()
  const anchored = anchoredTester(compiled)
  if (selection && !selection.isEmpty()) {
    const selected = context.model.getValueInRange(selection)
    if (anchored.test(selected)) {
      context.editor.executeEdits('superhigh-find', [{
        range: selection,
        text: selected.replace(anchored, replacementText()),
        forceMoveMarkers: true,
      }])
      setStatus('已替换 1 处。')
      return
    }
  }
  const found = findNext()
  if (!found) return
  const nextSelection = context.editor.getSelection()
  if (!nextSelection) return
  const selected = context.model.getValueInRange(nextSelection)
  if (!anchored.test(selected)) return
  context.editor.executeEdits('superhigh-find', [{
    range: nextSelection,
    text: selected.replace(anchored, replacementText()),
    forceMoveMarkers: true,
  }])
  setStatus('已替换 1 处。')
}

function replaceAllInCurrentFile() {
  const context = editorContext()
  const compiled = compileSearch()
  if (!context || !compiled) return
  const scope = readScope(context.model)
  if (!scope) return
  const matches = collectMatches(scope.text, new RegExp(compiled.regex.source, compiled.regex.flags))
  if (!matches.length) {
    setStatus('未找到匹配项。', 'error')
    return
  }
  const nextText = scope.text.replace(new RegExp(compiled.regex.source, compiled.regex.flags), replacementText())
  const start = context.model.getPositionAt(scope.start)
  const end = context.model.getPositionAt(scope.start + scope.text.length)
  context.editor.executeEdits('superhigh-find', [{
    range: {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    },
    text: nextText,
    forceMoveMarkers: true,
  }])
  setStatus(`已替换 ${matches.length} 处。`)
}

function replaceAllOpenFiles() {
  const compiled = compileSearch()
  if (!compiled) return
  const replacement = replacementText()
  let total = 0
  let fileCount = 0
  for (const tab of props.tabs) {
    if (tab.contentType !== 'text') continue
    let next = tab.content
    let count = 0
    if (tab.path === props.activePath && inSelection.value && dialogTab.value === 'replace' && selectionScope.value) {
      const start = Math.min(Math.max(0, selectionScope.value.start), tab.content.length)
      const end = Math.min(Math.max(start, selectionScope.value.end), tab.content.length)
      if (end > start) {
        const slice = tab.content.slice(start, end)
        count = collectMatches(slice, new RegExp(compiled.regex.source, compiled.regex.flags)).length
        if (count) {
          next = tab.content.slice(0, start) + slice.replace(new RegExp(compiled.regex.source, compiled.regex.flags), replacement) + tab.content.slice(end)
        }
      }
    } else {
      count = collectMatches(tab.content, new RegExp(compiled.regex.source, compiled.regex.flags)).length
      if (count) next = tab.content.replace(new RegExp(compiled.regex.source, compiled.regex.flags), replacement)
    }
    if (count && next !== tab.content) {
      props.applyTabContent(tab.id, next)
      total += count
      fileCount += 1
    }
  }
  setStatus(total ? `已在 ${fileCount} 个文件中替换 ${total} 处。` : '未找到匹配项。', total ? 'info' : 'error')
}

function markAll() {
  const context = editorContext()
  const compiled = compileSearch()
  if (!context || !compiled) return
  const monaco = getMonaco()
  if (!monaco) return
  const scope = readScope(context.model)
  if (!scope) return
  const matches = collectMatches(scope.text, compiled.regex)
  markCollection?.clear()
  markCollection = context.editor.createDecorationsCollection(matches.slice(0, 2000).map((match) => {
    const start = context.model.getPositionAt(scope.start + match.index)
    const end = context.model.getPositionAt(scope.start + match.index + Math.max(1, match.length))
    return {
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: { inlineClassName: 'find-dialog-mark' },
    }
  }))
  setStatus(`已标记 ${matches.length} 处。`)
}

function clearMarks() {
  markCollection?.clear()
  markCollection = null
  setStatus('已清除标记。')
}

function openResult(row: ResultRow) {
  emit('navigate', { path: row.path, lineNumber: row.lineNumber, column: row.column })
}

function onFindInputEnter() {
  if (dialogTab.value === 'find' || dialogTab.value === 'replace') findNext()
}

watch(() => props.activePath, () => {
  cancelFileSearch()
  results.value = []
  resultTitle.value = ''
  markCollection?.clear()
  markCollection = null
})

function cancelFileSearch() {
  fileSearchRequest += 1
  resultLoading.value = false
  void backend.cancelProjectSearch?.(searchConsumerId).catch(() => {})
}

watch(() => props.open, (open) => {
  if (!open) cancelFileSearch()
})

watch([findText, searchMode, matchCase, wholeWord, dotMatchesNewline, directoryText, filterText, () => props.workspaceRoot], () => {
  if (resultLoading.value) {
    cancelFileSearch()
    setStatus('')
  }
})

watch(inSelection, onInSelectionChange)

onBeforeUnmount(() => {
  cancelFileSearch()
  markCollection?.clear()
  markCollection = null
  stopDrag()
})
</script>

<template>
  <Teleport to="body">
    <section
      v-if="open"
      ref="dialogElement"
      class="find-dialog"
      :style="dialogStyle"
      role="dialog"
      aria-modal="false"
      :aria-label="dialogTabLabel"
      @keydown.esc.stop.prevent="requestClose"
      @focusin="dialogFocused = true"
      @focusout="onDialogFocusOut"
    >
      <div class="find-dialog-titlebar" @pointerdown="startDrag">
        <span class="find-dialog-title">{{ dialogTabLabel }}</span>
        <button class="find-dialog-close" type="button" aria-label="关闭" @click="requestClose">
          <X :size="14" />
        </button>
      </div>

      <div class="find-dialog-tabs" role="tablist">
        <button
          v-for="tab in dialogTabs"
          :key="tab.id"
          class="find-dialog-tab"
          :class="{ active: dialogTab === tab.id }"
          type="button"
          role="tab"
          :aria-selected="dialogTab === tab.id"
          @click="selectTab(tab.id)"
        >{{ tab.label }}</button>
      </div>

      <div class="find-dialog-content">
        <div class="find-dialog-main">
          <div class="find-dialog-left">
            <div class="find-dialog-row">
              <label for="find-dialog-target">查找目标(F):</label>
              <input
                id="find-dialog-target"
                ref="findInput"
                v-model="findText"
                class="find-dialog-input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                @keydown.enter.prevent="onFindInputEnter"
              />
            </div>

            <div v-if="dialogTab === 'replace'" class="find-dialog-row">
              <label for="find-dialog-replace">替换为(L):</label>
              <input
                id="find-dialog-replace"
                v-model="replaceText"
                class="find-dialog-input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                @keydown.enter.prevent="replaceCurrent"
              />
            </div>

            <div v-if="dialogTab === 'findInFiles' || dialogTab === 'findInProjects'" class="find-dialog-row">
              <label for="find-dialog-filter">筛选器:</label>
              <input
                id="find-dialog-filter"
                v-model="filterText"
                class="find-dialog-input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                placeholder="*.yml *.json"
                @keydown.enter.prevent="findInFiles(dialogTab === 'findInProjects')"
              />
            </div>

            <div v-if="dialogTab === 'findInFiles'" class="find-dialog-row">
              <label for="find-dialog-directory">目录:</label>
              <input
                id="find-dialog-directory"
                v-model="directoryText"
                class="find-dialog-input"
                type="text"
                spellcheck="false"
                autocomplete="off"
                @keydown.enter.prevent="findInFiles(false)"
              />
            </div>

            <div v-if="dialogTab === 'replace'" class="find-dialog-selection">
              <label class="find-dialog-check"><input v-model="inSelection" type="checkbox" />选区内</label>
            </div>

            <div v-if="dialogTab === 'find' || dialogTab === 'replace' || dialogTab === 'mark'" class="find-dialog-options">
              <label class="find-dialog-check"><input v-model="backwards" type="checkbox" />反向查找</label>
              <label class="find-dialog-check"><input v-model="wholeWord" type="checkbox" />全词匹配(W)</label>
              <label class="find-dialog-check"><input v-model="matchCase" type="checkbox" />匹配大小写(C)</label>
              <label class="find-dialog-check"><input v-model="loopSearch" type="checkbox" />循环查找(P)</label>
            </div>

            <div v-if="dialogTab === 'find' || dialogTab === 'replace' || dialogTab === 'mark'" class="find-dialog-mode">
              <div class="find-dialog-group-title">查找模式</div>
              <label class="find-dialog-check"><input v-model="searchMode" type="radio" value="normal" />普通(N)</label>
              <label class="find-dialog-check"><input v-model="searchMode" type="radio" value="extended" />扩展(X) (\n, \r, \t, \0, \x..., \u...)</label>
              <div class="find-dialog-regex-row">
                <label class="find-dialog-check"><input v-model="searchMode" type="radio" value="regex" />正则表达式(G)</label>
                <label class="find-dialog-check"><input v-model="dotMatchesNewline" type="checkbox" />. 号匹配换行符</label>
              </div>
            </div>

            <div v-if="dialogTab === 'findInFiles' || dialogTab === 'findInProjects'" class="find-dialog-options file-options">
              <label class="find-dialog-check"><input v-model="wholeWord" type="checkbox" />全词匹配(W)</label>
              <label class="find-dialog-check"><input v-model="matchCase" type="checkbox" />匹配大小写(C)</label>
              <label class="find-dialog-check"><input v-model="searchMode" type="radio" value="normal" />普通(N)</label>
              <label class="find-dialog-check"><input v-model="searchMode" type="radio" value="extended" />扩展(X)</label>
              <label class="find-dialog-check"><input v-model="searchMode" type="radio" value="regex" />正则表达式(G)</label>
            </div>
          </div>

          <div class="find-dialog-right">
            <template v-if="dialogTab === 'find' || dialogTab === 'mark'">
              <button class="find-dialog-button" type="button" @click="findNext()">查找下一个(E)</button>
              <button v-if="dialogTab === 'find'" class="find-dialog-button" type="button" @click="countMatches">计数(T)</button>
              <button v-if="dialogTab === 'find'" class="find-dialog-button" type="button" @click="findInCurrentFile">在当前文件中查找</button>
              <button v-if="dialogTab === 'find'" class="find-dialog-button" type="button" @click="findInOpenFiles">查找所有打开文件(O)</button>
              <button v-if="dialogTab === 'mark'" class="find-dialog-button" type="button" @click="markAll">标记全部</button>
              <button v-if="dialogTab === 'mark'" class="find-dialog-button" type="button" @click="clearMarks">清除标记</button>
              <button class="find-dialog-button" type="button" @click="requestClose">关闭</button>
            </template>

            <template v-else-if="dialogTab === 'replace'">
              <button class="find-dialog-button" type="button" @click="findNext()">查找下一个(E)</button>
              <button class="find-dialog-button" type="button" @click="replaceCurrent">替换(R)</button>
              <button class="find-dialog-button" type="button" @click="replaceAllInCurrentFile">全部替换(A)</button>
              <button class="find-dialog-button" type="button" @click="replaceAllOpenFiles">替换所有打开文件(O)</button>
              <button class="find-dialog-button" type="button" @click="requestClose">关闭</button>
            </template>

            <template v-else>
              <button class="find-dialog-button" type="button" :disabled="resultLoading" @click="findInFiles(dialogTab === 'findInProjects')">
                {{ resultLoading ? '查找中…' : '查找全部' }}
              </button>
              <button class="find-dialog-button" type="button" @click="requestClose">关闭</button>
            </template>

            <div class="find-dialog-transparency">
              <label class="find-dialog-check"><input v-model="transparencyEnabled" type="checkbox" />透明度(Y)</label>
              <label class="find-dialog-check"><input v-model="transparencyMode" type="radio" value="lostFocus" :disabled="!transparencyEnabled" />失去焦点后</label>
              <label class="find-dialog-check"><input v-model="transparencyMode" type="radio" value="always" :disabled="!transparencyEnabled" />始终</label>
              <input v-model.number="transparencyValue" class="find-dialog-slider" type="range" min="30" max="100" step="1" :disabled="!transparencyEnabled" />
            </div>
          </div>
        </div>

        <div v-if="showResults" class="find-dialog-results">
          <div class="find-dialog-results-title">{{ resultTitle }}（{{ results.length }}）</div>
          <div class="find-dialog-results-list">
            <button
              v-for="row in results"
              :key="row.key"
              class="find-dialog-result"
              type="button"
              :title="`${row.path}:${row.lineNumber}`"
              @click="openResult(row)"
            >
              <span class="find-dialog-result-line">{{ row.lineNumber }}</span>
              <span class="find-dialog-result-preview">{{ row.preview }}</span>
            </button>
            <div v-if="!results.length" class="find-dialog-results-empty">无匹配项</div>
          </div>
        </div>

        <div class="find-dialog-status" :class="{ error: statusTone === 'error' }">{{ statusMessage }}</div>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.find-dialog {
  position: fixed;
  z-index: 1600;
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-family: var(--font-ui);
  font-size: 12px;
  box-shadow: none;
}

.find-dialog-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  height: 30px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-strong);
  cursor: move;
  user-select: none;
}

.find-dialog-title {
  overflow: hidden;
  font-size: 12px;
  font-weight: var(--sh-weight-emphasis);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.find-dialog-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.find-dialog-close:hover {
  border-color: var(--color-border);
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.find-dialog-tabs {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--color-border);
  background: var(--surface-panel-soft);
}

.find-dialog-tab {
  height: 26px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 3px 3px 0 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.find-dialog-tab:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-hover);
}

.find-dialog-tab.active {
  border-color: var(--color-border);
  background: var(--surface-panel-strong);
  color: var(--color-text-primary);
}

.find-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
}

.find-dialog-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 152px;
  gap: 12px;
  align-items: start;
}

.find-dialog-left {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.find-dialog-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 6px;
  align-items: center;
}

.find-dialog-row label {
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
}

.find-dialog-input {
  width: 100%;
  height: 25px;
  min-width: 0;
  padding: 0 7px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  outline: 0;
}

.find-dialog-input:focus-visible {
  outline: 1px solid var(--color-accent-blue);
  outline-offset: -1px;
}

.find-dialog-selection {
  padding-left: 84px;
}

.find-dialog-options {
  display: grid;
  gap: 4px;
  padding-top: 2px;
}

.find-dialog-options.file-options {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.find-dialog-check {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 19px;
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 1.3;
  cursor: pointer;
}

.find-dialog-check input[type="checkbox"],
.find-dialog-check input[type="radio"] {
  width: 14px;
  height: 14px;
  flex: none;
  margin: 0;
  accent-color: var(--color-accent-blue);
}

.find-dialog-check input:disabled {
  opacity: .45;
}

.find-dialog-mode,
.find-dialog-transparency {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--surface-panel-soft);
}

.find-dialog-group-title {
  margin-bottom: 2px;
  color: var(--color-text-secondary);
  font-size: 11px;
}

.find-dialog-regex-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}

.find-dialog-right {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.find-dialog-button {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--surface-panel-strong);
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.find-dialog-button:hover:not(:disabled) {
  border-color: var(--surface-accent-blue-border);
  background: var(--surface-accent-blue-soft);
}

.find-dialog-button:disabled {
  opacity: .55;
  cursor: default;
}

.find-dialog-transparency {
  margin-top: 4px;
}

.find-dialog-slider {
  width: 100%;
  height: 16px;
  margin: 0;
  accent-color: var(--color-accent-blue);
}

.find-dialog-results {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--surface-panel-soft);
}

.find-dialog-results-title {
  flex: none;
  padding: 4px 8px;
  border-bottom: 1px solid var(--surface-divider-soft);
  color: var(--color-text-secondary);
  font-size: 11px;
}

.find-dialog-results-list {
  max-height: 168px;
  overflow-y: auto;
}

.find-dialog-result {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 6px;
  width: 100%;
  min-height: 22px;
  padding: 0 8px;
  border: 0;
  border-bottom: 1px solid var(--surface-divider-muted);
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.find-dialog-result:hover {
  background: var(--color-bg-hover);
}

.find-dialog-result-line {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.find-dialog-result-preview {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.find-dialog-results-empty {
  padding: 8px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.find-dialog-status {
  min-height: 18px;
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 18px;
}

.find-dialog-status.error {
  color: var(--color-accent-red, var(--color-text-primary));
}

.find-dialog :deep(.find-dialog-mark) {
  border-radius: 2px;
  background: var(--surface-accent-blue-soft);
  outline: 1px solid var(--surface-accent-blue-border);
}
</style>
