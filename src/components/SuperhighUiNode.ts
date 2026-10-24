import { computed, defineComponent, Fragment, h, inject, onBeforeUnmount, onMounted, ref, watch, type InjectionKey, type PropType, type Ref, type VNode } from 'vue'
import { Check, ChevronRight, Copy, GripVertical } from 'lucide-vue-next'
import { renderMarkdown } from '@/lib/markdown'
import { isUiNode, type UiArrayInfo, type UiChild, type UiChildList, type UiNode } from '@/lib/superhighUi'
import { SUPERHIGH_UI_FIELD_COMPONENTS } from '@/lib/superhighUiComponents'
import {
  distinctColumnValues,
  filterTableRows,
  normalizeTableRows,
  resolveUiNodeProps,
  resolveUiValue,
  uiCellText,
  type SuperhighUiScope,
} from '@/lib/superhighUiData'

export interface SuperhighUiActionInput {
  type: 'click' | 'submit'
  action: string
  label?: string
  component?: string
  form?: string
  values?: Record<string, unknown>
}

export interface SuperhighUiDragSource {
  array: UiArrayInfo | null
  index: number
  child: UiChild
  element: HTMLElement
}

export interface SuperhighUiContext {
  values: Record<string, unknown>
  setValue(name: string, value: unknown): void
  emitAction(action: SuperhighUiActionInput): void
  beginDrag(event: PointerEvent, source: SuperhighUiDragSource): void
  resolveImage(src: string): Promise<string>
  dragEnabled: Ref<boolean>
  /** Bind 读取字段当前值（含默认值），Data 读取已加载的数据文件 */
  scope: SuperhighUiScope
}

export const SUPERHIGH_UI_CONTEXT: InjectionKey<SuperhighUiContext> = Symbol('superhigh-ui')

const TONES = new Set(['neutral', 'info', 'ok', 'warn', 'error'])
const tone = (value: unknown, fallback = 'neutral') => (typeof value === 'string' && TONES.has(value) ? value : fallback)
const text = (value: unknown) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])

interface UiOption {
  label: string
  value: unknown
}

function options(value: unknown): UiOption[] {
  return list(value).map((item) => {
    if (item && typeof item === 'object' && !isUiNode(item)) {
      const record = item as Record<string, unknown>
      // 显式 value: null 表示“全部/不选”，不能回退成 label
      const optionValue = 'value' in record ? record.value : record.label
      return { label: text(record.label ?? optionValue), value: optionValue }
    }
    return { label: text(item), value: item }
  })
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

function useUi() {
  const context = inject(SUPERHIGH_UI_CONTEXT)
  if (!context) throw new Error('SuperhighUiNode 需要在 SuperhighUiPreview 内渲染')
  return context
}

function renderValue(value: unknown): VNode | string {
  if (isUiNode(value)) return h(SuperhighUiNode, { node: value })
  if (Array.isArray(value)) return value.map(text).join(', ')
  return text(value)
}

function fieldValue(ui: SuperhighUiContext, node: UiNode) {
  const name = text(node.props.name)
  return name in ui.values ? ui.values[name] : node.props.value
}

function renderChild(child: UiChild) {
  if (child.kind === 'node') return h(SuperhighUiNode, { node: child.node })
  if (child.kind === 'text') return h('div', { class: 'shui-text shui-text-body' }, child.text)
  return h('div', { class: 'shui-pending', title: `等待定义 ${child.ref}` }, h('span', child.ref))
}

function renderChildList(ui: SuperhighUiContext, childList: UiChildList | undefined, className: string, sortable: boolean, attrs: Record<string, unknown> = {}) {
  const items = childList?.items ?? []
  const array = sortable ? childList?.array ?? null : null
  const seen = new Map<string, number>()
  return h('div', {
    ...attrs,
    class: ['shui-list', className, attrs.class],
    'data-shui-array': array ? String(array.span.start) : undefined,
  }, items.map((child, index) => {
    const base = child.kind === 'node' ? child.node.key : child.key
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return h('div', { key: count ? `${base}#${count}` : base, class: 'shui-item', 'data-shui-index': index }, [
      sortable
        ? h('button', {
            class: 'shui-grip',
            type: 'button',
            tabindex: -1,
            title: array && ui.dragEnabled.value ? '拖动重排，拖到 CLI 插入引用' : '拖到 CLI 插入引用',
            onPointerdown: (event: PointerEvent) => {
              const element = (event.currentTarget as HTMLElement).parentElement
              if (element) ui.beginDrag(event, { array, index, child, element })
            },
          }, h(GripVertical, { size: 12 }))
        : null,
      renderChild(child),
    ])
  }))
}

function collectFields(node: UiNode, fields: UiNode[] = []) {
  if (SUPERHIGH_UI_FIELD_COMPONENTS.has(node.type) && node.props.name !== undefined) fields.push(node)
  for (const childList of Object.values(node.children)) {
    for (const child of childList.items) if (child.kind === 'node') collectFields(child.node, fields)
  }
  return fields
}

// 提交时未改动的字段按界面显示的默认值回传；Bind 读取未改动的字段时也用它
export function defaultFieldValue(node: UiNode) {
  switch (node.type) {
    case 'SortList':
      return options(node.props.items).map((option) => option.value)
    case 'Slider':
      return node.props.value === undefined ? Number(node.props.min) || 0 : Number(node.props.value)
    case 'Checkbox':
      return node.props.value === true
    case 'Choice':
      return node.props.multiple === true ? list(node.props.value) : node.props.value ?? null
    default:
      return node.props.value ?? null
  }
}

function submittedValue(ui: SuperhighUiContext, node: UiNode) {
  const name = text(node.props.name)
  return name in ui.values ? ui.values[name] : defaultFieldValue(node)
}

// 按钮组不能包在 <label> 里，否则点击标签文字会触发第一个按钮
function fieldLabel(node: UiNode, control: VNode, inline = false, tag: 'label' | 'div' = 'label') {
  const label = node.props.label === undefined ? '' : text(node.props.label)
  return h(tag, { class: ['shui-field', inline && 'shui-field-inline'] }, inline
    ? [control, label ? h('span', label) : null]
    : [label ? h('span', { class: 'shui-field-label' }, label) : null, control])
}

// ---- 有内部状态的组件 ----

const SectionView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const ui = useUi()
    const open = ref(props.node.props.collapsed !== true)
    return () => h('section', { class: ['shui-section', open.value && 'is-open'] }, [
      h('button', { class: 'shui-section-head', type: 'button', 'aria-expanded': open.value, onClick: () => { open.value = !open.value } }, [
        h(ChevronRight, { size: 13, class: 'shui-section-chevron' }),
        h('span', text(props.node.props.title)),
      ]),
      open.value ? renderChildList(ui, props.node.children.children, 'shui-stack', true) : null,
    ])
  },
})

const TabsView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const active = ref(0)
    return () => {
      const labels = list(props.node.props.labels).map(text)
      const panels = props.node.children.panels?.items ?? []
      const index = Math.min(active.value, Math.max(0, labels.length - 1))
      const panel = panels[index]
      return h('div', { class: 'shui-tabs' }, [
        h('div', { class: 'shui-tabs-bar', role: 'tablist' }, labels.map((label, labelIndex) => h('button', {
          type: 'button',
          role: 'tab',
          class: ['shui-tab', labelIndex === index && 'active'],
          'aria-selected': labelIndex === index,
          onClick: () => { active.value = labelIndex },
        }, label))),
        panel ? h('div', { class: 'shui-tabs-panel', role: 'tabpanel' }, renderChild(panel)) : null,
      ])
    }
  },
})

const TableView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const sort = ref<{ column: number; descending: boolean } | null>(null)
    const query = ref('')
    const picks = ref<Record<string, string>>({})
    const page = ref(0)
    const columns = computed(() => list(props.node.props.columns).map(text))
    const source = computed(() => normalizeTableRows(props.node.props.rows, columns.value))
    const filterColumns = computed(() => list(props.node.props.filters).map(text))
    // where 常由 Bind 生成，每次渲染都是新对象，按内容判断是否变化
    const whereKey = computed(() => JSON.stringify(props.node.props.where ?? null))
    const scoped = computed(() => filterTableRows(source.value, { columns: columns.value, where: props.node.props.where }))
    const filtered = computed(() => filterTableRows(scoped.value.rows, { columns: columns.value, filters: picks.value, query: query.value }).rows)
    const rows = computed(() => {
      const current = sort.value
      if (!current) return filtered.value
      const key = (row: unknown[]) => {
        const cell = row[current.column]
        return isUiNode(cell) ? uiCellText(cell) : cell
      }
      return [...filtered.value].sort((left, right) => {
        const a = key(left)
        const b = key(right)
        const result = typeof a === 'number' && typeof b === 'number' ? a - b : text(a).localeCompare(text(b), 'zh-CN', { numeric: true })
        return current.descending ? -result : result
      })
    })
    const pageSize = computed(() => (props.node.props.pageSize === undefined ? 50 : Math.max(0, Math.floor(Number(props.node.props.pageSize) || 0))))
    const pageCount = computed(() => (pageSize.value ? Math.max(1, Math.ceil(rows.value.length / pageSize.value)) : 1))
    watch([query, picks, whereKey], () => { page.value = 0 })
    const toggle = (column: number) => {
      const current = sort.value
      sort.value = current?.column !== column ? { column, descending: false } : current.descending ? null : { column, descending: true }
    }
    return () => {
      const names = columns.value
      const searchable = props.node.props.search === undefined ? source.value.length > 20 : props.node.props.search === true
      const filterable = filterColumns.value.filter((column) => names.includes(column))
      const unknown = [...new Set([...scoped.value.unknownColumns, ...filterColumns.value.filter((column) => !names.includes(column))])]
      const current = Math.min(page.value, pageCount.value - 1)
      const visible = pageSize.value ? rows.value.slice(current * pageSize.value, (current + 1) * pageSize.value) : rows.value
      const narrowed = rows.value.length !== scoped.value.rows.length
      return h('div', { class: 'shui-table-view' }, [
        searchable || filterable.length
          ? h('div', { class: 'shui-table-tools' }, [
              searchable
                ? h('input', {
                    class: 'shui-input shui-table-search',
                    type: 'search',
                    value: query.value,
                    placeholder: '搜索',
                    onInput: (event: Event) => { query.value = (event.target as HTMLInputElement).value },
                  })
                : null,
              ...filterable.map((column) => h('select', {
                class: 'shui-input shui-table-filter',
                value: picks.value[column] ?? '',
                title: column,
                onChange: (event: Event) => { picks.value = { ...picks.value, [column]: (event.target as HTMLSelectElement).value } },
              }, [
                h('option', { value: '' }, `${column}：全部`),
                ...distinctColumnValues(scoped.value.rows, names.indexOf(column)).map((value) => h('option', { value }, value)),
              ])),
              h('span', { class: 'shui-table-count' }, narrowed ? `${rows.value.length} / ${scoped.value.rows.length} 行` : `${rows.value.length} 行`),
            ])
          : null,
        h('div', { class: 'shui-table-wrap' }, h('table', { class: 'shui-table' }, [
          h('thead', h('tr', names.map((column, index) => h('th', {
            'aria-sort': sort.value?.column === index ? (sort.value.descending ? 'descending' : 'ascending') : undefined,
          }, h('button', { type: 'button', onClick: () => toggle(index) }, [
            column,
            sort.value?.column === index ? h('span', { class: 'shui-sort-mark' }, sort.value.descending ? '↓' : '↑') : null,
          ]))))),
          h('tbody', visible.length
            ? visible.map((row, rowIndex) => h('tr', { key: rowIndex }, names.map((_, index) => {
                const cell = row[index]
                return h('td', { class: typeof cell === 'number' && 'is-number' }, renderValue(cell))
              })))
            : h('tr', h('td', { class: 'shui-table-empty', colspan: Math.max(1, names.length) }, source.value.length ? '没有匹配的行' : '暂无数据'))),
        ])),
        pageCount.value > 1
          ? h('div', { class: 'shui-table-pager' }, [
              h('button', { type: 'button', class: 'shui-button', disabled: current === 0, onClick: () => { page.value = current - 1 } }, '上一页'),
              h('span', `${current + 1} / ${pageCount.value}`),
              h('button', { type: 'button', class: 'shui-button', disabled: current >= pageCount.value - 1, onClick: () => { page.value = current + 1 } }, '下一页'),
            ])
          : null,
        unknown.length ? h('div', { class: 'shui-issue' }, `Table：未知列 ${unknown.join('、')}`) : null,
      ])
    }
  },
})

const CodeView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const copied = ref(false)
    let timer = 0
    const copy = async () => {
      await navigator.clipboard?.writeText(text(props.node.props.content)).catch(() => undefined)
      copied.value = true
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { copied.value = false }, 1200)
    }
    onBeforeUnmount(() => window.clearTimeout(timer))
    return () => h('div', { class: 'shui-code' }, [
      h('div', { class: 'shui-code-head' }, [
        h('span', text(props.node.props.language)),
        h('button', { type: 'button', class: 'shui-icon-button', title: copied.value ? '已复制' : '复制', onClick: copy }, h(copied.value ? Check : Copy, { size: 12 })),
      ]),
      h('pre', h('code', text(props.node.props.content))),
    ])
  },
})

const ImageView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const ui = useUi()
    const url = ref('')
    const failed = ref(false)
    watch(() => text(props.node.props.src), async (src) => {
      url.value = ''
      failed.value = false
      if (!src) return
      try {
        url.value = await ui.resolveImage(src)
      } catch {
        failed.value = true
      }
    }, { immediate: true })
    return () => failed.value
      ? h('div', { class: 'shui-issue' }, `图片无法读取：${text(props.node.props.src)}`)
      : url.value
        ? h('img', { class: 'shui-image', src: url.value, alt: text(props.node.props.alt) })
        : h('div', { class: 'shui-pending shui-image-pending' })
  },
})

const SortListView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const ui = useUi()
    const listEl = ref<HTMLElement | null>(null)
    const dragging = ref<number | null>(null)
    const draft = ref<UiOption[] | null>(null)
    const ordered = computed(() => {
      const items = options(props.node.props.items)
      const saved = ui.values[text(props.node.props.name)]
      if (!Array.isArray(saved)) return items
      const rank = (option: UiOption) => {
        const index = saved.findIndex((value) => sameValue(value, option.value))
        return index < 0 ? Number.MAX_SAFE_INTEGER : index
      }
      return [...items].sort((a, b) => rank(a) - rank(b))
    })
    const start = (event: PointerEvent, index: number) => {
      if (event.button !== 0) return
      event.preventDefault()
      draft.value = [...ordered.value]
      dragging.value = index
      const move = (moveEvent: PointerEvent) => {
        const rows = [...(listEl.value?.children ?? [])] as HTMLElement[]
        const target = rows.findIndex((row) => moveEvent.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2)
        const next = target < 0 ? rows.length - 1 : target
        if (draft.value && dragging.value !== null && next !== dragging.value) {
          const items = [...draft.value]
          const [item] = items.splice(dragging.value, 1)
          items.splice(next, 0, item)
          draft.value = items
          dragging.value = next
        }
      }
      const end = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        if (draft.value) ui.setValue(text(props.node.props.name), draft.value.map((item) => item.value))
        draft.value = null
        dragging.value = null
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    }
    return () => fieldLabel(props.node, h('ol', { ref: listEl, class: 'shui-sortlist' }, (draft.value ?? ordered.value).map((option, index) => h('li', {
      key: text(option.value),
      class: dragging.value === index && 'is-dragging',
    }, [
      h('span', { class: 'shui-sortlist-handle', onPointerdown: (event: PointerEvent) => start(event, index) }, h(GripVertical, { size: 12 })),
      h('span', { class: 'shui-sortlist-index' }, String(index + 1)),
      h('span', option.label),
    ]))), false, 'div')
  },
})

const SERIES_COLORS = ['var(--color-accent-blue)', 'var(--color-accent-purple)', 'var(--color-accent-green)', 'var(--color-accent-yellow)']
const OTHER_COLOR = 'var(--color-text-muted)'

function niceMax(value: number) {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const scaled = value / power
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power
}

// 柱子必须从 0 起；折线只看变化，纵轴按数据范围取整，避免趋势被压平
function chartRange(kind: 'bar' | 'line', values: number[]) {
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (kind === 'line' && values.length) {
    const low = Math.min(...values)
    const high = Math.max(...values)
    const span = high - low || Math.abs(high) || 1
    const step = niceMax(span * 1.4 / 4)
    const bottom = low >= 0 ? Math.max(0, Math.floor((low - span * 0.2) / step) * step) : Math.floor((low - span * 0.2) / step) * step
    return { bottom, top: Math.max(bottom + step * 4, Math.ceil((high + span * 0.2) / step) * step) }
  }
  return { bottom: min < 0 ? -niceMax(-min) : 0, top: niceMax(max) }
}

const formatNumber = (value: number) => (Math.abs(value) >= 1000 ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : String(Math.round(value * 100) / 100))

type StackMode = 'stack' | 'percent' | null

interface ChartSeries {
  name: string
  color: string
  /** 绘制用的值，percent 模式下为占比 */
  values: number[]
  raw: number[]
}

// 只有远离 0 的一端带圆角；tip 在 base 上方时向上画
function barPath(x: number, width: number, base: number, tip: number, rounded: boolean) {
  const radius = rounded ? Math.min(4, width / 2, Math.abs(base - tip)) : 0
  const toward = tip < base ? radius : -radius
  return `M${x},${base}V${tip + toward}Q${x},${tip} ${x + radius},${tip}H${x + width - radius}Q${x + width},${tip} ${x + width},${tip + toward}V${base}Z`
}

function lastIndexWhere<T>(items: T[], test: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index])) return index
  return -1
}

const ChartView = defineComponent({
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const host = ref<HTMLElement | null>(null)
    const width = ref(320)
    const hover = ref<number | null>(null)
    let observer: ResizeObserver | null = null
    onMounted(() => {
      if (!host.value) return
      width.value = host.value.clientWidth || 320
      observer = new ResizeObserver(([entry]) => { width.value = Math.max(160, Math.floor(entry.contentRect.width)) })
      observer.observe(host.value)
    })
    onBeforeUnmount(() => observer?.disconnect())

    const stackMode = computed<StackMode>(() => {
      if (props.node.props.kind === 'line') return null
      const stacked = props.node.props.stacked
      return stacked === 'percent' ? 'percent' : stacked === true ? 'stack' : null
    })

    const series = computed<ChartSeries[]>(() => {
      const raw = list(props.node.props.series)
      const normalized = (raw.length && raw.every((item) => typeof item === 'number')
        ? [{ name: '', values: raw as number[] }]
        : raw.map((item, index) => {
            const record = (item ?? {}) as Record<string, unknown>
            return { name: text(record.name ?? `系列 ${index + 1}`), values: list(record.values).map((value) => Number(value) || 0) }
          })).map((item, index) => ({ ...item, color: SERIES_COLORS[index % SERIES_COLORS.length] }))
      let picked = normalized.slice(0, SERIES_COLORS.length)
      // 堆叠看构成，超出的系列合并为“其他”而不是丢掉
      if (stackMode.value && normalized.length > SERIES_COLORS.length) {
        const rest = normalized.slice(SERIES_COLORS.length)
        const length = Math.max(...rest.map((item) => item.values.length))
        picked = [...picked, {
          name: '其他',
          color: OTHER_COLOR,
          values: Array.from({ length }, (_, index) => rest.reduce((sum, item) => sum + (item.values[index] ?? 0), 0)),
        }]
      }
      if (stackMode.value !== 'percent') return picked.map((item) => ({ ...item, raw: item.values }))
      const count = Math.max(0, ...picked.map((item) => item.values.length))
      const totals = Array.from({ length: count }, (_, index) => picked.reduce((sum, item) => sum + Math.max(0, item.values[index] ?? 0), 0))
      return picked.map((item) => ({
        ...item,
        raw: item.values,
        values: item.values.map((value, index) => (totals[index] ? (Math.max(0, value) / totals[index]) * 100 : 0)),
      }))
    })

    return () => {
      const labels = list(props.node.props.labels).map(text)
      const unit = text(props.node.props.unit)
      const kind = props.node.props.kind === 'line' ? 'line' : 'bar'
      const mode = stackMode.value
      const height = 168
      const pad = { left: 40, right: 8, top: 8, bottom: 22 }
      const plotWidth = Math.max(40, width.value - pad.left - pad.right)
      const plotHeight = height - pad.top - pad.bottom
      const count = Math.max(1, labels.length, ...series.value.map((item) => item.values.length))
      const stackTotals = mode
        ? Array.from({ length: count }, (_, index) => series.value.reduce((sums, item) => {
            const value = item.values[index] ?? 0
            return value > 0 ? [sums[0] + value, sums[1]] : [sums[0], sums[1] + value]
          }, [0, 0]))
        : []
      const { bottom, top } = mode === 'percent'
        ? { bottom: 0, top: 100 }
        : chartRange(kind, mode ? stackTotals.flat() : series.value.flatMap((item) => item.values))
      const band = plotWidth / count
      const y = (value: number) => pad.top + plotHeight * (1 - (value - bottom) / (top - bottom || 1))
      const ticks = [0, 1, 2, 3, 4].map((step) => bottom + ((top - bottom) * step) / 4)
      const labelEvery = Math.max(1, Math.ceil((count * 44) / plotWidth))
      const marks: VNode[] = []
      const dim = (index: number) => (hover.value === null || hover.value === index ? 1 : 0.45)

      if (kind === 'bar' && mode) {
        const barWidth = Math.max(2, Math.min(36, band * 0.6))
        for (let index = 0; index < count; index += 1) {
          const x = pad.left + band * index + (band - barWidth) / 2
          const lastUp = lastIndexWhere(series.value, (item) => (item.values[index] ?? 0) > 0)
          const lastDown = lastIndexWhere(series.value, (item) => (item.values[index] ?? 0) < 0)
          let up = 0
          let down = 0
          series.value.forEach((item, seriesIndex) => {
            const value = item.values[index] ?? 0
            if (!value) return
            const start = value > 0 ? up : down
            const end = start + value
            if (value > 0) up = end
            else down = end
            // 相邻段之间留 1px 缝，层次更清楚
            const base = y(start) + (start === 0 ? 0 : value > 0 ? -1 : 1)
            marks.push(h('path', { d: barPath(x, barWidth, base, y(end), seriesIndex === (value > 0 ? lastUp : lastDown)), fill: item.color, opacity: dim(index) }))
          })
        }
      } else if (kind === 'bar') {
        const groups = series.value.length
        const barWidth = Math.max(2, Math.min(28, (band * 0.72 - (groups - 1) * 2) / groups))
        series.value.forEach((item, seriesIndex) => {
          item.values.forEach((value, index) => {
            const x = pad.left + band * index + (band - (barWidth * groups + (groups - 1) * 2)) / 2 + seriesIndex * (barWidth + 2)
            marks.push(h('path', { d: barPath(x, barWidth, y(0), y(value), true), fill: item.color, opacity: dim(index) }))
          })
        })
      } else {
        if (hover.value !== null) {
          const x = pad.left + band * hover.value + band / 2
          marks.push(h('line', { x1: x, x2: x, y1: pad.top, y2: pad.top + plotHeight, class: 'shui-chart-crosshair' }))
        }
        series.value.forEach((item) => {
          const points = item.values.map((value, index) => `${pad.left + band * index + band / 2},${y(value)}`).join(' ')
          marks.push(h('polyline', { points, fill: 'none', stroke: item.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }))
          if (hover.value !== null && item.values[hover.value] !== undefined) {
            marks.push(h('circle', {
              cx: pad.left + band * hover.value + band / 2,
              cy: y(item.values[hover.value]),
              r: 4,
              fill: item.color,
              class: 'shui-chart-point',
            }))
          }
        })
      }

      const tooltipIndex = hover.value
      const tooltipLeft = tooltipIndex === null ? 0 : Math.min(width.value - 150, Math.max(0, pad.left + band * tooltipIndex + band / 2 - 70))
      // 堆叠时提示自上而下列出，与柱子层次一致
      const tooltipSeries = mode ? [...series.value].reverse() : series.value
      const tickText = (tick: number) => (mode === 'percent' ? `${formatNumber(tick)}%` : formatNumber(tick))
      const kindName = kind === 'line' ? '折线图' : mode ? '堆叠柱状图' : '柱状图'
      return h('div', { ref: host, class: 'shui-chart' }, [
        series.value.length > 1
          ? h('div', { class: 'shui-chart-legend' }, series.value.map((item) => h('span', [
              h('i', { style: { background: item.color } }),
              item.name,
            ])))
          : null,
        h('svg', { width: width.value, height, viewBox: `0 0 ${width.value} ${height}`, role: 'img', 'aria-label': `${kindName}：${labels.join('、')}` }, [
          ...ticks.map((tick) => h('g', { class: 'shui-chart-grid' }, [
            h('line', { x1: pad.left, x2: pad.left + plotWidth, y1: y(tick), y2: y(tick) }),
            h('text', { x: pad.left - 6, y: y(tick) + 3, 'text-anchor': 'end' }, tickText(tick)),
          ])),
          ...marks,
          ...labels.map((label, index) => index % labelEvery === 0
            ? h('text', { class: 'shui-chart-label', x: pad.left + band * index + band / 2, y: height - 6, 'text-anchor': 'middle' }, label.length > 8 ? `${label.slice(0, 7)}…` : label)
            : null),
          ...Array.from({ length: count }, (_, index) => h('rect', {
            x: pad.left + band * index,
            y: pad.top,
            width: band,
            height: plotHeight,
            fill: 'transparent',
            onPointerenter: () => { hover.value = index },
            onPointerleave: () => { if (hover.value === index) hover.value = null },
          })),
        ]),
        tooltipIndex !== null
          ? h('div', { class: 'shui-chart-tooltip', style: { left: `${tooltipLeft}px` } }, [
              h('strong', labels[tooltipIndex] ?? String(tooltipIndex + 1)),
              ...tooltipSeries.map((item) => h('div', [
                h('i', { style: { background: item.color } }),
                h('span', item.name || '数值'),
                h('b', mode === 'percent'
                  ? `${formatNumber(item.raw[tooltipIndex] ?? 0)}${unit} · ${formatNumber(item.values[tooltipIndex] ?? 0)}%`
                  : `${formatNumber(item.values[tooltipIndex] ?? 0)}${unit}`),
              ])),
              mode
                ? h('div', { class: 'shui-chart-total' }, [
                    h('span', '合计'),
                    h('b', `${formatNumber(series.value.reduce((sum, item) => sum + (item.raw[tooltipIndex] ?? 0), 0))}${unit}`),
                  ])
                : null,
            ])
          : null,
      ])
    }
  },
})

// ---- 节点分派 ----

// Bind/Data 写在子组件位置时，结果可能是组件、组件数组或文字；尚无值时不占位
function renderDynamic(value: unknown): VNode {
  if (isUiNode(value)) return h(SuperhighUiNode, { node: value })
  if (Array.isArray(value)) return h('div', { class: 'shui-list shui-stack gap-m' }, value.map((item) => renderDynamic(item)))
  if (value === undefined || value === null || value === '') return h(Fragment)
  return h('div', { class: 'shui-text shui-text-body' }, text(value))
}

function renderNode(ui: SuperhighUiContext, node: UiNode): VNode {
  const p = node.props
  switch (node.type) {
    case 'Stack':
      return renderChildList(ui, node.children.children, `shui-stack gap-${text(p.gap) || 'm'}`, true)
    case 'Row':
      return renderChildList(ui, node.children.children, `shui-row gap-${text(p.gap) || 'm'} align-${text(p.align) || 'start'}`, true)
    case 'Grid':
      return renderChildList(ui, node.children.children, 'shui-grid', true, {
        style: { '--shui-columns': String(Math.max(1, Math.min(6, Number(p.columns) || 3))) },
      })
    case 'Card':
      return h('section', { class: ['shui-card', `shui-tone-${tone(p.tone)}`] }, [
        p.title !== undefined || p.subtitle !== undefined
          ? h('header', { class: 'shui-card-head' }, [
              h('span', { class: 'shui-card-title' }, text(p.title)),
              p.subtitle !== undefined ? h('span', { class: 'shui-card-subtitle' }, text(p.subtitle)) : null,
            ])
          : null,
        node.children.children ? renderChildList(ui, node.children.children, 'shui-stack gap-s', true) : null,
      ])
    case 'Section':
      return h(SectionView, { node })
    case 'Tabs':
      return h(TabsView, { node })
    case 'Divider':
      return h('div', { class: ['shui-divider', p.label !== undefined && 'has-label'], role: 'separator' }, p.label !== undefined ? h('span', text(p.label)) : undefined)
    case 'Text':
      return h('div', { class: ['shui-text', `shui-text-${text(p.variant) || 'body'}`] }, text(p.content))
    case 'Markdown':
      return h('div', { class: 'markdown-body shui-markdown', innerHTML: renderMarkdown(text(p.content), { escapeRawHtml: true }) })
    case 'Badge':
      return h('span', { class: ['shui-badge', `shui-tone-${tone(p.tone)}`] }, text(p.label))
    case 'Callout':
      return h('div', { class: ['shui-callout', `shui-tone-${tone(p.tone, 'info')}`] }, [
        p.title !== undefined ? h('strong', text(p.title)) : null,
        h('div', text(p.content)),
      ])
    case 'Stat':
      return h('div', { class: 'shui-stat' }, [
        h('span', { class: 'shui-stat-label' }, text(p.label)),
        h('span', { class: 'shui-stat-value' }, renderValue(p.value)),
        p.delta !== undefined ? h('span', { class: ['shui-stat-delta', `shui-tone-${tone(p.tone)}`] }, text(p.delta)) : null,
      ])
    case 'KeyValue': {
      const entries = Array.isArray(p.items)
        ? p.items.map((item) => list(item))
        : p.items && typeof p.items === 'object' ? Object.entries(p.items as Record<string, unknown>) : []
      return h('dl', { class: 'shui-kv' }, entries.flatMap(([key, value]) => [h('dt', text(key)), h('dd', renderValue(value))]))
    }
    case 'Table':
      return h(TableView, { node })
    case 'List':
      return h(p.ordered === true ? 'ol' : 'ul', { class: 'shui-bullets' }, list(p.items).map((item) => h('li', renderValue(item))))
    case 'Steps':
      return h('ol', { class: 'shui-steps' }, list(p.items).map((item, index) => {
        const step = (item && typeof item === 'object' && !isUiNode(item) ? item : { title: item }) as Record<string, unknown>
        const status = ['done', 'active', 'pending', 'error'].includes(text(step.status)) ? text(step.status) : 'pending'
        return h('li', { class: `is-${status}` }, [
          h('span', { class: 'shui-step-mark' }, status === 'done' ? h(Check, { size: 11 }) : status === 'error' ? '!' : String(index + 1)),
          h('div', [h('div', { class: 'shui-step-title' }, text(step.title)), step.detail !== undefined ? h('div', { class: 'shui-step-detail' }, text(step.detail)) : null]),
        ])
      }))
    case 'Progress': {
      const max = Number(p.max) > 0 ? Number(p.max) : 100
      const ratio = Math.max(0, Math.min(1, (Number(p.value) || 0) / max))
      return h('div', { class: ['shui-progress', `shui-tone-${tone(p.tone, 'info')}`] }, [
        h('div', { class: 'shui-progress-head' }, [h('span', text(p.label)), h('span', `${Math.round(ratio * 100)}%`)]),
        h('div', { class: 'shui-progress-track', role: 'progressbar', 'aria-valuenow': Number(p.value) || 0, 'aria-valuemax': max }, h('div', { style: { width: `${ratio * 100}%` } })),
      ])
    }
    case 'Chart':
      return h(ChartView, { node })
    case 'Code':
      return h(CodeView, { node })
    case 'Image':
      return h(ImageView, { node })
    case 'Button': {
      const label = text(p.label)
      return h('button', {
        type: 'button',
        class: ['shui-button', `shui-variant-${text(p.variant) || 'default'}`],
        onClick: () => ui.emitAction({ type: 'click', action: text(p.action) || label, label, component: node.statementId }),
      }, label)
    }
    case 'Form': {
      const name = text(p.name)
      return h('form', {
        class: 'shui-form',
        onSubmit: (event: Event) => {
          event.preventDefault()
          const values = Object.fromEntries(collectFields(node).map((field) => [text(field.props.name), submittedValue(ui, field)]))
          ui.emitAction({ type: 'submit', action: name, form: name, values, component: node.statementId })
        },
      }, [
        renderChildList(ui, node.children.children, 'shui-stack gap-s', true),
        h('div', { class: 'shui-form-actions' }, h('button', { type: 'submit', class: 'shui-button shui-variant-primary' }, text(p.submit) || '提交')),
      ])
    }
    case 'Input': {
      const name = text(p.name)
      const value = text(fieldValue(ui, node))
      const onInput = (event: Event) => ui.setValue(name, (event.target as HTMLInputElement).value)
      return fieldLabel(node, p.multiline === true
        ? h('textarea', { class: 'shui-input', rows: 3, value, placeholder: text(p.placeholder), onInput })
        : h('input', { class: 'shui-input', type: 'text', value, placeholder: text(p.placeholder), onInput }))
    }
    case 'Select': {
      const choices = options(p.options)
      const current = fieldValue(ui, node)
      const selected = choices.findIndex((option) => sameValue(option.value, current))
      return fieldLabel(node, h('select', {
        class: 'shui-input',
        value: selected < 0 ? '' : String(selected),
        onChange: (event: Event) => ui.setValue(text(p.name), choices[Number((event.target as HTMLSelectElement).value)]?.value),
      }, [
        selected < 0 ? h('option', { value: '', disabled: true }, '请选择') : null,
        ...choices.map((option, index) => h('option', { value: String(index) }, option.label)),
      ]))
    }
    case 'Checkbox':
      return fieldLabel(node, h('input', {
        type: 'checkbox',
        class: 'shui-checkbox',
        checked: fieldValue(ui, node) === true,
        onChange: (event: Event) => ui.setValue(text(p.name), (event.target as HTMLInputElement).checked),
      }), true)
    case 'Slider': {
      const min = Number(p.min) || 0
      const max = Number(p.max) || 100
      const raw = fieldValue(ui, node)
      const value = raw === undefined ? min : Number(raw)
      return fieldLabel(node, h('div', { class: 'shui-slider' }, [
        h('input', {
          type: 'range',
          min,
          max,
          step: Number(p.step) || 1,
          value,
          onInput: (event: Event) => ui.setValue(text(p.name), Number((event.target as HTMLInputElement).value)),
        }),
        h('output', formatNumber(value)),
      ]))
    }
    case 'Choice': {
      const choices = options(p.options)
      const multiple = p.multiple === true
      const current = fieldValue(ui, node)
      const active = (value: unknown) => (multiple ? list(current).some((item) => sameValue(item, value)) : sameValue(current, value))
      return fieldLabel(node, h('div', { class: 'shui-choice', role: multiple ? 'group' : 'radiogroup' }, choices.map((option) => h('button', {
        type: 'button',
        class: active(option.value) && 'active',
        'aria-pressed': active(option.value),
        onClick: () => {
          if (!multiple) return ui.setValue(text(p.name), option.value)
          const values = list(current)
          ui.setValue(text(p.name), active(option.value) ? values.filter((item) => !sameValue(item, option.value)) : [...values, option.value])
        },
      }, option.label))), false, 'div')
    }
    case 'SortList':
      return h(SortListView, { node })
    case 'Bind':
    case 'Data':
      return renderDynamic(resolveUiValue(node, ui.scope))
    default:
      return h('div', { class: 'shui-unknown' }, [h('strong', node.type), h('span', '未知组件')])
  }
}

export const SuperhighUiNode = defineComponent({
  name: 'SuperhighUiNode',
  props: { node: { type: Object as PropType<UiNode>, required: true } },
  setup(props) {
    const ui = useUi()
    return () => {
      const node = resolveUiNodeProps(props.node, ui.scope)
      const issues = node.spec ? node.issues : []
      const rendered = renderNode(ui, node)
      if (!issues.length) return rendered
      return h('div', { class: 'shui-with-issues' }, [rendered, h('div', { class: 'shui-issue' }, `${node.type}：${issues.join('；')}`)])
    }
  },
})
