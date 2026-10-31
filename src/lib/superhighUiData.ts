import { isUiNode, type UiNode } from './superhighUi'
import { SUPERHIGH_UI_VALUE_COMPONENTS } from './superhighUiComponents'

// .shui 的动态值（Bind/Data）在渲染时求值；表格的搜索、筛选与分页也在这里，便于脱离界面测试。

export interface SuperhighUiScope {
  field(name: string): unknown
  data(src: string): unknown
}

export const uiText = (value: unknown) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !isUiNode(value)

export function isDynamicUiNode(value: unknown): value is UiNode {
  return isUiNode(value) && SUPERHIGH_UI_VALUE_COMPONENTS.has(value.type)
}

/** 按 "a.b.0" 取 JSON 中的一项；路径为空时返回整体 */
export function pickDataPath(value: unknown, path: unknown) {
  const segments = uiText(path).split('.').filter(Boolean)
  let current = value
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)]
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[segment]
    else return undefined
  }
  return current
}

export function parseDataFile(path: string, content: string): unknown {
  if (path.toLowerCase().endsWith('.jsonl')) {
    return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
  }
  return JSON.parse(content.replace(/^﻿/, ''))
}

function evaluateDynamic(node: UiNode, scope: SuperhighUiScope): unknown {
  const props = node.props
  if (node.type === 'Data') return pickDataPath(scope.data(uiText(props.src)), props.path)
  const current = scope.field(uiText(props.field))
  if (!isPlainObject(props.cases)) return current === undefined ? props.fallback : current
  const cases = props.cases
  const lookup = (value: unknown) => {
    const key = uiText(value)
    return Object.prototype.hasOwnProperty.call(cases, key) ? cases[key] : undefined
  }
  if (Array.isArray(current)) return current.map(lookup).filter((item) => item !== undefined)
  const found = lookup(current)
  return found === undefined ? props.fallback : found
}

/** 深度替换值里的 Bind/Data；没有动态值的部分保持原引用 */
export function resolveUiValue(value: unknown, scope: SuperhighUiScope): unknown {
  if (isDynamicUiNode(value)) return resolveUiValue(evaluateDynamic(value, scope), scope)
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const resolved = resolveUiValue(item, scope)
      if (resolved !== item) changed = true
      return resolved
    })
    return changed ? next : value
  }
  if (isPlainObject(value)) {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveUiValue(item, scope)
      if (resolved !== item) changed = true
      next[key] = resolved
    }
    return changed ? next : value
  }
  return value
}

export function resolveUiNodeProps(node: UiNode, scope: SuperhighUiScope): UiNode {
  const props = resolveUiValue(node.props, scope) as Record<string, unknown>
  return props === node.props ? node : { ...node, props }
}

/** 遍历渲染树中的全部组件，包括写在参数值里的组件 */
export function walkUiTree(root: UiNode | null, visit: (node: UiNode) => void) {
  const seen = new Set<UiNode>()
  const visitValue = (value: unknown) => {
    if (isUiNode(value)) visitNode(value)
    else if (Array.isArray(value)) value.forEach(visitValue)
    else if (isPlainObject(value)) Object.values(value).forEach(visitValue)
  }
  const visitNode = (node: UiNode) => {
    if (seen.has(node)) return
    seen.add(node)
    visit(node)
    for (const childList of Object.values(node.children)) {
      for (const child of childList.items) if (child.kind === 'node') visitNode(child.node)
    }
    visitValue(node.props)
  }
  if (root) visitNode(root)
}

// ---- 表格 ----

export function uiCellText(cell: unknown): string {
  if (isUiNode(cell)) return uiText(cell.props.label ?? cell.props.content ?? cell.props.value)
  if (Array.isArray(cell)) return cell.map(uiCellText).join(', ')
  return uiText(cell)
}

export function normalizeTableRows(rows: unknown, columns: string[]): unknown[][] {
  const source = Array.isArray(rows) ? rows : rows === undefined || rows === null ? [] : [rows]
  return source.map((row) => {
    if (Array.isArray(row)) return row
    if (isPlainObject(row)) return columns.map((column) => row[column])
    return [row]
  })
}

const isEmptyFilter = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)

export interface TableFilterInput {
  columns: string[]
  where?: unknown
  filters?: Record<string, string>
  query?: string
}

export interface TableFilterResult {
  rows: unknown[][]
  unknownColumns: string[]
}

export function filterTableRows(rows: unknown[][], input: TableFilterInput): TableFilterResult {
  const unknownColumns: string[] = []
  const conditions: { index: number; accept: (text: string) => boolean }[] = []
  const addCondition = (column: string, value: unknown) => {
    if (isEmptyFilter(value)) return
    const index = input.columns.indexOf(column)
    if (index < 0) {
      unknownColumns.push(column)
      return
    }
    const accepted = new Set((Array.isArray(value) ? value : [value]).map(uiCellText))
    conditions.push({ index, accept: (text) => accepted.has(text) })
  }
  if (isPlainObject(input.where)) for (const [column, value] of Object.entries(input.where)) addCondition(column, value)
  for (const [column, value] of Object.entries(input.filters ?? {})) addCondition(column, value)
  const tokens = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = rows.filter((row) => {
    if (!conditions.every((condition) => condition.accept(uiCellText(row[condition.index])))) return false
    if (!tokens.length) return true
    const haystack = row.map(uiCellText).join('\n').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
  return { rows: filtered, unknownColumns }
}

/** 某列在当前行里出现过的值，用作下拉筛选选项 */
export function distinctColumnValues(rows: unknown[][], index: number) {
  const values = new Set<string>()
  for (const row of rows) {
    const text = uiCellText(row[index])
    if (text) values.add(text)
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}
