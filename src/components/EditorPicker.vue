<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  EDITOR_SCOPE_LABELS,
  EDITOR_SCOPE_ORDER,
  editorPathKey,
  loadEditorCatalog,
  openEditor,
  readRecentEditors,
  type EditorCatalogEntry,
  type EditorScope,
} from '@/lib/editorCatalog'
import type { SkillKind } from '@/lib/skillsCompletion'
import { useWorkspaceStore } from '@/stores/workspace'
import SourceBadge from './SourceBadge.vue'

type Filter = 'all' | EditorScope

const FILTERS: Filter[] = ['all', ...EDITOR_SCOPE_ORDER]
// 来源标识复用 SourceBadge：系统沿用其“系统”样式。
const BADGE_KINDS: Record<EditorScope, SkillKind> = { system: 'command', global: 'global', project: 'project' }

const store = useWorkspaceStore()
const open = ref(false)
const query = ref('')
const filter = ref<Filter>('all')
const editors = ref<EditorCatalogEntry[]>([])
const recent = ref<string[]>([])
const activeIndex = ref(0)
const loading = ref(false)
const error = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const listElement = ref<HTMLElement | null>(null)
let loadSequence = 0

const groups = computed(() => {
  const text = query.value.trim().toLocaleLowerCase()
  const matched = editors.value.filter((editor) => (filter.value === 'all' || editor.scope === filter.value)
    && (!text || `${editor.id} ${editor.entry}`.toLocaleLowerCase().includes(text)))
  const result: Array<{ key: string; label: string; items: EditorCatalogEntry[] }> = []
  let rest = matched
  if (!text && filter.value === 'all') {
    const recentItems = recent.value
      .map((key) => matched.find((editor) => editorPathKey(editor.path) === key))
      .filter((editor): editor is EditorCatalogEntry => !!editor)
    if (recentItems.length) {
      result.push({ key: 'recent', label: '最近', items: recentItems })
      rest = matched.filter((editor) => !recentItems.includes(editor))
    }
  }
  for (const scope of EDITOR_SCOPE_ORDER) {
    const items = rest.filter((editor) => editor.scope === scope)
    if (items.length) result.push({ key: scope, label: EDITOR_SCOPE_LABELS[scope], items })
  }
  return result
})
const flatItems = computed(() => groups.value.flatMap((group) => group.items))

async function show() {
  open.value = true
  query.value = ''
  filter.value = 'all'
  activeIndex.value = 0
  recent.value = readRecentEditors()
  await nextTick()
  searchInput.value?.focus()
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const catalog = await loadEditorCatalog(store.workspace?.rootPath)
    if (sequence === loadSequence) editors.value = catalog
  } catch (caught) {
    if (sequence === loadSequence) error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function close() {
  open.value = false
  loadSequence++
}

function toggle() {
  if (open.value) close()
  else void show()
}

async function choose(editor: EditorCatalogEntry | undefined) {
  if (!editor) return
  close()
  try {
    if (!await openEditor(store, editor)) store.showErrorMessage(`无法打开编辑器：${editor.id}`)
  } catch (caught) {
    store.showErrorMessage(`编辑器打开失败：${caught instanceof Error ? caught.message : String(caught)}`)
  }
}

function moveActive(delta: number) {
  const count = flatItems.value.length
  if (!count) return
  activeIndex.value = (activeIndex.value + delta + count) % count
  void nextTick(() => listElement.value?.querySelector('.editor-picker-item.active')?.scrollIntoView({ block: 'nearest' }))
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.ctrlKey || event.altKey || event.metaKey) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void choose(flatItems.value[activeIndex.value])
  } else if (event.key === 'Tab') {
    event.preventDefault()
    const index = FILTERS.indexOf(filter.value)
    filter.value = FILTERS[(index + (event.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length]
  } else if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

// F4 与 F1 相同：不带修饰键，在捕获阶段拦截，终端和 Monaco 不再收到该键。
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== 'F4' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (!event.repeat) toggle()
}

watch([query, filter], () => { activeIndex.value = 0 })

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('superhigh:toggle-editor-picker', toggle)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('superhigh:toggle-editor-picker', toggle)
})

defineExpose({ show, close })
</script>

<template>
  <div v-if="open" class="editor-picker-backdrop" @pointerdown.self="close">
    <section class="editor-picker" role="dialog" aria-label="选择编辑器">
      <input
        ref="searchInput"
        v-model="query"
        class="editor-picker-search"
        type="text"
        placeholder="搜索编辑器"
        autocomplete="off"
        spellcheck="false"
        @keydown="onSearchKeydown"
      >
      <nav class="script-tool-categories editor-picker-categories" aria-label="编辑器来源">
        <button
          v-for="item in FILTERS"
          :key="item"
          type="button"
          :class="{ active: item === filter }"
          :aria-pressed="item === filter"
          @click="filter = item; searchInput?.focus()"
        >
          <SourceBadge v-if="item !== 'all'" :kind="BADGE_KINDS[item]" /><template v-else>全部</template>
        </button>
      </nav>
      <div ref="listElement" class="editor-picker-list" role="listbox" aria-label="编辑器">
        <div v-if="error" class="editor-picker-empty error">{{ error }}</div>
        <div v-else-if="loading && !flatItems.length" class="editor-picker-empty">正在读取编辑器...</div>
        <div v-else-if="!flatItems.length" class="editor-picker-empty">{{ query.trim() ? '没有匹配的编辑器' : '此来源没有编辑器' }}</div>
        <template v-for="group in groups" :key="group.key">
          <div class="editor-picker-group">{{ group.label }} · {{ group.items.length }}</div>
          <button
            v-for="editor in group.items"
            :key="editor.path"
            type="button"
            role="option"
            class="editor-picker-item"
            :class="{ active: flatItems[activeIndex] === editor }"
            :aria-selected="flatItems[activeIndex] === editor"
            :title="editor.path"
            @pointermove="activeIndex = flatItems.indexOf(editor)"
            @click="choose(editor)"
          >
            <span class="editor-picker-name">{{ editor.id }}</span>
            <span class="editor-picker-entry">{{ editor.entry }}</span>
            <SourceBadge :kind="BADGE_KINDS[editor.scope]" />
          </button>
        </template>
      </div>
      <footer class="editor-picker-hints">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>Tab</kbd> 切换来源</span>
        <span><kbd>F4</kbd>/<kbd>Esc</kbd> 关闭</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.editor-picker-backdrop { position: fixed; inset: 0; z-index: 9000; display: flex; justify-content: center; align-items: flex-start; padding-top: 72px; }
.editor-picker { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 6px; width: min(520px, calc(100vw - 32px)); max-height: min(520px, calc(100vh - 104px)); padding: 8px; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-primary); background: var(--surface-panel, var(--color-bg-secondary)); box-shadow: 0 12px 36px rgb(0 0 0 / 30%); font-family: var(--font-ui); }
.editor-picker-search { height: 30px; padding: 0 9px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-primary); background: var(--color-bg-primary); font: inherit; font-size: 13px; outline: none; }
.editor-picker-search:focus { border-color: var(--color-accent-blue); }
.editor-picker-categories { position: static; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; background: transparent; }
.editor-picker-list { min-height: 0; overflow: auto; }
.editor-picker-group { padding: 6px 4px 3px; color: var(--color-text-muted); font-size: 11px; }
.editor-picker-item { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; color: var(--color-text-primary); background: transparent; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.editor-picker-item.active { border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.editor-picker-name, .editor-picker-entry { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.editor-picker-name { font-weight: var(--sh-weight-strong); }
.editor-picker-entry { color: var(--color-text-muted); font-size: 11px; }
.editor-picker-empty { padding: 12px 8px; color: var(--color-text-secondary); font-size: 12px; }
.editor-picker-empty.error { color: var(--color-accent-red); }
.editor-picker-hints { display: flex; flex-wrap: nowrap; gap: 12px; overflow-x: auto; padding: 5px 2px 0; border-top: 1px solid var(--surface-divider-muted, var(--color-border)); color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.editor-picker-hints kbd { margin-right: 2px; padding: 0 4px; border: 1px solid var(--color-border); border-radius: 3px; font-family: var(--font-mono); font-size: 10px; }
.editor-picker-list::-webkit-scrollbar { width: 5px; }
.editor-picker-list::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 3px; }
</style>
