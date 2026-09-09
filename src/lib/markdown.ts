import { Renderer, marked } from 'marked'

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

export function renderMarkdown(source: string | null | undefined, options: MarkdownRenderOptions = {}): string {
  const renderer = new Renderer()

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
