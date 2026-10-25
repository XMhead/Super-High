/** 长文本粘贴转 .agent/tmp 文件，以及输入框 `@` 引用这些文件。 */

/** 粘贴文本超过该字符数时导出为文件卡片。 */
export const PASTED_TEXT_THRESHOLD = 500

export interface CliTextAttachment {
  id: string
  path: string
  fileName: string
}

export function shouldExportPastedText(text: string): boolean {
  return Array.from(text).length > PASTED_TEXT_THRESHOLD
}

/** 本地时间，形如 `2026年10月21日14时05分33秒`；文件名前缀由后端追加。 */
export function pastedTextStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`
    + `${pad(date.getHours())}时${pad(date.getMinutes())}分${pad(date.getSeconds())}秒`
}

export function buildCliMessageWithTextFiles(text: string, paths: string[]): string {
  const trimmed = text.trim()
  const uniquePaths = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)))
  if (!uniquePaths.length) return trimmed
  const block = uniquePaths
    .map((path, index) => `${uniquePaths.length === 1 ? '文本' : `文本${index + 1}`}路径：${path}`)
    .join('\n')
  return trimmed ? `${block}\n${trimmed}` : block
}

/** 光标前紧邻的 `@查询`；`@` 须位于开头或空白之后。 */
export function mentionQueryFromDraft(draft: string, cursor = draft.length): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, cursor))
  if (!match) return null
  return { start: cursor - match[1].length - 1, query: match[1] }
}

export function matchPastedTextFiles<T extends { name: string }>(files: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle ? files.filter((file) => file.name.toLocaleLowerCase().includes(needle)) : files
}
