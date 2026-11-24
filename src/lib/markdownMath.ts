import type { TokenizerAndRendererExtension, Tokens } from 'marked'
import temml from 'temml'

interface MathToken extends Tokens.Generic {
  expression: string
}

const INLINE_DOLLARS = /^\$(?![\s$])((?:\\[^\n]|[^$`\\\n])+?)(?<!\s)\$(?![\d$])/
const INLINE_PARENS = /^\\\(((?:\\[^\n]|[^\\\n])+?)\\\)/
const BLOCK_DOLLARS = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/
const BLOCK_BRACKETS = /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/

function tokenizeMath(type: string, match: RegExpMatchArray | null): MathToken | undefined {
  const expression = match?.[1].trim()
  if (!match || !expression) return undefined
  return { type, raw: match[0], expression }
}

function renderMath(token: MathToken, displayMode: boolean): string {
  try {
    const math = temml.renderToString(token.expression, {
      displayMode,
      trust: false,
      throwOnError: true,
    })
    return displayMode ? '<div class="sh-math-display">' + math + '</div>\n' : math
  } catch {
    return token.raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

export const markdownMathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: 'mathBlock',
    level: 'block',
    start: (source) => source.search(/^ {0,3}(?:\$\$|\\\[)/m),
    tokenizer: (source) => tokenizeMath('mathBlock', source.match(BLOCK_DOLLARS) ?? source.match(BLOCK_BRACKETS)),
    renderer: (token) => renderMath(token as MathToken, true),
  },
  {
    name: 'mathInline',
    level: 'inline',
    start: (source) => source.search(/\$|\\\(/),
    tokenizer: (source) => tokenizeMath('mathInline', source.match(INLINE_DOLLARS) ?? source.match(INLINE_PARENS)),
    renderer: (token) => renderMath(token as MathToken, false),
  },
]
