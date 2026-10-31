import { renderMarkdown } from './markdown'
import { findTerminalFilePathMatches, type TerminalPathTarget } from './terminalFileLinks'
import { noticeLinkTarget } from './cliCompletion'
import { fileIconElement } from './fileIcons'

export async function linkWorkspacePaths(
  html: string,
  workspaceRoot: string,
  resolve: (path: string) => Promise<TerminalPathTarget | null>,
  options: { fileIcons?: boolean } = {},
): Promise<string> {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('a, pre, script, style')) nodes.push(node as Text)
  }
  const targets = new Map<string, Promise<TerminalPathTarget | null>>()
  await Promise.all(nodes.map(async node => {
    const text = node.data
    const inline = !!node.parentElement?.closest('code')
    const source = inline ? `\`${text}\`` : text
    const shift = inline ? 1 : 0
    const matches = findTerminalFilePathMatches(source, workspaceRoot)
      .filter(match => !/^(?:https?:|file:)/i.test(match.path))
    const resolved = await Promise.all(matches.map(async match => {
      const link = noticeLinkTarget(match.path, workspaceRoot)
      const path = link?.kind === 'file' && link.lineNumber ? link.path : match.path
      let target = targets.get(path)
      if (!target) {
        target = resolve(path).catch(() => null)
        targets.set(path, target)
      }
      const suffix = text.slice(match.end - shift).match(/^(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)/i)
      const lineNumber = link?.kind === 'file' ? link.lineNumber ?? Number(suffix?.[1] ?? suffix?.[2]) : undefined
      return { match: { ...match, end: match.end + (suffix?.[0].length ?? 0), lineNumber }, target: await target }
    }))
    const fragment = document.createDocumentFragment()
    let offset = 0
    for (const { match, target } of resolved) {
      const start = match.start - shift
      const end = match.end - shift
      if (!target || start < offset || end > text.length) continue
      fragment.append(text.slice(offset, start))
      const anchor = document.createElement('a')
      anchor.setAttribute('href', target.path)
      anchor.setAttribute('data-workspace-path', target.path)
      if (match.lineNumber) anchor.setAttribute('data-line-number', String(match.lineNumber))
      anchor.textContent = text.slice(start, end)
      fragment.append(anchor)
      offset = end
    }
    fragment.append(text.slice(offset))
    node.replaceWith(fragment)
  }))
  if (options.fileIcons) {
    await Promise.all([...template.content.querySelectorAll<HTMLAnchorElement>('a[href]')].map(async anchor => {
      const target = noticeLinkTarget(anchor.getAttribute('href') ?? '', workspaceRoot)
      if (target?.kind !== 'file') return
      const resolved = await resolve(target.path).catch(() => null)
      if (!resolved) return
      anchor.classList.add('workspace-file-link')
      anchor.setAttribute('data-workspace-path', resolved.path)
      if (target.lineNumber) anchor.setAttribute('data-line-number', String(target.lineNumber))
      if (resolved.isFile) anchor.prepend(fileIconElement(resolved.path))
    }))
  }
  return template.innerHTML
}

export function renderWorkspaceMarkdown(source: string, workspaceRoot: string): string {
  const positions = new Set<number>()
  for (const match of findTerminalFilePathMatches(source, workspaceRoot)) {
    for (let offset = match.start; offset < match.end; offset++) {
      if (source[offset] === '\\') positions.add(offset)
    }
  }
  let marker = 'SUPERHIGHWORKSPACEBACKSLASH'
  while (source.includes(marker)) marker += 'X'
  let protectedSource = ''
  for (let offset = 0; offset < source.length; offset++) {
    protectedSource += positions.has(offset) ? marker : source[offset]
  }
  return renderMarkdown(protectedSource).split(marker).join('\\')
}
