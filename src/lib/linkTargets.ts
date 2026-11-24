import { resolveWorkspaceReference } from './path'

export interface FileLinkPosition {
  lineNumber?: number
  column?: number
  endLineNumber?: number
  endColumn?: number
  anchor?: string
}

export type LinkTarget =
  | { kind: 'url'; url: string }
  | ({ kind: 'file'; path: string } & FileLinkPosition)

const locationSuffix = /(?:#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?|:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?|\((\d+),(\d+)\))$/i
export const fileLinkSuffix = /^(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?|\(\d+,\d+\)|#[^\s"'`<>|，。；！？、）】》]+)/i

export function splitFileLinkLocation(value: string): { path: string } & FileLinkPosition {
  const suffix = value.match(locationSuffix)
  if (suffix) {
    const position: FileLinkPosition = { lineNumber: Number(suffix[1] ?? suffix[5] ?? suffix[9]) || undefined }
    const column = Number(suffix[2] ?? suffix[6] ?? suffix[10]) || undefined
    const endLineNumber = Number(suffix[3] ?? suffix[7]) || undefined
    const endColumn = Number(suffix[4] ?? suffix[8]) || undefined
    if (column) position.column = column
    if (endLineNumber) position.endLineNumber = endLineNumber
    if (endColumn) position.endColumn = endColumn
    return { path: value.slice(0, -suffix[0].length), ...position }
  }
  const hash = value.indexOf('#')
  if (hash >= 0 && /\.[\p{L}\p{N}_-]+$/u.test(value.slice(0, hash))) {
    let anchor = value.slice(hash + 1)
    try { anchor = decodeURIComponent(anchor) } catch { /* Keep malformed escapes readable. */ }
    return { path: value.slice(0, hash), ...(anchor ? { anchor } : {}) }
  }
  return { path: value }
}

export function trimLinkPunctuation(text: string, stopAtProse = false): string {
  let value = text
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{', '）': '（', '】': '【', '》': '《', '」': '「', '』': '『' }
  if (stopAtProse) {
    const balance = new Map<string, number>()
    const opens = new Set(Object.values(pairs))
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!
      const open = pairs[char]
      if (/[，。；！？、”’]/.test(char) || (open && !balance.get(open))) { value = value.slice(0, index); break }
      if (opens.has(char)) balance.set(char, (balance.get(char) ?? 0) + 1)
      if (open) balance.set(open, (balance.get(open) ?? 0) - 1)
    }
  }
  while (value) {
    const previous = value
    value = value.replace(/[.,;!?，。；！？、”’]+$/, '')
    const close = value.at(-1)!
    const open = pairs[close]
    if (open && value.split(close).length > value.split(open).length) value = value.slice(0, -1)
    if (value === previous) break
  }
  return value
}

export function parseLinkTarget(href: string, workspace: string): LinkTarget | null {
  const raw = href.trim().replace(/^<([\s\S]*)>$/, '$1')
  if (!raw || raw.startsWith('#')) return null
  if (/^(?:https?:\/\/|www\.)/i.test(raw)) return { kind: 'url', url: /^www\./i.test(raw) ? `https://${raw}` : raw }
  const { path, ...position } = splitFileLinkLocation(raw)
  let value = path
  if (/^file:\/\//i.test(value)) {
    const url = new URL(value)
    value = (url.hostname ? '//' + url.hostname : '') + url.pathname
  }
  try { value = decodeURIComponent(value) } catch { /* Keep the original spelling. */ }
  value = value.replace(/\\/g, '/').replace(/^\/+(?=[A-Za-z]:\/)/, '')
  if (!value || /^[a-z][a-z\d+.-]+:/i.test(value)) return null
  if (!/^[A-Za-z]:\//.test(value) && !value.startsWith('/')) {
    const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!root) return null
    value = resolveWorkspaceReference(root, value)
  }
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) && !/^[A-Za-z]:$/.test(parts.at(-1)!)) parts.pop()
    else parts.push(part)
  }
  return { kind: 'file', path: parts.join('/'), lineNumber: undefined, ...position }
}

/** Preserve the same location metadata through generated anchors and click handlers. */
export function setFileLinkPosition(anchor: HTMLAnchorElement, position: FileLinkPosition) {
  for (const key of ['lineNumber', 'column', 'endLineNumber', 'endColumn', 'anchor'] as const) {
    if (position[key] !== undefined) anchor.dataset[key] = String(position[key])
  }
}

export function targetFromAnchor(anchor: Element, workspace: string): LinkTarget | null {
  const resolvedPath = anchor.getAttribute('data-workspace-path')
  const target: LinkTarget | null = resolvedPath
    ? { kind: 'file', path: resolvedPath.replace(/\\/g, '/'), lineNumber: undefined }
    : parseLinkTarget(anchor.getAttribute('href') ?? '', workspace)
  if (target?.kind !== 'file') return target
  for (const key of ['lineNumber', 'column', 'endLineNumber', 'endColumn'] as const) {
    const name = key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
    const value = Number(anchor.getAttribute(`data-${name}`))
    if (Number.isSafeInteger(value) && value > 0) target[key] = value
  }
  const heading = anchor.getAttribute('data-anchor')
  if (heading) target.anchor = heading
  return target
}

export function fileLinkArguments(target: { path: string } & FileLinkPosition): [string, number | undefined, FileLinkPosition?] {
  const { path, lineNumber, column, endLineNumber, endColumn, anchor } = target
  const position = { ...(column ? { column } : {}), ...(endLineNumber ? { endLineNumber } : {}), ...(endColumn ? { endColumn } : {}), ...(anchor ? { anchor } : {}) }
  return Object.keys(position).length ? [path, lineNumber, position] : [path, lineNumber]
}
