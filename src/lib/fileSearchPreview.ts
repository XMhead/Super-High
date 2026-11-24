/** Validate the complete line with the caller's JavaScript regex before clipping display text. */
export function fileSearchPreviewForMatch(line: string, tester: RegExp): string | null {
  tester.lastIndex = 0
  const match = tester.exec(line)
  if (!match) return null
  const start = Math.max(0, match.index - 100)
  return line.slice(start, start + 500)
}
