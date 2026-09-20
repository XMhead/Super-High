<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ html: string }>()
const emit = defineEmits<{ navigate: [event: MouseEvent] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const reader = ref<HTMLElement | null>(null)
const query = ref('')
const expandedTable = ref('')
const copyMenu = ref<{ href: string; x: number; y: number } | null>(null)
const copyStatus = ref('')
let opener: HTMLButtonElement | null = null
let resizeObserver: ResizeObserver | undefined

function updateStickyColumn() {
  const width = reader.value?.querySelector('tr > :first-child')?.getBoundingClientRect().width ?? 0
  reader.value?.style.setProperty('--md-first-column-width', `${width}px`)
}
onMounted(() => {
  resizeObserver = new ResizeObserver(updateStickyColumn)
  if (reader.value) resizeObserver.observe(reader.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())

const content = computed(() => {
  const template = document.createElement('template')
  template.innerHTML = props.html
  template.content.querySelectorAll('table').forEach((table, index) => {
    const headers = [...table.querySelectorAll('thead th')]
    const columns = document.createElement('colgroup')
    headers.forEach((header) => {
      const col = document.createElement('col')
      const label = header.textContent?.trim() ?? ''
      col.className = /^(id|编号|序号)$/i.test(label) ? 'md-col-id'
        : /^(状态|status)$/i.test(label) ? 'md-col-status' : ''
      columns.append(col)
    })
    table.prepend(columns)
    table.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') ?? ''
      // Keep descriptive labels, images and local file links intact.
      if (!/^https?:\/\//i.test(href) || anchor.textContent?.trim() !== href) return
      try {
        anchor.textContent = `${new URL(href).hostname} ↗`
        anchor.setAttribute('title', href)
        anchor.setAttribute('aria-label', href)
      } catch { /* Keep malformed addresses as written. */ }
    })
    // Dense tables need a record layout in narrow panes: prose must not
    // determine the height of every unrelated field in the same record.
    const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')]
    const hasLongCells = rows.some(row => [...row.cells].some(cell => (cell.textContent?.length ?? 0) > 160))
    const simpleGrid = headers.length > 0 && rows.every(row => row.cells.length === headers.length
      && [...row.cells].every(cell => cell.colSpan === 1 && cell.rowSpan === 1))
    if (simpleGrid && (headers.length >= 7 || (headers.length >= 4 && hasLongCells))) {
      table.classList.add('md-record-table')
      rows.forEach(row => [...row.cells].forEach((cell, column) => {
        const label = document.createElement('span')
        label.className = 'md-field-label'
        label.textContent = headers[column].textContent?.trim() || `列 ${column + 1}`
        label.setAttribute('aria-hidden', 'true')
        const value = document.createElement('div')
        value.className = 'md-field-value'
        if ((cell.textContent?.length ?? 0) > 90 || cell.querySelectorAll('br').length >= 3) cell.classList.add('md-field-wide')
        value.append(...cell.childNodes)
        cell.append(label, value)
      }))
    }
    const wrapper = document.createElement('section')
    wrapper.className = 'md-file-table'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'md-table-expand'
    button.textContent = '展开表格'
    button.setAttribute('aria-label', `展开表格 ${index + 1}`)
    const scroll = document.createElement('div')
    scroll.className = 'md-table-scroll'
    table.replaceWith(wrapper)
    scroll.append(table)
    wrapper.append(button, scroll)
  })
  return template.innerHTML
})

const filteredTable = computed(() => {
  const template = document.createElement('template')
  template.innerHTML = expandedTable.value
  const needle = query.value.trim().toLocaleLowerCase()
  let count = 0
  template.content.querySelectorAll('tbody tr').forEach((row) => {
    const text = [row.textContent, ...[...row.querySelectorAll('a')].map(a => a.getAttribute('href'))].join(' ').toLocaleLowerCase()
    if (needle && !text.includes(needle)) row.remove()
    else count++
  })
  return { html: template.innerHTML, count }
})

async function handleClick(event: MouseEvent) {
  copyMenu.value = null
  const target = event.target instanceof Element ? event.target : null
  const button = target?.closest<HTMLButtonElement>('.md-table-expand')
  if (button) {
    const table = button.parentElement?.querySelector('table')?.cloneNode(true) as HTMLTableElement | undefined
    table?.querySelectorAll('.md-field-label').forEach(label => label.remove())
    expandedTable.value = table?.outerHTML ?? ''
    query.value = ''
    opener = button
    dialog.value?.showModal()
    await nextTick()
    updateStickyColumn()
    searchInput.value?.focus()
    return
  }
  emit('navigate', event)
}

function close() {
  dialog.value?.close()
}

function onClose() {
  copyMenu.value = null
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  opener = null
}

function showCopyMenu(event: MouseEvent) {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor) return
  event.preventDefault()
  copyStatus.value = ''
  copyMenu.value = { href: anchor.getAttribute('href') ?? '', x: Math.max(0, Math.min(event.clientX, window.innerWidth - 180)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 44)) }
}

async function copyLink() {
  if (!copyMenu.value) return
  try {
    await navigator.clipboard.writeText(copyMenu.value.href)
    copyStatus.value = '已复制链接'
  } catch {
    copyStatus.value = '复制失败，请重试'
  }
}

watch(() => props.html, () => { close(); copyMenu.value = null })
watch(filteredTable, async () => { await nextTick(); updateStickyColumn() })
</script>

<template>
  <div class="markdown-preview markdown-body md-file-preview" @click="handleClick" @contextmenu="showCopyMenu" v-html="content" />
  <Teleport to="body">
    <dialog ref="dialog" class="md-table-dialog" aria-label="表格阅读" @close="onClose" @click="copyMenu = null" @contextmenu="showCopyMenu">
      <div class="md-table-toolbar">
        <input ref="searchInput" v-model="query" type="search" placeholder="搜索表格内容或链接" aria-label="搜索表格内容或链接">
        <span aria-live="polite">{{ filteredTable.count }} 条</span>
        <button type="button" @click="close">关闭</button>
      </div>
      <div ref="reader" class="markdown-body md-table-reader" @click="handleClick" v-html="filteredTable.html" />
      <p v-if="filteredTable.count === 0" class="md-table-empty">没有匹配的记录</p>
      <div v-if="copyMenu" class="md-link-menu" :style="{ left: `${copyMenu.x}px`, top: `${copyMenu.y}px` }" @click.stop>
        <button type="button" @click="copyLink">{{ copyStatus || '复制链接地址' }}</button>
      </div>
    </dialog>
    <div v-if="copyMenu && !dialog?.open" class="md-link-dismiss" @click="copyMenu = null" @contextmenu.prevent="copyMenu = null" @keydown.esc="copyMenu = null">
      <div class="md-link-menu" :style="{ left: `${copyMenu.x}px`, top: `${copyMenu.y}px` }" @click.stop>
        <button type="button" autofocus @click="copyLink">{{ copyStatus || '复制链接地址' }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style>
.md-file-preview { min-width: 0; overflow-wrap: anywhere; container-type: inline-size; container-name: markdown-file; }
.md-file-table { margin-bottom: 1em; }
.md-table-expand { display: block; position: sticky; top: 0; z-index: 5; margin: 0 0 5px auto; }
.md-field-label { display: none; }
.md-field-value { min-width: 0; }
@container markdown-file (max-width: 1100px) {
  .md-file-preview .md-record-table { display: block; border: 0; }
  .md-file-preview .md-record-table > colgroup { display: none; }
  .md-file-preview .md-record-table > thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .md-file-preview .md-record-table > tbody { display: block; }
  .md-file-preview .md-record-table > tbody > tr { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 8px 16px; padding: 10px 0; border-bottom: 1px solid var(--color-border); }
  .markdown-body.md-file-preview .md-record-table > tbody > tr > td { display: block; min-width: 0; max-width: none; padding: 0; border: 0; background: transparent; }
  .md-file-preview .md-record-table .md-field-label { display: block; margin-bottom: 2px; font-size: 11px; color: var(--color-text-muted); }
  .md-file-preview .md-record-table .md-field-wide { grid-column: 1 / -1; order: 1; }
  .md-file-preview .md-record-table .md-field-value { line-height: 1.6; }
}
.md-table-scroll { overflow-x: auto; }
.markdown-body.md-file-preview table,
.markdown-body.md-table-reader table { table-layout: auto; overflow: visible; border-collapse: separate; border-spacing: 0; border-radius: 0; margin: 0; }
.md-file-preview th, .md-file-preview td,
.md-table-reader th, .md-table-reader td { overflow-wrap: anywhere; min-width: 5em; max-width: 32em; }
.md-file-preview .md-col-id, .md-table-reader .md-col-id { width: 4em; }
.md-file-preview .md-col-status, .md-table-reader .md-col-status { width: 7em; }
.md-file-preview :is(th, td):first-child, .md-table-reader :is(th, td):first-child { min-width: 3em; }
.md-table-dialog { width: calc(100vw - 48px); height: calc(100vh - 48px); max-width: none; max-height: none; padding: 12px; box-sizing: border-box; color: var(--color-text-primary); background: var(--color-bg-primary); border: 1px solid var(--color-border); border-radius: 6px; box-shadow: none; }
.md-table-dialog[open] { display: flex; flex-direction: column; gap: 10px; }
.md-table-dialog::backdrop { background: var(--surface-overlay, rgba(0, 0, 0, .55)); }
.md-table-toolbar { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.md-table-toolbar input { flex: 1; min-width: 0; padding: 6px 8px; color: var(--color-text-primary); background: var(--surface-panel-strong); border: 1px solid var(--color-border); border-radius: 3px; }
.md-table-toolbar span { white-space: nowrap; font-size: 12px; color: var(--color-text-secondary); }
.md-table-expand, .md-table-toolbar button, .md-link-menu button { padding: 4px 9px; color: var(--color-text-primary); background: var(--surface-panel-strong); border: 1px solid var(--color-border); border-radius: 3px; cursor: pointer; font: inherit; font-size: 12px; }
.md-table-expand:hover, .md-table-toolbar button:hover, .md-link-menu button:hover { background: var(--color-bg-hover); }
.md-table-reader { min-height: 0; flex: 1; overflow: auto; }
.md-table-reader table { min-width: 100%; }
.md-table-reader th, .md-table-reader td { min-width: 9em; background: var(--color-bg-primary); }
.md-table-reader th { position: sticky; top: 0; z-index: 2; background: var(--surface-panel-strong); }
.md-table-reader :is(th, td):first-child { position: sticky; left: 0; z-index: 1; }
.md-table-reader :is(th, td):nth-child(2) { position: sticky; left: var(--md-first-column-width, 0px); z-index: 1; }
.markdown-body.md-table-reader tr:nth-child(even) td { background: var(--surface-panel-strong); }
.md-table-reader th:first-child, .md-table-reader th:nth-child(2) { z-index: 3; }
.md-table-empty { margin: 0; color: var(--color-text-secondary); }
.md-link-dismiss { position: fixed; inset: 0; z-index: 10000; }
.md-link-menu { position: fixed; z-index: 10001; }
</style>
