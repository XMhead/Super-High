import { describe, expect, it } from 'vitest'
import { compileSuperhighUi, isUiNode, type UiNode } from './superhighUi'
import {
  distinctColumnValues,
  filterTableRows,
  normalizeTableRows,
  parseDataFile,
  pickDataPath,
  resolveUiNodeProps,
  resolveUiValue,
  walkUiTree,
  type SuperhighUiScope,
} from './superhighUiData'

const scopeOf = (fields: Record<string, unknown>, data: Record<string, unknown> = {}): SuperhighUiScope => ({
  field: (name) => fields[name],
  data: (src) => data[src],
})

describe('dynamic values', () => {
  it('maps a field through cases, with fallback and multi-select', () => {
    const doc = compileSuperhighUi('root = Stat("总计", Bind("month", {"9月": 12, "10月": 30}, "—"))')
    const root = doc.root as UiNode
    expect(doc.diagnostics).toEqual([])
    expect(root.issues).toEqual([])
    expect(resolveUiNodeProps(root, scopeOf({ month: '10月' })).props.value).toBe(30)
    expect(resolveUiNodeProps(root, scopeOf({ month: '11月' })).props.value).toBe('—')
    const multi = compileSuperhighUi('root = Chart("bar", ["a"], Bind("pick", {x: {name: "X", values: [1]}, y: {name: "Y", values: [2]}}))').root as UiNode
    expect(resolveUiNodeProps(multi, scopeOf({ pick: ['y'] })).props.series).toEqual([{ name: 'Y', values: [2] }])
  })

  it('returns the raw field value without cases and keeps untouched props by reference', () => {
    const root = compileSuperhighUi('root = Table(["月份"], [["9月"]], where: {"月份": Bind("month")})').root as UiNode
    const resolved = resolveUiNodeProps(root, scopeOf({ month: '9月' }))
    expect(resolved.props.where).toEqual({ 月份: '9月' })
    expect(resolved.props.rows).toBe(root.props.rows)
    const plain = compileSuperhighUi('root = Text("x")').root as UiNode
    expect(resolveUiNodeProps(plain, scopeOf({}))).toBe(plain)
  })

  it('reads Data by path and resolves components chosen by Bind', () => {
    const value = compileSuperhighUi('root = Data("usage.json", "months.1.total")').root as UiNode
    expect(resolveUiValue(value, scopeOf({}, { 'usage.json': { months: [{ total: 1 }, { total: 7 }] } }))).toBe(7)
    expect(resolveUiValue(value, scopeOf({}))).toBeUndefined()
    const chosen = resolveUiValue(compileSuperhighUi('root = Bind("tab", {a: Badge("A")})').root, scopeOf({ tab: 'a' }))
    expect(isUiNode(chosen) && chosen.type).toBe('Badge')
  })

  it('walks nodes inside children, props and case objects', () => {
    const doc = compileSuperhighUi('root = Stack([Select("month", ["9月"]), Bind("month", {"9月": Card("c", [Input("note")])})])')
    const types: string[] = []
    walkUiTree(doc.root, (node) => types.push(node.type))
    expect(types).toEqual(['Stack', 'Select', 'Bind', 'Card', 'Input'])
  })

  it('parses JSON and JSONL data files', () => {
    expect(parseDataFile('a.json', '﻿{"a": [1, 2]}')).toEqual({ a: [1, 2] })
    expect(parseDataFile('a.JSONL', '{"n": 1}\n\n{"n": 2}\n')).toEqual([{ n: 1 }, { n: 2 }])
    expect(pickDataPath({ a: { b: 3 } }, '')).toEqual({ a: { b: 3 } })
    expect(pickDataPath({ a: 1 }, 'a.b')).toBeUndefined()
  })
})

describe('table filtering', () => {
  const columns = ['任务', '月份', '状态']
  const doc = compileSuperhighUi('root = Table(["任务", "月份", "状态"], [["构建 A", "9月", Badge("失败", "error")], ["构建 B", "10月", Badge("通过", "ok")], ["测试 C", "10月", Badge("失败", "error")]])')
  const rows = normalizeTableRows((doc.root as UiNode).props.rows, columns)

  it('filters by where, dropdown picks and search tokens', () => {
    expect(filterTableRows(rows, { columns, where: { 月份: '10月' } }).rows).toHaveLength(2)
    expect(filterTableRows(rows, { columns, where: { 月份: ['9月', '10月'] }, filters: { 状态: '失败' } }).rows.map((row) => row[0])).toEqual(['构建 A', '测试 C'])
    expect(filterTableRows(rows, { columns, query: '构建 失败' }).rows.map((row) => row[0])).toEqual(['构建 A'])
    expect(filterTableRows(rows, { columns, where: { 月份: null }, filters: { 状态: '' } }).rows).toHaveLength(3)
  })

  it('reports unknown columns and lists distinct values', () => {
    expect(filterTableRows(rows, { columns, where: { 年份: '2026' } }).unknownColumns).toEqual(['年份'])
    expect(distinctColumnValues(rows, 2)).toEqual(['失败', '通过'])
  })

  it('accepts object rows keyed by column name', () => {
    expect(normalizeTableRows([{ 任务: 'x', 状态: 'ok' }, ['y', '9月']], columns)).toEqual([['x', undefined, 'ok'], ['y', '9月']])
  })
})
