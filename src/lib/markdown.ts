import { Renderer, marked } from 'marked'

import { buildItemYamlPreviewLines } from './itemYamlPreview'

export interface MarkdownHeadingSpan {
  /** Heading text without the Markdown marker or optional closing hashes. */
  keyName: string
  /** 1-based line number. */
  lineNumber: number
  /** 0-based column where the heading text starts on its line. */
  startColumn: number
  /** 0-based column past the last heading character. */
  endColumn: number
  /** Heading depth (`1` for `#`, `6` for `######`). */
  level: number
  /** Stable id used to locate this heading in the rendered preview. */
  anchorId: string
  /** Relative depth in the navigation tree. */
  navigationDepth: number
}

// Single source of truth for Markdown rendering across the app so that the
// task-card preview and the editor preview look identical.
marked.setOptions({
  gfm: true,
  breaks: true,
})

export interface MarkdownRenderOptions {
  resolveUrl?: (url: string, kind: 'image' | 'link') => string
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function isYamlLanguage(language: string | undefined): boolean {
  return language?.trim().toLowerCase() === 'yaml' || language?.trim().toLowerCase() === 'yml'
}

/**
 * Scan Markdown headings for the editor navigation tree. A single level-one
 * heading followed by deeper headings is treated as the document title, so
 * the next heading level becomes the tree root (for example CHANGELOG.md).
 * Fenced code blocks are ignored so examples in README files do not become
 * navigation entries.
 */
export function scanMarkdownHeadings(source: string): MarkdownHeadingSpan[] {
  const headings: Array<Omit<MarkdownHeadingSpan, 'navigationDepth'>> = []
  const lines = source.split(/\r?\n/)
  let fence: { marker: '`' | '~'; length: number } | null = null
  let headingOrdinal = 0

  const addHeading = (title: string, lineNumber: number, startColumn: number, level: number) => {
    const normalizedTitle = title.trim().replace(/[ \t]+#+[ \t]*$/, '').trim()
    if (!normalizedTitle) return
    const anchorId = `md-heading-${headingOrdinal}`
    headingOrdinal += 1
    headings.push({
      keyName: normalizedTitle,
      lineNumber,
      startColumn,
      endColumn: startColumn + normalizedTitle.length,
      level,
      anchorId,
    })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (!fence) fence = { marker, length: fenceMatch[1].length }
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null
      continue
    }
    if (fence) continue

    const match = line.match(/^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/)
    if (match) {
      const rawTitle = match[3]
      const leadingWhitespace = rawTitle.length - rawTitle.trimStart().length
      addHeading(rawTitle, index + 1, match[1].length + match[2].length + leadingWhitespace, match[2].length)
      continue
    }

    const setext = line.match(/^ {0,3}(\S(?:.*?\S)?)\s*$/)
    const underline = lines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/)
    if (setext && underline) {
      addHeading(setext[1], index + 1, line.indexOf(setext[1]), underline[1][0] === '=' ? 1 : 2)
      index += 1
    }
  }

  const levelOneCount = headings.filter((heading) => heading.level === 1).length
  const hasDeeperHeading = headings.some((heading) => heading.level > 1)
  const hasDocumentTitle = headings[0]?.level === 1 && levelOneCount === 1 && hasDeeperHeading
  const contentHeadings = hasDocumentTitle ? headings.filter((heading) => heading.level !== 1) : headings
  const rootLevel = contentHeadings.length ? Math.min(...contentHeadings.map((heading) => heading.level)) : 1
  return contentHeadings.map((heading) => ({
    ...heading,
    navigationDepth: Math.max(0, heading.level - rootLevel),
  }))
}

function renderYamlCode(text: string, language: string): string {
  const content = buildItemYamlPreviewLines(text).map((line) => line.segments.map((segment) => {
    const value = escapeHtml(segment.text)
    if (segment.kind === 'indent') return value
    const color = segment.color ? ` style="color:${escapeAttribute(segment.color)}"` : ''
    return `<span class="sh-code-token sh-code-token-${segment.kind}"${color}>${value}</span>`
  }).join('')).join('\n')
  return `<pre><code class="language-${escapeAttribute(language)} sh-code-highlight sh-code-highlight-yaml">${content}</code></pre>\n`
}

export function renderMarkdown(source: string | null | undefined, options: MarkdownRenderOptions = {}): string {
  const renderer = new Renderer()
  const defaultCodeRenderer = renderer.code.bind(renderer)
  let headingOrdinal = 0
  renderer.heading = (token) => {
    const anchorId = `md-heading-${headingOrdinal}`
    headingOrdinal += 1
    const content = renderer.parser.parseInline(token.tokens)
    return `<h${token.depth} id="${escapeAttribute(anchorId)}" data-md-heading-id="${escapeAttribute(anchorId)}">${content}</h${token.depth}>\n`
  }
  renderer.code = (token) => isYamlLanguage(token.lang)
    ? renderYamlCode(token.text, token.lang?.trim().toLowerCase() || 'yaml')
    : defaultCodeRenderer(token)

  if (options.resolveUrl) {
    const resolveUrl = options.resolveUrl
    renderer.image = (token) => {
      const href = resolveUrl(token.href, 'image')
      const title = token.title ? ` title="${escapeAttribute(token.title)}"` : ''
      const alt = token.text ? ` alt="${escapeAttribute(token.text)}"` : ' alt=""'
      return `<img src="${escapeAttribute(href)}"${alt}${title}>`
    }
    renderer.link = (token) => {
      const href = resolveUrl(token.href, 'link')
      const title = token.title ? ` title="${escapeAttribute(token.title)}"` : ''
      return `<a href="${escapeAttribute(href)}"${title}>${renderer.parser.parseInline(token.tokens)}</a>`
    }
  }

  return marked.parse(source ?? '', { async: false, renderer }) as string
}
