import { SUPERHIGH_UI_COMPONENT_MAP, type SuperhighUiComponentSpec } from './superhighUiComponents'

// SuperHigh UI（.shui）：每行一条 `名称 = 表达式`，引用可先用后定义。
// 文件可能正被 Agent 追加写入，解析必须容忍末尾半截语句，未闭合的括号按 EOF 自动闭合。

export const SUPERHIGH_UI_EXTENSION = '.shui'

export function isSuperhighUiPath(path: string) {
  return path.toLowerCase().endsWith(SUPERHIGH_UI_EXTENSION)
}

export function superhighUiStatePath(path: string) {
  return `${path}.state.json`
}

export interface Span {
  start: number
  end: number
}

export type UiExpr =
  | { kind: 'literal'; value: string | number | boolean | null; span: Span }
  | { kind: 'array'; items: UiExpr[]; span: Span; closed: boolean }
  | { kind: 'object'; entries: { key: string; value: UiExpr }[]; span: Span; closed: boolean }
  | { kind: 'call'; name: string; args: UiExpr[]; named: { key: string; value: UiExpr }[]; span: Span; closed: boolean }
  | { kind: 'ref'; name: string; span: Span }

export interface UiStatement {
  id: string
  expr: UiExpr
  span: Span
  line: number
}

export interface UiDiagnostic {
  line: number
  message: string
}

export interface UiProgram {
  statements: UiStatement[]
  errors: UiDiagnostic[]
  /** 末尾存在未闭合的字符串或括号 */
  incomplete: boolean
}

type TokenKind = 'ident' | 'string' | 'number' | 'punct' | 'newline' | 'eof'

interface Token {
  kind: TokenKind
  value: string
  start: number
  end: number
  /** 字符串没有闭合引号 */
  open?: boolean
}

const PUNCT = new Set(['(', ')', '[', ']', '{', '}', ',', ':', '='])
const IDENT_START = /[\p{L}_$]/u
const IDENT_PART = /[\p{L}\p{N}_$]/u
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' }

function tokenize(source: string, errors: { offset: number; message: string }[]) {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '\n') {
      tokens.push({ kind: 'newline', value: '\n', start: index, end: index + 1 })
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '﻿') {
      index += 1
      continue
    }
    if (char === '#' || (char === '/' && source[index + 1] === '/')) {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '"' || char === '\'') {
      const start = index
      let value = ''
      let closed = false
      index += 1
      while (index < source.length) {
        const current = source[index]
        if (current === char) {
          closed = true
          index += 1
          break
        }
        if (current === '\\' && index + 1 < source.length) {
          const next = source[index + 1]
          if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
            value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16))
            index += 6
            continue
          }
          value += ESCAPES[next] ?? next
          index += 2
          continue
        }
        value += current
        index += 1
      }
      tokens.push({ kind: 'string', value, start, end: index, open: !closed })
      continue
    }
    const numberMatch = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index, index + 64))
    if (numberMatch && (char !== '-' || /[\d.]/.test(source[index + 1] ?? ''))) {
      tokens.push({ kind: 'number', value: numberMatch[0], start: index, end: index + numberMatch[0].length })
      index += numberMatch[0].length
      continue
    }
    if (IDENT_START.test(char)) {
      const start = index
      index += 1
      while (index < source.length && IDENT_PART.test(source[index])) index += 1
      tokens.push({ kind: 'ident', value: source.slice(start, index), start, end: index })
      continue
    }
    if (PUNCT.has(char)) {
      tokens.push({ kind: 'punct', value: char, start: index, end: index + 1 })
      index += 1
      continue
    }
    errors.push({ offset: index, message: `无法识别的字符 “${char}”` })
    index += 1
  }
  tokens.push({ kind: 'eof', value: '', start: source.length, end: source.length })
  return tokens
}

function lineStarts(source: string) {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function lineOf(starts: number[], offset: number) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

class ParseFailure extends Error {
  constructor(message: string, readonly offset: number) {
    super(message)
  }
}

export function parseSuperhighUi(source: string): UiProgram {
  const rawErrors: { offset: number; message: string }[] = []
  const tokens = tokenize(source, rawErrors)
  const starts = lineStarts(source)
  const statements: UiStatement[] = []
  let position = 0
  let depth = 0
  let incomplete = false

  const raw = () => tokens[position]
  const peek = () => {
    if (depth > 0) {
      while (tokens[position].kind === 'newline') position += 1
    }
    return tokens[position]
  }
  const take = () => {
    const token = peek()
    if (token.kind !== 'eof') position += 1
    return token
  }
  const isPunct = (token: Token, value: string) => token.kind === 'punct' && token.value === value
  const lastEnd = () => tokens[Math.max(0, position - 1)].end

  function parseList<T>(close: string, parseItem: () => T | null) {
    const items: T[] = []
    depth += 1
    let closed = false
    while (true) {
      const token = peek()
      if (token.kind === 'eof') {
        incomplete = true
        break
      }
      if (isPunct(token, close)) {
        take()
        closed = true
        break
      }
      if (isPunct(token, ',')) {
        take()
        continue
      }
      const item = parseItem()
      if (item === null) {
        incomplete = true
        break
      }
      items.push(item)
      const next = peek()
      if (isPunct(next, ',')) take()
      else if (!isPunct(next, close) && next.kind !== 'eof') {
        throw new ParseFailure(`缺少逗号或 “${close}”`, next.start)
      }
    }
    depth -= 1
    return { items, closed }
  }

  function parseExpr(): UiExpr | null {
    if (peek().kind === 'newline') throw new ParseFailure('“=” 后缺少表达式', peek().start)
    const token = take()
    if (token.kind === 'eof') return null
    if (token.kind === 'string') {
      if (token.open) incomplete = true
      return { kind: 'literal', value: token.value, span: { start: token.start, end: token.end } }
    }
    if (token.kind === 'number') {
      return { kind: 'literal', value: Number(token.value), span: { start: token.start, end: token.end } }
    }
    if (token.kind === 'ident') {
      if (token.value === 'true' || token.value === 'false') {
        return { kind: 'literal', value: token.value === 'true', span: { start: token.start, end: token.end } }
      }
      if (token.value === 'null') return { kind: 'literal', value: null, span: { start: token.start, end: token.end } }
      if (isPunct(peek(), '(')) {
        take()
        const args: UiExpr[] = []
        const named: { key: string; value: UiExpr }[] = []
        const { closed } = parseList(')', () => {
          const head = peek()
          const after = tokens[position + 1]
          if ((head.kind === 'ident' || head.kind === 'string') && after && isPunct(after, ':')) {
            take()
            take()
            const value = parseExpr()
            if (!value) return null
            named.push({ key: head.value, value })
            return true
          }
          const value = parseExpr()
          if (!value) return null
          args.push(value)
          return true
        })
        return { kind: 'call', name: token.value, args, named, closed, span: { start: token.start, end: lastEnd() } }
      }
      return { kind: 'ref', name: token.value, span: { start: token.start, end: token.end } }
    }
    if (isPunct(token, '[')) {
      const { items, closed } = parseList(']', parseExpr)
      return { kind: 'array', items, closed, span: { start: token.start, end: lastEnd() } }
    }
    if (isPunct(token, '{')) {
      const { items, closed } = parseList('}', () => {
        const key = take()
        if (key.kind === 'eof') return null
        if (key.kind !== 'ident' && key.kind !== 'string') throw new ParseFailure('对象键应为名称或字符串', key.start)
        const colon = take()
        if (colon.kind === 'eof') return null
        if (!isPunct(colon, ':')) throw new ParseFailure(`对象键 “${key.value}” 后缺少冒号`, colon.start)
        const value = parseExpr()
        if (!value) return null
        return { key: key.value, value }
      })
      return { kind: 'object', entries: items, closed, span: { start: token.start, end: lastEnd() } }
    }
    throw new ParseFailure(`意外的 “${token.value}”`, token.start)
  }

  function skipLine() {
    depth = 0
    while (raw().kind !== 'newline' && raw().kind !== 'eof') position += 1
  }

  while (true) {
    depth = 0
    while (raw().kind === 'newline') position += 1
    const head = raw()
    if (head.kind === 'eof') break
    const equals = tokens[position + 1]
    if (head.kind !== 'ident' || !equals || !isPunct(equals, '=')) {
      if (head.kind === 'ident' && equals?.kind === 'eof') {
        incomplete = true
        break
      }
      rawErrors.push({ offset: head.start, message: '语句应为 “名称 = 组件(...)”' })
      skipLine()
      continue
    }
    position += 2
    try {
      const expr = parseExpr()
      if (!expr) {
        incomplete = true
        break
      }
      statements.push({ id: head.value, expr, span: { start: head.start, end: expr.span.end }, line: lineOf(starts, head.start) })
      depth = 0
      const tail = raw()
      if (tail.kind !== 'newline' && tail.kind !== 'eof') {
        rawErrors.push({ offset: tail.start, message: `“${head.value}” 语句后有多余内容` })
        skipLine()
      }
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error
      rawErrors.push({ offset: error.offset, message: error.message })
      skipLine()
    }
  }

  return {
    statements,
    incomplete,
    errors: rawErrors.map((item) => ({ line: lineOf(starts, item.offset), message: item.message })),
  }
}

// ---- 解析结果 → 渲染树 ----

export interface UiArrayInfo {
  span: Span
  itemSpans: Span[]
}

export type UiChild =
  | { kind: 'node'; node: UiNode }
  | { kind: 'text'; text: string; key: string }
  | { kind: 'pending'; ref: string; key: string }

export interface UiChildList {
  items: UiChild[]
  /** 子组件直接写在数组字面量里时可拖动；来自其他形式时为 null */
  array: UiArrayInfo | null
}

export interface UiNode {
  readonly uiNode: true
  type: string
  key: string
  spec: SuperhighUiComponentSpec | null
  props: Record<string, unknown>
  children: Record<string, UiChildList>
  span: Span
  statementId?: string
  issues: string[]
}

export interface UiDocument {
  root: UiNode | null
  diagnostics: UiDiagnostic[]
  /** 仍在生成：末尾未闭合，或存在尚未定义的引用 */
  streaming: boolean
  pendingRefs: string[]
  unusedStatements: string[]
  statements: Map<string, UiStatement>
}

export function isUiNode(value: unknown): value is UiNode {
  return !!value && typeof value === 'object' && (value as UiNode).uiNode === true
}

export function resolveSuperhighUi(program: UiProgram): UiDocument {
  const statements = new Map<string, UiStatement>()
  const diagnostics: UiDiagnostic[] = [...program.errors]
  for (const statement of program.statements) {
    if (statements.has(statement.id)) diagnostics.push({ line: statement.line, message: `“${statement.id}” 重复定义，使用最后一次` })
    statements.set(statement.id, statement)
  }
  const pending = new Set<string>()
  const used = new Set<string>()
  const resolving: string[] = []

  function lookup(name: string): { statement: UiStatement } | null {
    const statement = statements.get(name)
    if (!statement) {
      pending.add(name)
      return null
    }
    used.add(name)
    return { statement }
  }

  function withRef<T>(name: string, fallback: T, resolve: (statement: UiStatement) => T): T {
    if (resolving.includes(name)) {
      diagnostics.push({ line: statements.get(name)?.line ?? 0, message: `“${name}” 存在循环引用` })
      return fallback
    }
    const found = lookup(name)
    if (!found) return fallback
    resolving.push(name)
    try {
      return resolve(found.statement)
    } finally {
      resolving.pop()
    }
  }

  function toValue(expr: UiExpr): unknown {
    switch (expr.kind) {
      case 'literal':
        return expr.value
      case 'array':
        return expr.items.map(toValue)
      case 'object':
        return Object.fromEntries(expr.entries.map((entry) => [entry.key, toValue(entry.value)]))
      case 'call':
        return toNode(expr)
      case 'ref':
        return withRef(expr.name, undefined as unknown, (statement) => {
          const value = toValue(statement.expr)
          if (isUiNode(value) && !value.statementId) value.statementId = statement.id
          return value
        })
    }
  }

  function toChild(expr: UiExpr): UiChild[] {
    if (expr.kind === 'ref') {
      return withRef(expr.name, [{ kind: 'pending', ref: expr.name, key: `pending:${expr.name}` }] as UiChild[], (statement) => {
        const children = toChild(statement.expr)
        for (const child of children) {
          if (child.kind === 'node' && !child.node.statementId) {
            child.node.statementId = statement.id
            child.node.key = statement.id
          }
        }
        return children
      })
    }
    if (expr.kind === 'call') return [{ kind: 'node', node: toNode(expr) }]
    if (expr.kind === 'array') return expr.items.flatMap(toChild)
    if (expr.kind === 'literal' && expr.value !== null) {
      return [{ kind: 'text', text: String(expr.value), key: `text@${expr.span.start}` }]
    }
    return []
  }

  function toChildList(expr: UiExpr): UiChildList {
    if (expr.kind === 'ref' && statements.get(expr.name)?.expr.kind === 'array') {
      return withRef(expr.name, { items: [], array: null } as UiChildList, (statement) => toChildList(statement.expr))
    }
    if (expr.kind !== 'array') return { items: toChild(expr), array: null }
    const perItem = expr.items.map(toChild)
    // 每个数组元素恰好对应一个子组件时，才能按源码位置拖动重排
    const array = expr.closed && perItem.every((children) => children.length === 1)
      ? { span: expr.span, itemSpans: expr.items.map((item) => item.span) }
      : null
    return { items: perItem.flat(), array }
  }

  function toNode(expr: Extract<UiExpr, { kind: 'call' }>): UiNode {
    const spec = SUPERHIGH_UI_COMPONENT_MAP.get(expr.name) ?? null
    const node: UiNode = {
      uiNode: true,
      type: expr.name,
      key: `${expr.name}@${expr.span.start}`,
      spec,
      props: {},
      children: {},
      span: expr.span,
      issues: [],
    }
    const assign = (name: string, value: UiExpr) => {
      const arg = spec?.args.find((item) => item.name === name)
      if (arg?.type === 'nodes') node.children[name] = toChildList(value)
      else node.props[name] = toValue(value)
    }
    expr.args.forEach((value, index) => {
      const arg = spec?.args[index]
      if (arg) assign(arg.name, value)
      else if (spec) node.issues.push(`多余的第 ${index + 1} 个参数`)
      else node.props[`arg${index}`] = toValue(value)
    })
    for (const entry of expr.named) {
      if (spec && !spec.args.some((item) => item.name === entry.key)) node.issues.push(`未知参数 ${entry.key}`)
      assign(entry.key, entry.value)
    }
    if (!spec) node.issues.push(`未知组件 ${expr.name}`)
    else if (expr.closed) {
      for (const arg of spec.args) {
        if (arg.required && !(arg.name in node.props) && !(arg.name in node.children)) node.issues.push(`缺少参数 ${arg.name}`)
      }
    }
    return node
  }

  const rootStatement = statements.get('root') ?? program.statements[0]
  let root: UiNode | null = null
  if (rootStatement) {
    used.add(rootStatement.id)
    resolving.push(rootStatement.id)
    const list = toChildList(rootStatement.expr)
    resolving.pop()
    const only = rootStatement.expr.kind !== 'array' && list.items.length === 1 && list.items[0].kind === 'node'
      ? list.items[0].node
      : null
    if (only) {
      root = only
      root.statementId ??= rootStatement.id
    } else if (list.items.length) {
      // root 直接写成数组或文字时，包一层 Stack 统一渲染
      root = {
        uiNode: true,
        type: 'Stack',
        key: rootStatement.id,
        spec: SUPERHIGH_UI_COMPONENT_MAP.get('Stack') ?? null,
        props: {},
        children: { children: list },
        span: rootStatement.expr.span,
        statementId: rootStatement.id,
        issues: [],
      }
    }
  }

  const streaming = program.incomplete || pending.size > 0
  const unusedStatements = streaming ? [] : program.statements.map((item) => item.id).filter((id) => !used.has(id))
  return {
    root,
    diagnostics: diagnostics.sort((a, b) => a.line - b.line),
    streaming,
    pendingRefs: [...pending],
    unusedStatements: [...new Set(unusedStatements)],
    statements,
  }
}

export function compileSuperhighUi(source: string) {
  return resolveSuperhighUi(parseSuperhighUi(source))
}
