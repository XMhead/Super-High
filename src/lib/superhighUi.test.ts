import { describe, expect, it } from 'vitest'
import { compileSuperhighUi, isUiNode, parseSuperhighUi, type UiChildList, type UiNode } from './superhighUi'
import { moveSuperhighUiArrayItem } from './superhighUiEdit'

const childNodes = (list: UiChildList | undefined) => (list?.items ?? []).map((child) => (child.kind === 'node' ? child.node : child))

describe('parseSuperhighUi', () => {
  it('parses statements with positional, named and multi-line arguments', () => {
    const program = parseSuperhighUi([
      '# 构建报告',
      'root = Stack([title, table], gap: "l")',
      'title = Text("构建结果", "title")',
      'table = Table(',
      '  ["文件", "状态"],',
      '  [["a.ts", Badge("ok", tone: "ok")], ["b.ts", "失败"]],',
      ')',
    ].join('\n'))
    expect(program.errors).toEqual([])
    expect(program.incomplete).toBe(false)
    expect(program.statements.map((item) => [item.id, item.line])).toEqual([['root', 2], ['title', 3], ['table', 4]])
  })

  it('treats a half-written tail as incomplete instead of an error', () => {
    const program = parseSuperhighUi('root = Card("标题", [a, b])\na = Text("正在写')
    expect(program.errors).toEqual([])
    expect(program.incomplete).toBe(true)
    expect(program.statements.map((item) => item.id)).toEqual(['root', 'a'])
  })

  it('reports a broken line and keeps parsing later statements', () => {
    const program = parseSuperhighUi('root = Stack([a])\noops Text("x")\na = Text("ok" "no comma")\nb = Text("fine")')
    expect(program.errors.map((item) => item.line)).toEqual([2, 3])
    expect(program.statements.map((item) => item.id)).toEqual(['root', 'b'])
  })
})

describe('resolveSuperhighUi', () => {
  it('maps positional args by component spec and resolves hoisted references', () => {
    const doc = compileSuperhighUi('root = Card("概览", [s1, s2], tone: "ok")\ns1 = Stat("耗时", "42s")\ns2 = Stat("失败", 0, "-2")')
    const root = doc.root as UiNode
    expect(root.type).toBe('Card')
    expect(root.props).toMatchObject({ title: '概览', tone: 'ok' })
    const children = childNodes(root.children.children) as UiNode[]
    expect(children.map((node) => [node.statementId, node.props.label])).toEqual([['s1', '耗时'], ['s2', '失败']])
    expect(root.children.children.array?.itemSpans).toHaveLength(2)
    expect(doc.streaming).toBe(false)
    expect(doc.diagnostics).toEqual([])
  })

  it('renders pending placeholders while references are still streaming in', () => {
    const doc = compileSuperhighUi('root = Stack([head, body])\nhead = Text("先出现")')
    expect(doc.streaming).toBe(true)
    expect(doc.pendingRefs).toEqual(['body'])
    expect(childNodes(doc.root?.children.children).map((item) => ('kind' in item ? item.kind : item.type))).toEqual(['Text', 'pending'])
  })

  it('keeps component values inside data arguments', () => {
    const doc = compileSuperhighUi('root = Table(["名称", "状态"], [["a", Badge("ok", "ok")]])')
    const rows = doc.root?.props.rows as unknown[][]
    expect(isUiNode(rows[0][1])).toBe(true)
  })

  it('reports unknown components, missing args, unused statements and cycles', () => {
    const doc = compileSuperhighUi('root = Stack([Fancy("x"), Badge(), loop])\nloop = Stack([loop])\nspare = Text("unused")')
    const [fancy, badge] = childNodes(doc.root?.children.children) as UiNode[]
    expect(fancy.issues).toContain('未知组件 Fancy')
    expect(badge.issues).toContain('缺少参数 label')
    expect(doc.unusedStatements).toEqual(['spare'])
    expect(doc.diagnostics.some((item) => item.message.includes('循环引用'))).toBe(true)
  })

  it('wraps an array root in a Stack', () => {
    const doc = compileSuperhighUi('root = [Text("a"), Text("b")]')
    expect(doc.root?.type).toBe('Stack')
    expect(doc.root?.children.children.items).toHaveLength(2)
  })
})

describe('moveSuperhighUiArrayItem', () => {
  const arrayOf = (source: string, statementId: string) => {
    const doc = compileSuperhighUi(source)
    const find = (node: UiNode | null): UiChildList | null => {
      if (!node) return null
      if (node.statementId === statementId) return node.children.children ?? null
      for (const list of Object.values(node.children)) {
        for (const child of list.items) {
          const found = child.kind === 'node' ? find(child.node) : null
          if (found) return found
        }
      }
      return null
    }
    const array = find(doc.root)?.array
    if (!array) throw new Error(`no array for ${statementId}`)
    return array
  }

  it('reorders references inside a single-line array', () => {
    const source = 'root = Stack([a, b, c])\na = Text("a")\nb = Text("b")\nc = Text("c")'
    const array = arrayOf(source, 'root')
    expect(moveSuperhighUiArrayItem(source, { array, index: 0 }, { array, index: 3 })).toContain('Stack([b, c, a])')
    expect(moveSuperhighUiArrayItem(source, { array, index: 2 }, { array, index: 0 })).toContain('Stack([c, a, b])')
    expect(moveSuperhighUiArrayItem(source, { array, index: 1 }, { array, index: 2 })).toBeNull()
  })

  it('keeps multi-line formatting and moves inline components verbatim', () => {
    const source = 'root = Stack([\n  Text("a"),\n  Badge("b", "ok"),\n])'
    const array = arrayOf(source, 'root')
    expect(moveSuperhighUiArrayItem(source, { array, index: 1 }, { array, index: 0 })).toBe('root = Stack([\n  Badge("b", "ok"),\n  Text("a"),\n])')
  })

  it('moves an item into another container, including an empty one', () => {
    const source = 'root = Stack([left, right])\nleft = Card("L", [x, y])\nright = Card("R", [])\nx = Text("x")\ny = Text("y")'
    const from = arrayOf(source, 'left')
    const to = arrayOf(source, 'right')
    const moved = moveSuperhighUiArrayItem(source, { array: from, index: 0 }, { array: to, index: 0 })
    expect(moved).toContain('left = Card("L", [y])')
    expect(moved).toContain('right = Card("R", [x])')
    const parsed = compileSuperhighUi(moved!)
    expect(parsed.diagnostics).toEqual([])
  })

  it('moves a child out of a nested container into its ancestor', () => {
    const source = 'root = Stack([Card("c", [Text("inner"), Text("keep")]), Text("tail")])'
    const outer = arrayOf(source, 'root')
    const doc = compileSuperhighUi(source)
    const card = childNodes(doc.root?.children.children)[0] as UiNode
    const inner = card.children.children.array!
    const moved = moveSuperhighUiArrayItem(source, { array: inner, index: 0 }, { array: outer, index: 2 })
    expect(moved).toBe('root = Stack([Card("c", [Text("keep")]), Text("tail"), Text("inner")])')
  })

  it('refuses to drop a container into itself', () => {
    const source = 'root = Stack([Card("c", [Text("x")]), Text("y")])'
    const outer = arrayOf(source, 'root')
    const doc = compileSuperhighUi(source)
    const card = childNodes(doc.root?.children.children)[0] as UiNode
    expect(moveSuperhighUiArrayItem(source, { array: outer, index: 0 }, { array: card.children.children.array!, index: 0 })).toBeNull()
  })
})
