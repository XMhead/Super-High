<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type * as MonacoTypes from 'monaco-editor'

import { loadMonaco, MONACO_UNICODE_HIGHLIGHT } from '@/lib/monaco'
import { inferLanguage } from '@/lib/path'
import { toMonacoThemeDefinition } from '@/lib/theme'
import { useWorkspaceStore } from '@/stores/workspace'

const props = defineProps<{
  path: string
  oldText: string
  newText: string
}>()

const MONACO_THEME_ID = 'super-high-dynamic'

const store = useWorkspaceStore()
const host = ref<HTMLDivElement | null>(null)
let monaco: Awaited<ReturnType<typeof loadMonaco>> | null = null
let diffEditor: MonacoTypes.editor.IStandaloneDiffEditor | null = null
let originalModel: MonacoTypes.editor.ITextModel | null = null
let modifiedModel: MonacoTypes.editor.ITextModel | null = null
let pendingReveal = false
let disposed = false

function monoFontFamily() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
}

function monoFontWeight() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono-weight').trim() || 'normal'
}

// 切换文件时复用同一对模型，只替换内容和语言，避免反复销毁重建编辑器状态。
function applyModels() {
  if (!monaco || !diffEditor) return
  const language = inferLanguage(props.path)
  if (!originalModel || !modifiedModel) {
    originalModel = monaco.editor.createModel(props.oldText, language)
    modifiedModel = monaco.editor.createModel(props.newText, language)
    diffEditor.setModel({ original: originalModel, modified: modifiedModel })
  } else {
    if (originalModel.getLanguageId() !== language) monaco.editor.setModelLanguage(originalModel, language)
    if (modifiedModel.getLanguageId() !== language) monaco.editor.setModelLanguage(modifiedModel, language)
    originalModel.setValue(props.oldText)
    modifiedModel.setValue(props.newText)
  }
  pendingReveal = true
  diffEditor.getModifiedEditor().setScrollTop(0)
}

function syncTheme() {
  if (!monaco) return
  monaco.editor.defineTheme(MONACO_THEME_ID, toMonacoThemeDefinition(store.currentThemeId))
  monaco.editor.setTheme(MONACO_THEME_ID)
}

onMounted(async () => {
  monaco = await loadMonaco()
  if (disposed || !host.value) return
  monaco.editor.defineTheme(MONACO_THEME_ID, toMonacoThemeDefinition(store.currentThemeId))
  diffEditor = monaco.editor.createDiffEditor(host.value, {
    theme: MONACO_THEME_ID,
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    renderSideBySide: false,
    enableSplitViewResizing: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    stickyScroll: { enabled: false },
    unicodeHighlight: MONACO_UNICODE_HIGHLIGHT,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 6,
    // 折叠未改动的大段代码，只保留改动附近的上下文；折叠条可点击展开。
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
    maxComputationTime: 3000,
    fontFamily: monoFontFamily(),
    fontWeight: monoFontWeight(),
    fontSize: 13,
    lineHeight: 20,
    renderOverviewRuler: false,
    renderMarginRevertIcon: false,
    ignoreTrimWhitespace: false,
    diffWordWrap: 'off',
  })
  diffEditor.onDidUpdateDiff(() => {
    if (!pendingReveal) return
    pendingReveal = false
    diffEditor?.revealFirstDiff()
  })
  applyModels()
})

watch(() => [props.path, props.oldText, props.newText] as const, applyModels)
watch(() => store.currentThemeId, syncTheme)
watch(() => store.settings.fontStyleId, () => {
  diffEditor?.updateOptions({ fontFamily: monoFontFamily(), fontWeight: monoFontWeight() })
})

onBeforeUnmount(() => {
  disposed = true
  diffEditor?.setModel(null)
  diffEditor?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
  diffEditor = null
  monaco = null
})
</script>

<template>
  <div ref="host" class="git-diff-viewer" />
</template>

<style scoped>
.git-diff-viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--color-bg-primary);
}
</style>
