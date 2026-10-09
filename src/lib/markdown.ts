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

type AnsiThemeColor =
  | { kind: 'theme'; name: string }
  | { kind: 'rgb'; value: string }

interface AnsiStyleState {
  foreground: AnsiThemeColor | null
  background: AnsiThemeColor | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  inverse: boolean
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

function isAnsiLanguage(language: string | undefined): boolean {
  const normalized = language?.trim().toLowerCase()
  return normalized === 'ansi' || normalized === 'ansi-color' || normalized === 'ansi-colors'
}

function hasAnsiSgr(text: string): boolean {
  return /(?:\x1b\[[0-9;]*m|\x9b[0-9;]*m)/.test(text)
}

function decodeAnsiEscapes(text: string): string {
  return text.replace(/\\(?:x1b|u001b|0*33|e)(?=\[)/gi, '\x1b')
}

function defaultAnsiStyle(): AnsiStyleState {
  return {
    foreground: null,
    background: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  }
}

function ansiThemeColor(name: string): AnsiThemeColor {
  return { kind: 'theme', name }
}

function ansiIndexedColor(index: number): AnsiThemeColor {
  const names = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ]
  if (index < names.length) return ansiThemeColor(names[index])
  if (index >= 232) {
    const channel = 8 + (index - 232) * 10
    return { kind: 'rgb', value: `rgb(${channel}, ${channel}, ${channel})` }
  }
  const cube = Math.max(0, index - 16)
  const levels = [0, 95, 135, 175, 215, 255]
  return {
    kind: 'rgb',
    value: `rgb(${levels[Math.floor(cube / 36)]}, ${levels[Math.floor(cube / 6) % 6]}, ${levels[cube % 6]})`,
  }
}

function ansiColor(code: number, bright: boolean): AnsiThemeColor {
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  return ansiThemeColor(bright ? `bright${names[code - 30][0].toUpperCase()}${names[code - 30].slice(1)}` : names[code - 30])
}

function applyAnsiSgr(sequence: string, state: AnsiStyleState): void {
  const prefixLength = sequence.startsWith('\x9b') ? 1 : 2
  const body = sequence.slice(prefixLength, -1)
  const params = body ? body.split(';').map((value) => Number(value || 0)) : [0]
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]
    if (code === 0) {
      Object.assign(state, defaultAnsiStyle())
    } else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 22) { state.bold = false; state.dim = false }
    else if (code === 3) state.italic = true
    else if (code === 23) state.italic = false
    else if (code === 4) state.underline = true
    else if (code === 24) state.underline = false
    else if (code === 9) state.strike = true
    else if (code === 29) state.strike = false
    else if (code === 7) state.inverse = true
    else if (code === 27) state.inverse = false
    else if (code === 39) state.foreground = null
    else if (code === 49) state.background = null
    else if (code >= 30 && code <= 37) state.foreground = ansiColor(code, false)
    else if (code >= 90 && code <= 97) state.foreground = ansiColor(code - 60, true)
    else if (code >= 40 && code <= 47) state.background = ansiColor(code - 10, false)
    else if (code >= 100 && code <= 107) state.background = ansiColor(code - 70, true)
    else if (code === 38 || code === 48) {
      const mode = params[index + 1]
      if (mode === 5 && Number.isInteger(params[index + 2])) {
        const color = ansiIndexedColor(Math.max(0, Math.min(255, params[index + 2])))
        if (code === 38) state.foreground = color
        else state.background = color
        index += 2
      } else if (mode === 2 && params.slice(index + 2, index + 5).every(Number.isInteger)) {
        const channels = params.slice(index + 2, index + 5).map((value) => Math.max(0, Math.min(255, value)))
        const color: AnsiThemeColor = { kind: 'rgb', value: `rgb(${channels.join(', ')})` }
        if (code === 38) state.foreground = color
        else state.background = color
        index += 4
      }
    }
  }
}

function ansiColorValue(color: AnsiThemeColor): string {
  return color.kind === 'theme' ? `var(--terminal-ansi-${color.name})` : color.value
}

function ansiStyleAttribute(state: AnsiStyleState): string {
  let foreground = state.foreground
  let background = state.background
  if (state.inverse) [foreground, background] = [background, foreground]
  const styles: string[] = []
  if (foreground) styles.push(`color:${ansiColorValue(foreground)}`)
  if (background) styles.push(`background-color:${ansiColorValue(background)}`)
  if (state.bold) styles.push('font-weight:700')
  if (state.dim) styles.push('opacity:.7')
  if (state.italic) styles.push('font-style:italic')
  if (state.underline || state.strike) styles.push(`text-decoration:${[state.underline && 'underline', state.strike && 'line-through'].filter(Boolean).join(' ')}`)
  return styles.join(';')
}

function renderAnsiCode(text: string, language: string): string {
  const source = decodeAnsiEscapes(text)
  const sequencePattern = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g
  const state = defaultAnsiStyle()
  const chunks: string[] = []
  let cursor = 0
  for (const match of source.matchAll(sequencePattern)) {
    const start = match.index ?? 0
    if (start > cursor) {
      const value = escapeHtml(source.slice(cursor, start))
      const style = ansiStyleAttribute(state)
      chunks.push(style ? `<span style="${escapeAttribute(style)}">${value}</span>` : value)
    }
    const sequence = match[0]
    if (sequence.endsWith('m')) applyAnsiSgr(sequence, state)
    cursor = start + sequence.length
  }
  const trailing = escapeHtml(source.slice(cursor))
  const trailingStyle = ansiStyleAttribute(state)
  chunks.push(trailingStyle ? `<span style="${escapeAttribute(trailingStyle)}">${trailing}</span>` : trailing)
  return `<pre class="sh-ansi-preview"><code class="language-${escapeAttribute(language)} sh-code-highlight sh-code-highlight-ansi">${chunks.join('')}</code></pre>\n`
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
    : isAnsiLanguage(token.lang) || hasAnsiSgr(token.text)
      ? renderAnsiCode(token.text, token.lang?.trim().toLowerCase() || 'ansi')
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
