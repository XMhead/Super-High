export interface CodePreviewSelectionRange {
  startLineNumber: number
  endLineNumber: number
  endColumn: number
}

export function formatCodePreviewSelectionSource(path: string, startLineNumber: number, endLineNumber: number): string {
  const startLine = Math.max(1, Math.min(startLineNumber, endLineNumber))
  const endLine = Math.max(1, Math.max(startLineNumber, endLineNumber))
  const lineText = startLine === endLine
    ? `第 ${startLine} 行`
    : `第 ${startLine} 行到第 ${endLine} 行`

  return `查看选取内容 ${path} ${lineText}`
}

export function formatCodePreviewSelectionSourceForRange(path: string, range: CodePreviewSelectionRange): string {
  return formatCodePreviewSelectionSource(path, range.startLineNumber, displayCodePreviewSelectionEndLine(range))
}

function displayCodePreviewSelectionEndLine(range: CodePreviewSelectionRange): number {
  if (range.endColumn === 1 && range.endLineNumber > range.startLineNumber) {
    return range.endLineNumber - 1
  }
  return range.endLineNumber
}
