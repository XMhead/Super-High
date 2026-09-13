<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { CalendarDays, Eye, EyeOff, NotebookPen, Plus, Search, Trash2, X } from 'lucide-vue-next'

import { backend } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type { MemoRecord } from '@/types'

const store = useWorkspaceStore()
const DEFAULT_WIDTH = 760
const DEFAULT_HEIGHT = 620
const MIN_WIDTH = 520
const MIN_HEIGHT = 360
const TOP_BOUNDARY = 76
const STATUS_BAR_HEIGHT = 22
const resizeEdges = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const

type ResizeEdge = typeof resizeEdges[number]
type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const notes = ref<MemoRecord[]>([])
const selectedId = ref('')
const query = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const loading = ref(false)
const creating = ref(false)
const deleting = ref(false)
const loaded = ref(false)
const error = ref('')
const saveStatus = ref<SaveStatus>('idle')
const previewMode = ref(false)
const dateMenuOpen = ref(false)
const dateControl = ref<HTMLElement | null>(null)
const windowRoot = ref<HTMLElement | null>(null)
const frame = reactive({ left: 0, top: 76, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })

const selectedMemo = computed(() => notes.value.find((note) => note.id === selectedId.value) ?? null)
const hasDateFilter = computed(() => !!dateFrom.value || !!dateTo.value)
const frameStyle = computed(() => ({
  left: `${frame.left}px`,
  top: `${frame.top}px`,
  width: `${frame.width}px`,
  height: `${frame.height}px`,
}))
const saveStatusText = computed(() => {
  if (saveStatus.value === 'dirty') return '等待保存'
  if (saveStatus.value === 'saving') return '正在保存...'
  if (saveStatus.value === 'saved') return '已保存'
  if (saveStatus.value === 'error') return '保存失败'
  return ''
})

let loadTimer: number | null = null
let saveTimer: number | null = null
let loadSequence = 0
let saveInFlight: Promise<boolean> | null = null
let needsSave = false
let activePointer: {
  mode: 'drag' | 'resize'
  startX: number
  startY: number
  left: number
  top: number
  width: number
  height: number
  edge?: ResizeEdge
} | null = null

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`
}

function displayTitle(note: MemoRecord) {
  return note.title.trim() || formatTimestamp(note.createdAt)
}

function contentPreview(note: MemoRecord) {
  return note.content.replace(/\s+/g, ' ').trim() || '空白备忘录'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const LINKIFY_PATTERN = /(https?:\/\/[^\s<>"'，。；：！？、]+)/g

// 把正文里的网页链接渲染成可点击链接，其余内容一律转义成纯文本。
function linkifyUrls(value: string): string {
  return escapeHtml(value).replace(LINKIFY_PATTERN, (url) => {
    const trimmed = url.replace(/[.,;:!?)]+$/, '')
    if (!trimmed) return url
    const href = trimmed.replace(/&amp;/g, '&')
    return `<a href="${href}" target="_blank" rel="noopener">${trimmed}</a>`
  })
}

const previewContent = computed(() => (selectedMemo.value ? linkifyUrls(selectedMemo.value.content) : ''))

function dateBoundary(value: string, nextDay = false) {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString()
}

async function loadMemos(preferredId?: string) {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await backend.listMemos({
      text: query.value.trim() || undefined,
      createdFrom: dateBoundary(dateFrom.value),
      createdBefore: dateBoundary(dateTo.value, true),
    })
    if (sequence !== loadSequence) return
    notes.value = result
    const nextId = preferredId || selectedId.value
    selectedId.value = result.some((note) => note.id === nextId) ? nextId : (result[0]?.id ?? '')
    loaded.value = true
    saveStatus.value = 'idle'
  } catch (caught) {
    if (sequence !== loadSequence) return
    error.value = formatError(caught)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function scheduleLoad() {
  if (!loaded.value) return
  if (loadTimer != null) window.clearTimeout(loadTimer)
  loadTimer = window.setTimeout(() => {
    loadTimer = null
    void flushSave().then((saved) => {
      if (saved) return loadMemos()
    })
  }, 220)
}

function markDirty() {
  needsSave = true
  saveStatus.value = 'dirty'
  if (saveTimer != null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, 400)
}

async function flushSave(): Promise<boolean> {
  if (saveTimer != null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saveInFlight) {
    const saved = await saveInFlight
    if (!saved || !needsSave) return saved
  }
  const note = selectedMemo.value
  if (!needsSave || !note) return true
  const snapshot = { title: note.title, content: note.content }
  needsSave = false
  saveStatus.value = 'saving'
  error.value = ''
  saveInFlight = backend.updateMemo(note.id, snapshot.title, snapshot.content)
    .then((saved) => {
      if (note.title === snapshot.title && note.content === snapshot.content) {
        Object.assign(note, saved)
        saveStatus.value = 'saved'
      } else {
        note.updatedAt = saved.updatedAt
        needsSave = true
        saveStatus.value = 'dirty'
      }
      return true
    })
    .catch((caught) => {
      needsSave = true
      saveStatus.value = 'error'
      error.value = `保存失败：${formatError(caught)}`
      return false
    })
    .finally(() => {
      saveInFlight = null
    })
  const saved = await saveInFlight
  if (saved && needsSave) return flushSave()
  return saved
}

async function createMemo() {
  if (creating.value || !(await flushSave())) return
  creating.value = true
  error.value = ''
  query.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  dateMenuOpen.value = false
  try {
    const created = await backend.createMemo()
    await loadMemos(created.id)
    await nextTick()
    windowRoot.value?.querySelector<HTMLTextAreaElement>('.memo-content-input')?.focus()
  } catch (caught) {
    error.value = `新增失败：${formatError(caught)}`
  } finally {
    creating.value = false
  }
}

async function selectMemo(id: string) {
  if (id === selectedId.value || !(await flushSave())) return
  selectedId.value = id
  saveStatus.value = 'idle'
}

async function deleteSelectedMemo() {
  const note = selectedMemo.value
  if (!note || deleting.value) return
  if (!window.confirm(`删除“${displayTitle(note)}”？`)) return
  deleting.value = true
  error.value = ''
  try {
    await backend.deleteMemo(note.id)
    const index = notes.value.findIndex((item) => item.id === note.id)
    notes.value.splice(index, 1)
    selectedId.value = notes.value[Math.min(index, notes.value.length - 1)]?.id ?? ''
    needsSave = false
    saveStatus.value = 'idle'
  } catch (caught) {
    error.value = `删除失败：${formatError(caught)}`
  } finally {
    deleting.value = false
  }
}

async function closeWindow() {
  if (!(await flushSave())) return
  store.setMemoWindowOpen(false)
}

function clearDateFilter() {
  dateFrom.value = ''
  dateTo.value = ''
  dateMenuOpen.value = false
}

function normalizeFrame() {
  const viewportWidth = Math.max(320, window.innerWidth)
  const viewportBottom = Math.max(TOP_BOUNDARY + 240, window.innerHeight - STATUS_BAR_HEIGHT)
  const availableHeight = viewportBottom - TOP_BOUNDARY
  const minWidth = Math.min(MIN_WIDTH, viewportWidth)
  const minHeight = Math.min(MIN_HEIGHT, availableHeight)
  frame.width = Math.min(viewportWidth, Math.max(minWidth, frame.width))
  frame.height = Math.min(availableHeight, Math.max(minHeight, frame.height))
  frame.left = Math.min(Math.max(0, frame.left), Math.max(0, viewportWidth - frame.width))
  frame.top = Math.min(Math.max(TOP_BOUNDARY, frame.top), Math.max(TOP_BOUNDARY, viewportBottom - frame.height))
}

function restoreFrame() {
  const saved = store.settings.memoWindowFrame
  frame.width = typeof saved?.width === 'number' && Number.isFinite(saved.width) ? saved.width : DEFAULT_WIDTH
  frame.height = typeof saved?.height === 'number' && Number.isFinite(saved.height) ? saved.height : DEFAULT_HEIGHT
  frame.left = typeof saved?.left === 'number' && Number.isFinite(saved.left)
    ? saved.left
    : Math.max(16, window.innerWidth - frame.width - 20)
  frame.top = typeof saved?.top === 'number' && Number.isFinite(saved.top) ? saved.top : 76
  normalizeFrame()
}

function persistFrame() {
  store.setMemoWindowFrame({ ...frame }, true)
}

function startPointer(mode: 'drag' | 'resize', event: PointerEvent, edge?: ResizeEdge) {
  event.preventDefault()
  activePointer = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
    edge,
  }
  window.addEventListener('pointermove', movePointer)
  window.addEventListener('pointerup', stopPointer)
}

function movePointer(event: PointerEvent) {
  if (!activePointer) return
  const deltaX = event.clientX - activePointer.startX
  const deltaY = event.clientY - activePointer.startY
  if (activePointer.mode === 'drag') {
    frame.left = activePointer.left + deltaX
    frame.top = activePointer.top + deltaY
    normalizeFrame()
    return
  }
  const edge = activePointer.edge ?? 'se'
  let nextLeft = activePointer.left
  let nextTop = activePointer.top
  let nextWidth = activePointer.width
  let nextHeight = activePointer.height
  if (edge.includes('e')) nextWidth = activePointer.width + deltaX
  if (edge.includes('s')) nextHeight = activePointer.height + deltaY
  if (edge.includes('w')) {
    nextWidth = activePointer.width - deltaX
    nextLeft = activePointer.left + deltaX
  }
  if (edge.includes('n')) {
    nextHeight = activePointer.height - deltaY
    nextTop = activePointer.top + deltaY
  }
  frame.left = nextLeft
  frame.top = nextTop
  frame.width = nextWidth
  frame.height = nextHeight
  normalizeFrame()
}

function stopPointer() {
  if (!activePointer) return
  activePointer = null
  window.removeEventListener('pointermove', movePointer)
  window.removeEventListener('pointerup', stopPointer)
  persistFrame()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!dateMenuOpen.value || dateControl.value?.contains(event.target as Node)) return
  dateMenuOpen.value = false
}

function formatError(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

watch([query, dateFrom, dateTo], scheduleLoad)
watch(() => store.memoWindowOpen, (open) => {
  if (!open) {
    dateMenuOpen.value = false
    void flushSave()
    return
  }
  restoreFrame()
  if (!loaded.value) void loadMemos()
})

onMounted(() => {
  restoreFrame()
  window.addEventListener('resize', normalizeFrame)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  if (store.memoWindowOpen) void loadMemos()
})

onBeforeUnmount(() => {
  if (loadTimer != null) window.clearTimeout(loadTimer)
  if (saveTimer != null) window.clearTimeout(saveTimer)
  void flushSave()
  stopPointer()
  window.removeEventListener('resize', normalizeFrame)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})
</script>

<template>
  <section ref="windowRoot" class="memo-window" aria-label="备忘录" :style="frameStyle">
    <header class="memo-titlebar" @pointerdown="startPointer('drag', $event)">
      <span class="memo-window-title"><NotebookPen :size="14" />备忘录</span>
      <div class="memo-titlebar-actions" @pointerdown.stop>
        <button type="button" title="新增备忘录" :disabled="creating" @click="createMemo">
          <Plus :size="15" />
        </button>
        <button type="button" title="关闭备忘录" @click="closeWindow">
          <X :size="15" />
        </button>
      </div>
    </header>

    <div class="memo-toolbar">
      <label class="memo-search">
        <Search :size="13" />
        <input v-model="query" type="search" placeholder="搜索标题、正文或时间" />
        <button v-if="query" type="button" title="清空搜索" @click="query = ''"><X :size="12" /></button>
      </label>
      <div ref="dateControl" class="memo-date-control">
        <button
          class="memo-date-button"
          :class="{ active: hasDateFilter || dateMenuOpen }"
          type="button"
          title="按创建日期筛选"
          @click="dateMenuOpen = !dateMenuOpen"
        >
          <CalendarDays :size="14" />
          <span v-if="hasDateFilter">{{ dateFrom || '起始' }} - {{ dateTo || '今天' }}</span>
        </button>
        <div v-if="dateMenuOpen" class="memo-date-menu">
          <label><span>从</span><input v-model="dateFrom" type="date" :max="dateTo || undefined" /></label>
          <label><span>到</span><input v-model="dateTo" type="date" :min="dateFrom || undefined" /></label>
          <button type="button" title="清除日期筛选" :disabled="!hasDateFilter" @click="clearDateFilter">
            <X :size="13" /><span>清除</span>
          </button>
        </div>
      </div>
      <button class="memo-add-button" type="button" title="新增备忘录" :disabled="creating" @click="createMemo">
        <Plus :size="14" /><span>{{ creating ? '新增中...' : '新增' }}</span>
      </button>
    </div>

    <div class="memo-body">
      <aside class="memo-list" aria-label="备忘录时间线">
        <div v-if="loading && !notes.length" class="memo-empty">正在读取...</div>
        <button
          v-for="note in notes"
          :key="note.id"
          class="memo-list-item"
          :class="{ active: note.id === selectedId }"
          type="button"
          @click="selectMemo(note.id)"
        >
          <strong>{{ displayTitle(note) }}</strong>
          <span>{{ contentPreview(note) }}</span>
          <time :datetime="note.createdAt">{{ formatTimestamp(note.createdAt) }}</time>
        </button>
        <div v-if="!loading && !notes.length" class="memo-empty">
          {{ query || hasDateFilter ? '没有匹配的备忘录' : '还没有备忘录' }}
        </div>
      </aside>

      <main class="memo-editor">
        <template v-if="selectedMemo">
          <div class="memo-editor-heading">
            <input
              v-model="selectedMemo.title"
              class="memo-title-input"
              type="text"
              placeholder="标题（可选）"
              aria-label="备忘录标题"
              @input="markDirty"
              @blur="flushSave"
            />
            <button
              class="memo-preview-button"
              :class="{ active: previewMode }"
              type="button"
              :title="previewMode ? '返回编辑模式' : '预览正文，网页链接可点击打开'"
              @click="previewMode = !previewMode"
            >
              <EyeOff v-if="previewMode" :size="13" />
              <Eye v-else :size="13" />
              <span>{{ previewMode ? '编辑' : '预览' }}</span>
            </button>
            <button type="button" title="删除备忘录" :disabled="deleting" @click="deleteSelectedMemo">
              <Trash2 :size="14" />
            </button>
          </div>
          <div class="memo-metadata">
            <span>创建 {{ formatTimestamp(selectedMemo.createdAt) }}</span>
            <span v-if="saveStatusText" :class="`is-${saveStatus}`">{{ saveStatusText }}</span>
          </div>
          <textarea
            v-if="!previewMode"
            v-model="selectedMemo.content"
            class="memo-content-input"
            aria-label="备忘录正文"
            placeholder="直接输入备忘内容"
            spellcheck="false"
            @input="markDirty"
            @blur="flushSave"
          />
          <div v-else class="memo-content-preview" v-html="previewContent" />
        </template>
        <div v-else class="memo-editor-empty">
          <NotebookPen :size="24" />
          <span>{{ loading ? '正在读取...' : '选择或新增一条备忘录' }}</span>
        </div>
      </main>
    </div>

    <div v-if="error" class="memo-error" role="status">{{ error }}</div>
    <div v-for="edge in resizeEdges" :key="edge" class="memo-resize" :class="`is-${edge}`" @pointerdown="startPointer('resize', $event, edge)" />
  </section>
</template>

<style scoped>
.memo-window { position: fixed; z-index: 1210; container: memo-window / inline-size; display: grid; grid-template-rows: 34px 38px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-primary); background: var(--color-bg-primary); box-shadow: none; }
.memo-titlebar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 0 5px 0 10px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); cursor: move; user-select: none; }
.memo-window-title { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; font-weight: 700; white-space: nowrap; }
.memo-titlebar-actions { display: flex; align-items: center; gap: 2px; }
.memo-titlebar button, .memo-editor-heading button, .memo-search button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 4px; color: var(--color-text-secondary); background: transparent; cursor: pointer; }
.memo-titlebar button:hover, .memo-editor-heading button:hover, .memo-search button:hover { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-toolbar { position: relative; z-index: 2; display: flex; align-items: center; gap: 5px; min-width: 0; padding: 5px 7px; border-bottom: 1px solid var(--color-border); background: var(--surface-panel); overflow: visible; }
.memo-search { display: flex; align-items: center; gap: 5px; min-width: 120px; height: 27px; flex: 1 1 auto; padding: 0 4px 0 7px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-muted); background: var(--color-bg-primary); }
.memo-search:focus-within { border-color: var(--color-accent-blue); }
.memo-search input { min-width: 0; flex: 1; border: 0; outline: 0; color: var(--color-text-primary); background: transparent; font: inherit; font-size: 11px; }
.memo-search input::-webkit-search-cancel-button { display: none; }
.memo-search button { width: 20px; height: 20px; }
.memo-date-control { position: relative; flex: 0 0 auto; }
.memo-date-button, .memo-add-button, .memo-date-menu button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 27px; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); background: var(--color-bg-primary); cursor: pointer; font-size: 11px; white-space: nowrap; }
.memo-date-button.active, .memo-date-button:hover, .memo-add-button:hover { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-add-button { color: var(--color-text-primary); border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.memo-date-menu { position: absolute; top: calc(100% + 5px); right: 0; z-index: 3; display: grid; gap: 7px; width: 230px; padding: 8px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-bg-secondary); box-shadow: none; }
.memo-date-menu label { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: 11px; }
.memo-date-menu input { min-width: 0; height: 26px; padding: 0 6px; border: 1px solid var(--color-border); border-radius: 3px; outline: 0; color: var(--color-text-primary); color-scheme: dark; background: var(--color-bg-primary); font: inherit; }
.memo-date-menu input:focus { border-color: var(--color-accent-blue); }
.memo-date-menu button { justify-self: end; }
.memo-body { display: grid; grid-template-columns: minmax(180px, 32%) minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
.memo-list { min-width: 0; min-height: 0; overflow-y: auto; padding: 6px; border-right: 1px solid var(--color-border); background: var(--surface-panel); }
.memo-list-item { display: grid; gap: 4px; width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid transparent; border-radius: 4px; color: var(--color-text-secondary); text-align: left; background: transparent; cursor: pointer; }
.memo-list-item + .memo-list-item { margin-top: 3px; }
.memo-list-item:hover { border-color: var(--color-border); background: var(--color-bg-secondary); }
.memo-list-item.active { border-color: var(--surface-accent-blue-border); background: var(--surface-accent-blue-soft); }
.memo-list-item strong, .memo-list-item span, .memo-list-item time { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memo-list-item strong { color: var(--color-text-primary); font-size: 11px; }
.memo-list-item span { font-size: 10px; }
.memo-list-item time { color: var(--color-text-muted); font-size: 9px; }
.memo-empty { padding: 18px 8px; color: var(--color-text-muted); font-size: 11px; text-align: center; }
.memo-editor { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; min-height: 0; padding: 9px; background: var(--color-bg-primary); }
.memo-editor-heading { display: flex; align-items: center; gap: 5px; min-width: 0; }
.memo-title-input { min-width: 0; height: 28px; flex: 1; padding: 0 7px; border: 1px solid var(--color-border); border-radius: 4px; outline: 0; color: var(--color-text-primary); background: var(--color-bg-secondary); font: inherit; font-size: 12px; font-weight: 600; }
.memo-title-input:focus { border-color: var(--color-accent-blue); }
.memo-metadata { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; height: 25px; color: var(--color-text-muted); font-size: 9px; white-space: nowrap; }
.memo-metadata span { overflow: hidden; text-overflow: ellipsis; }
.memo-metadata .is-error { color: var(--color-accent-red); }
.memo-content-input { width: 100%; min-width: 0; min-height: 0; resize: none; padding: 9px; border: 1px solid var(--color-border); border-radius: 4px; outline: 0; color: var(--color-text-primary); background: var(--color-bg-secondary); font: inherit; font-size: 12px; line-height: 1.55; }
.memo-content-input:focus { border-color: var(--color-accent-blue); }
.memo-preview-button { width: auto; height: 26px; padding: 0 7px; gap: 4px; font-size: 11px; white-space: nowrap; }
.memo-preview-button.active { border-color: var(--surface-accent-blue-border); color: var(--color-text-primary); background: var(--surface-accent-blue-soft); }
.memo-content-preview { width: 100%; min-width: 0; min-height: 0; overflow: auto; padding: 9px; border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-primary); background: var(--color-bg-secondary); font: inherit; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.memo-content-preview a { color: var(--color-accent-blue); text-decoration: underline; }
.memo-content-preview a:hover { color: var(--color-accent-blue); }
.memo-editor-empty { grid-row: 1 / -1; display: flex; align-items: center; justify-content: center; gap: 7px; color: var(--color-text-muted); font-size: 11px; }
.memo-error { position: absolute; right: 8px; bottom: 8px; left: calc(32% + 9px); z-index: 2; max-height: 48px; overflow: auto; padding: 6px 8px; border: 1px solid var(--surface-accent-red-border); border-radius: 4px; color: var(--color-accent-red); background: var(--surface-accent-red-soft); font-size: 10px; }
.memo-resize { position: absolute; z-index: 4; }
.memo-resize.is-n, .memo-resize.is-s { left: 12px; width: calc(100% - 24px); height: 8px; cursor: ns-resize; }
.memo-resize.is-n { top: 0; }.memo-resize.is-s { bottom: 0; }
.memo-resize.is-e, .memo-resize.is-w { top: 12px; width: 8px; height: calc(100% - 24px); cursor: ew-resize; }
.memo-resize.is-e { right: 0; }.memo-resize.is-w { left: 0; }
.memo-resize.is-ne, .memo-resize.is-nw, .memo-resize.is-se, .memo-resize.is-sw { width: 18px; height: 18px; }
.memo-resize.is-ne { top: 0; right: 0; cursor: nesw-resize; }.memo-resize.is-nw { top: 0; left: 0; cursor: nwse-resize; }
.memo-resize.is-se { right: 0; bottom: 0; cursor: nwse-resize; }.memo-resize.is-sw { bottom: 0; left: 0; cursor: nesw-resize; }
button:disabled { opacity: 0.45; cursor: default; }

@container memo-window (max-width: 620px) {
  .memo-date-button span { display: none; }
  .memo-body { grid-template-columns: minmax(170px, 36%) minmax(0, 1fr); }
  .memo-error { left: calc(36% + 9px); }
}
</style>
