import { renderMarkdown } from './markdown'
import { findTerminalFilePathMatches, type TerminalPathTarget } from './terminalFileLinks'

export async function linkWorkspacePaths(
  html: string,
  workspaceRoot: string,
  resolve: (path: string) => Promise<TerminalPathTarget | null>,
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
      let target = targets.get(match.path)
      if (!target) {
        target = resolve(match.path).catch(() => null)
        targets.set(match.path, target)
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
      anchor.textContent = text.slice(start, end)
      fragment.append(anchor)
      offset = end
    }
    fragment.append(text.slice(offset))
    node.replaceWith(fragment)
  }))
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
