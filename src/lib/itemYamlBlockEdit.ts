export interface ReplaceItemYamlBlockRequest {
  itemKey: string
  lineNumber: number
  nextBlock: string
}

export interface ReplaceItemYamlBlockResult {
  content: string
  startLineNumber: number
  endLineNumber: number
}

export function replaceItemYamlBlockInFile(
  content: string,
  request: ReplaceItemYamlBlockRequest,
): ReplaceItemYamlBlockResult {
  const lines = splitLogicalLines(content)
  const replacementLines = splitLogicalLines(request.nextBlock)
  const replacementKey = replacementLines.length ? topLevelYamlKey(replacementLines[0]) : null
  if (!replacementKey) {
    throw new Error('保存内容必须从顶层物品 key 开始')
  }

  const startIndex = findItemBlockStart(lines, request.itemKey, request.lineNumber)
  const endIndex = findItemBlockEnd(lines, startIndex)
  const nextLines = [
    ...lines.slice(0, startIndex),
    ...replacementLines,
    ...lines.slice(endIndex),
  ]
  const eol = detectLineEnding(content)
  const nextContent = nextLines.join(eol) + (endsWithNewline(content) ? eol : '')

  return {
    content: nextContent,
    startLineNumber: startIndex + 1,
    endLineNumber: startIndex + replacementLines.length,
  }
}

function findItemBlockStart(lines: string[], itemKey: string, lineNumber: number): number {
  const hintedIndex = Math.max(0, lineNumber - 1)
  if (topLevelYamlKey(lines[hintedIndex] ?? '') === itemKey) return hintedIndex

  const matches = lines
    .map((line, index) => ({ key: topLevelYamlKey(line), index }))
    .filter((entry) => entry.key === itemKey)

  if (matches.length === 1) return matches[0].index
  if (matches.length > 1) throw new Error(`找到多个物品块：${itemKey}`)
  throw new Error(`未找到物品块：${itemKey}`)
}

function findItemBlockEnd(lines: string[], startIndex: number): number {
  let nextTopLevelIndex = lines.length
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (topLevelYamlKey(lines[index])) {
      nextTopLevelIndex = index
      break
    }
  }
  let endIndex = nextTopLevelIndex
  while (endIndex > startIndex + 1 && lines[endIndex - 1].trim() === '') {
    endIndex -= 1
  }
  return endIndex
}

function splitLogicalLines(value: string): string[] {
  if (!value) return []
  const lines = value.split(/\r\n|\n|\r/)
  if (endsWithNewline(value)) lines.pop()
  return lines
}

function detectLineEnding(value: string): string {
  if (value.includes('\r\n')) return '\r\n'
  if (value.includes('\r')) return '\r'
  return '\n'
}

function endsWithNewline(value: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(value)
}

function topLevelYamlKey(line: string): string | null {
  if (/^[ \t]/.test(line)) return null
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) return null
  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex < 0) return null
  const key = unquoteYamlKey(trimmed.slice(0, separatorIndex).trim())
  return key ? key : null
}

function unquoteYamlKey(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim()
    }
  }
  return value.trim()
}
