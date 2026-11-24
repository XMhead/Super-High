import { renderMarkdown, type MarkdownRenderOptions } from './markdown'
import { findTerminalFilePathMatches, type TerminalPathTarget } from './terminalFileLinks'
import { fileIconElement } from './fileIcons'
import { setFileLinkPosition, targetFromAnchor } from './linkTargets'

/** Path detection and filesystem resolution are intentionally bounded for large transcripts. */
export const MAX_WORKSPACE_PATH_LINK_SOURCE_LENGTH = 512 * 1024

export async function linkWorkspacePaths(
  html: string,
  workspaceRoot: string,
  resolve: (path: string) => Promise<TerminalPathTarget | null>,
  options: { fileIcons?: boolean } = {},
): Promise<string> {
  if (html.length > MAX_WORKSPACE_PATH_LINK_SOURCE_LENGTH) return html
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('a, script, style')) nodes.push(node as Text)
  }
  const targets = new Map<string, Promise<TerminalPathTarget | null>>()
  await Promise.all(nodes.map(async node => {
    const text = node.data
    const inline = !!node.parentElement?.closest('code')
    const source = inline ? `\`${text}\`` : text
    const shift = inline ? 1 : 0
    const matches = findTerminalFilePathMatches(source, workspaceRoot)
    const resolved = await Promise.all(matches.map(async match => {
      if (/^https?:/i.test(match.path)) return { match, target: { path: match.path, isFile: false } }
      const path = match.path
      let target = targets.get(path)
      if (!target) {
        target = resolve(path).catch(() => null)
        targets.set(path, target)
      }
      return { match, target: await target }
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
      if (!/^https?:/i.test(target.path)) {
        anchor.setAttribute('data-workspace-path', target.path)
        setFileLinkPosition(anchor, match)
      }
      anchor.textContent = text.slice(start, end)
      fragment.append(anchor)
      offset = end
    }
    fragment.append(text.slice(offset))
    node.replaceWith(fragment)
  }))
  await Promise.all([...template.content.querySelectorAll<HTMLAnchorElement>('a[href]')].map(async anchor => {
      const target = targetFromAnchor(anchor, workspaceRoot)
      if (target?.kind === 'url') { anchor.setAttribute('href', target.url); return }
      if (target?.kind !== 'file') return
      const resolved = await (targets.get(target.path) ?? resolve(target.path).catch(() => null))
      if (!resolved) return
      if (options.fileIcons) anchor.classList.add('workspace-file-link')
      anchor.setAttribute('data-workspace-path', resolved.path)
      setFileLinkPosition(anchor, target)
      if (options.fileIcons && resolved.isFile) anchor.prepend(fileIconElement(resolved.path))
    }))
  return template.innerHTML
}

export function renderWorkspaceMarkdown(source: string, workspaceRoot: string, options: MarkdownRenderOptions = {}): string {
  if (source.length > MAX_WORKSPACE_PATH_LINK_SOURCE_LENGTH) return renderMarkdown(source, options)
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
  return renderMarkdown(protectedSource, options).split(marker).join('\\')
}
