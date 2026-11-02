<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { fileIconComponents, fileIconTone } from '@/lib/fileIcons'
import { useWorkspaceStore } from '@/stores/workspace'
import type { CliChatChange, CliChatTurn } from '@/lib/tauri'

type Change = CliChatChange
type Entry = { key: string; turnId: string; change: Change }
type FileRow = { path: string; entries: Entry[]; added: number; removed: number }
type Preview = { oldText: string; newText: string; canUndo: boolean; reason: string }
type Tree = { name: string; path: string; dirs: Tree[]; files: FileRow[] }
const props = defineProps<{ session: { id: string; cwd: string }; turns: CliChatTurn[] }>()
const emit = defineEmits<{ summary: [value: Array<{ turnId: string; files: number; added: number; removed: number }>] }>()
const store = useWorkspaceStore()
const dismissed = ref(new Set<string>())
const expanded = ref(false)
const closedDirs = ref(new Set<string>())
const error = ref('')
const busy = ref(false)
let previewRevision = 0

function storageKey() { return `superhigh.chat-changes.${props.session.id}` }
function loadDismissed() {
  try { const value = JSON.parse(localStorage.getItem(storageKey()) || '[]'); dismissed.value = new Set(Array.isArray(value) ? value.filter(x => typeof x === 'string') : []) }
  catch { dismissed.value = new Set() }
}
function persist() { try { localStorage.setItem(storageKey(), JSON.stringify([...dismissed.value])) } catch { /* Storage may be disabled. */ } }
watch(() => [props.session.id, props.session.cwd], () => { previewRevision++; loadDismissed(); error.value = '' }, { immediate: true })
const entries = computed<Entry[]>(() => props.turns.flatMap(turn => {
  const changes = (turn as CliChatTurn & { changes?: Change[] }).changes || []
  return changes.map((change, index) => ({ key: `${turn.id}:${index}`, turnId: turn.id, change }))
}))
// New native records can arrive while a preview or batch is pending.  A preview
// built from an earlier edit list must never authorize a later undo.
watch(() => JSON.stringify(entries.value), () => { previewRevision++; error.value = '' })
const summary = computed(() => props.turns.map(turn => {
  const changes = entries.value.filter(entry => entry.turnId === turn.id && !entry.change.kind.startsWith('unconfirmed-'))
  return { turnId: turn.id, files: new Set(changes.map(entry => entry.change.path)).size,
    added: changes.reduce((n, entry) => n + entry.change.added, 0), removed: changes.reduce((n, entry) => n + entry.change.removed, 0) }
}))
watch(summary, value => emit('summary', value), { immediate: true })
const files = computed<FileRow[]>(() => {
  const grouped = new Map<string, FileRow>()
  for (const entry of entries.value) {
    if (dismissed.value.has(entry.key)) continue
    const key = entry.change.path.replace(/\\/g, '/')
    let file = grouped.get(key)
    if (!file) { file = { path: entry.change.path, entries: [], added: 0, removed: 0 }; grouped.set(key, file) }
    file.entries.push(entry)
    if (!entry.change.kind.startsWith('unconfirmed-')) { file.added += entry.change.added; file.removed += entry.change.removed }
  }
  return [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path))
})
function displayPath(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const root = props.session.cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized
}
function absolutePath(path: string, cwd = props.session.cwd) {
  return /^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? path : `${cwd.replace(/[\\/]$/, '')}/${path}`
}
const tree = computed<Tree>(() => {
  const root: Tree = { name: '', path: '', dirs: [], files: [] }
  for (const file of files.value) {
    const parts = displayPath(file.path).split('/').filter(Boolean)
    let node = root
    for (const name of parts.slice(0, -1)) {
      let dir = node.dirs.find(item => item.name === name)
      if (!dir) { dir = { name, path: node.path ? `${node.path}/${name}` : name, dirs: [], files: [] }; node.dirs.push(dir) }
      node = dir
    }
    node.files.push(file)
  }
  return root
})
const visibleRows = computed(() => {
  const rows: Array<{ dir?: Tree; file?: FileRow; depth: number }> = []
  function visit(node: Tree, depth: number) {
    for (const dir of [...node.dirs].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ dir, depth })
      if (!closedDirs.value.has(dir.path)) visit(dir, depth + 1)
    }
    for (const file of node.files) rows.push({ file, depth })
  }
  visit(tree.value, 0); return rows
})
function directoryFiles(dir: Tree): FileRow[] { return [...dir.files, ...dir.dirs.flatMap(directoryFiles)] }
function fileStatus(file: FileRow) {
  const kind = file.entries[file.entries.length - 1]?.change.kind || ''
  const pending = kind.startsWith('unconfirmed-')
  const action = kind.replace(/^unconfirmed-/, '')
  const label = action === 'add' ? '新增' : action === 'delete' ? '删除' : '修改'
  return { label: pending ? label : `已${label}`, tone: action === 'add' ? 'added' : action === 'delete' ? 'deleted' : 'modified' }
}
function keep(rows: FileRow[]) {
  dismissed.value = new Set([...dismissed.value, ...rows.flatMap(row => row.entries.map(entry => entry.key))])
  persist()
}
async function readPreview(file: FileRow, cwd: string): Promise<Preview> {
  return invoke<Preview>('chat_edit_preview_command', { cwd, path: file.path, changes: file.entries.map(entry => entry.change) })
}
async function open(file: FileRow) {
  await store.openChatChangePreview(absolutePath(file.path), props.session.cwd, file.entries.map(entry => entry.change))
}
async function undo(rows: FileRow[]) {
  if (busy.value) return
  busy.value = true; error.value = ''
  const { id, cwd } = props.session
  const revision = previewRevision
  const active = () => props.session.id === id && props.session.cwd === cwd && previewRevision === revision
  const errors: string[] = []
  for (const file of rows) {
    if (!active()) break
    try {
      const result = await readPreview(file, cwd)
      if (!active()) break
      if (!result.canUndo) { errors.push(`${file.path}: ${result.reason}`); continue }
      await invoke('chat_edit_undo_command', { cwd, path: file.path, changes: file.entries.map(entry => entry.change), expected: result.newText })
      // Record completion under the initiating session even if the user switched during invoke.
      if (active()) keep([file])
      else {
        const key = `superhigh.chat-changes.${id}`
        try { const old = JSON.parse(localStorage.getItem(key) || '[]'); localStorage.setItem(key, JSON.stringify([...new Set([...(Array.isArray(old) ? old : []), ...file.entries.map(entry => entry.key)])])) } catch { /* Storage may be disabled. */ }
        break
      }
    } catch (e) { if (active()) errors.push(`${file.path}: ${String(e)}`) }
  }
  if (active()) error.value = errors.join('\n')
  busy.value = false
}
function toggleDir(path: string) {
  const next = new Set(closedDirs.value); next.has(path) ? next.delete(path) : next.add(path); closedDirs.value = next
}
</script>

<template>
  <section v-if="files.length" class="chat-changes">
    <div class="changes-header">
      <button class="changes-title" @click="expanded = !expanded"><ChevronDown v-if="expanded" :size="14"/><ChevronRight v-else :size="14"/>{{ files.length }} 个文件 <span class="add">+{{ files.reduce((n, f) => n + f.added, 0) }}</span> <span class="remove">-{{ files.reduce((n, f) => n + f.removed, 0) }}</span></button>
      <button :disabled="busy" @click="keep(files)">全部保留</button><button :disabled="busy" @click="undo(files)">全部撤销</button>
    </div>
    <div v-if="expanded" class="changes-tree">
      <div v-for="row in visibleRows" :key="row.dir ? `d:${row.dir.path}` : `f:${row.file!.path}`" class="change-row" :style="{ paddingLeft: `${row.depth * 12 + 4}px` }">
        <template v-if="row.dir">
          <button class="row-name" :title="row.dir.path" @click="toggleDir(row.dir.path)"><ChevronRight v-if="closedDirs.has(row.dir.path)" :size="13"/><ChevronDown v-else :size="13"/>{{ row.dir.name }}</button>
          <button :disabled="busy" @click="keep(directoryFiles(row.dir))">保留</button><button :disabled="busy" @click="undo(directoryFiles(row.dir))">撤销</button>
        </template>
        <template v-else-if="row.file">
          <button class="row-name" :title="row.file.path" @click="open(row.file)"><span class="tree-kind-icon" :class="fileIconTone(row.file.path)"><component :is="fileIconComponents[fileIconTone(row.file.path)]" :size="14" /></span>{{ displayPath(row.file.path).split('/').pop() }}</button>
          <span class="change-status" :class="`change-status-${fileStatus(row.file).tone}`">{{ fileStatus(row.file).label }}</span><span class="add">+{{ row.file.added }}</span><span class="remove">-{{ row.file.removed }}</span><span v-if="row.file.entries.some(e => e.change.kind.startsWith('unconfirmed-'))" title="原生日志尚未确认此操作成功">未确认</span><span v-else-if="row.file.entries.some(e => !e.change.supported || e.change.kind === 'delete')" title="缺少安全还原所需信息">不可撤销</span>
          <button :disabled="busy" @click="keep([row.file])">保留</button><button :disabled="busy || row.file.entries.some(e => !e.change.supported || e.change.kind === 'delete')" @click="undo([row.file])">撤销</button>
        </template>
      </div>
    </div>
    <div v-if="error" class="changes-error">{{ error }}</div>
  </section>
</template>

<style scoped>
.chat-changes { border: 1px solid var(--color-border); font: inherit; min-width: 0; }
.changes-header, .change-row { display: flex; align-items: center; gap: 5px; }
.changes-header { padding: 3px 5px; }
button { font-size: 12px; color: inherit; background: transparent; border: 0; border-radius: 3px; padding: 3px 5px; font-family: inherit; cursor: pointer; white-space: nowrap; }
button:hover { background: var(--color-bg-hover); }
button:disabled { opacity: .5; cursor: default; }
.changes-title, .row-name { display: flex; align-items: center; gap: 3px; text-align: left; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.changes-tree { border-top: 1px solid var(--color-border); max-height: 200px; overflow: auto; }
.change-row { min-width: 0; padding-right: 5px; }
.change-status { display: inline-flex; align-items: center; flex-shrink: 0; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--change-status-tone) 45%, transparent); border-radius: 3px; background: color-mix(in srgb, var(--change-status-tone) 12%, transparent); color: var(--color-text-primary); font-family: var(--font-ui); font-size: 12px; line-height: 18px; white-space: nowrap; }
.change-status-modified { --change-status-tone: var(--color-accent-blue); }
.change-status-added { --change-status-tone: var(--color-accent-green); }
.change-status-deleted { --change-status-tone: var(--color-accent-red); }
.add { color: var(--color-accent-green); } .remove { color: var(--color-accent-red); }
.changes-error { color: var(--color-accent-red); white-space: pre-wrap; padding: 6px; }
</style>
