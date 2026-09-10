import { describe, expect, it } from 'vitest'

import { buildYamlKeyIndex, findYamlKeyValueLine, parseYamlSyntaxIssues, scanYamlTopLevelKeys } from './yamlPreview'

describe('findYamlKeyValueLine', () => {
  it('detects plain and list item key value lines', () => {
    expect(findYamlKeyValueLine('name: Super High')).toEqual({
      keyStartIndex: 0,
      keyEndIndex: 4,
      separatorIndex: 4,
      valueStartIndex: 6,
      valueEndIndex: 16,
      valueKind: 'plain',
    })

    expect(findYamlKeyValueLine('  - enabled: true')).toEqual({
      keyStartIndex: 4,
      keyEndIndex: 11,
      separatorIndex: 11,
      valueStartIndex: 13,
      valueEndIndex: 17,
      valueKind: 'plain',
    })
  })

  it('ignores plain text and comments', () => {
    expect(findYamlKeyValueLine('just some text')).toBeNull()
    expect(findYamlKeyValueLine('https://example.com')).toBeNull()
    expect(findYamlKeyValueLine('  # comment')).toBeNull()
    expect(findYamlKeyValueLine('---')).toBeNull()
  })

  it('does not treat colons inside quoted text as separators', () => {
    expect(findYamlKeyValueLine('url: "https://example.com/a:b" # inline note')).toEqual({
      keyStartIndex: 0,
      keyEndIndex: 3,
      separatorIndex: 3,
      valueStartIndex: 5,
      valueEndIndex: 30,
      valueKind: 'plain',
    })

    expect(findYamlKeyValueLine('"a:b": value')).toEqual({
      keyStartIndex: 0,
      keyEndIndex: 5,
      separatorIndex: 5,
      valueStartIndex: 7,
      valueEndIndex: 12,
      valueKind: 'plain',
    })
  })

  it('detects yaml block scalar markers without treating following lines as yaml tokens', () => {
    expect(findYamlKeyValueLine('执行登录注册: |-')).toEqual({
      keyStartIndex: 0,
      keyEndIndex: 6,
      separatorIndex: 6,
      valueStartIndex: 8,
      valueEndIndex: 10,
      valueKind: 'block',
    })

    expect(findYamlKeyValueLine('script: >- # folded')).toEqual({
      keyStartIndex: 0,
      keyEndIndex: 6,
      separatorIndex: 6,
      valueStartIndex: 8,
      valueEndIndex: 10,
      valueKind: 'block',
    })
  })
})

describe('parseYamlSyntaxIssues', () => {
  it('returns no issues for valid yaml', () => {
    expect(parseYamlSyntaxIssues('title: test\nitems:\n  - name: one\n')).toEqual([])
  })

  it('reports yaml syntax errors with line numbers', () => {
    const issues = parseYamlSyntaxIssues('title:\n\tname: test\n')

    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0].lineNumber).toBe(2)
    expect(issues[0].message).toContain('YAML 第 2 行')
  })
})

describe('scanYamlTopLevelKeys', () => {
  it('returns only root mapping keys in file order', () => {
    const keys = scanYamlTopLevelKeys([
      'title: 仓库',
      'layout:',
      '  rows: 6',
      '  slots:',
      '    - id: main',
      '"按钮:关闭":',
      '  x: 1',
      'title: duplicate',
      '',
    ].join('\n'))

    expect(keys.map((key) => key.keyName)).toEqual(['title', 'layout', '按钮:关闭', 'title'])
    expect(keys.map((key) => key.lineNumber)).toEqual([1, 2, 6, 8])
  })

  it('exposes top-level keys from the yaml key index', () => {
    const index = buildYamlKeyIndex('root:\n  child: true\nsecond: 2\n')

    expect(index.topLevel.map((key) => key.keyName)).toEqual(['root', 'second'])
    expect(index.all.map((key) => key.keyName)).toEqual(['root', 'child', 'second'])
  })
})
