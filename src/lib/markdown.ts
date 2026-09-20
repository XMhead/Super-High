import { Renderer, marked } from 'marked'

import { buildItemYamlPreviewLines } from './itemYamlPreview'

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
