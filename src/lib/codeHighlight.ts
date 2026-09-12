import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

const languages = import.meta.glob<{ default: LanguageFn }>([
  '../../node_modules/highlight.js/es/languages/*.js',
  '!../../node_modules/highlight.js/es/languages/*.js.js',
])
const aliases: Record<string, string> = {
  html: 'xml', shell: 'bash', bat: 'dos', proto: 'protobuf', systemverilog: 'verilog',
}

export function escapeCode(content: string): string {
  return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function highlightCode(content: string, language: string): Promise<string> {
  const name = aliases[language] ?? language
  const load = languages[`../../node_modules/highlight.js/es/languages/${name}.js`]
  if (!load) return escapeCode(content)
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, (await load()).default)
  return hljs.highlight(content, { language: name, ignoreIllegals: true }).value
}
