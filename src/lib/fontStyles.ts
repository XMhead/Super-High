import anthropicMonoUrl from '@/assets/fonts/anthropic/AnthropicMono-Roman-Web.woff2?url'
import anthropicChatSansUrl from '@/assets/fonts/anthropic/AnthropicSans-Roman-Android.ttf?url'
import anthropicSansItalicUrl from '@/assets/fonts/anthropic/AnthropicSans-Italic-Android.ttf?url'
import anthropicSansUrl from '@/assets/fonts/anthropic/AnthropicSans-Roman-Web.woff2?url'
import anthropicSerifItalicUrl from '@/assets/fonts/anthropic/AnthropicSerif-Italic-Android.ttf?url'
import anthropicSerifAndroidUrl from '@/assets/fonts/anthropic/AnthropicSerif-Roman-Android.ttf?url'
import anthropicSerifUrl from '@/assets/fonts/anthropic/AnthropicSerif-Roman-Web.woff2?url'
import jetBrainsMonoUrl from '@/assets/fonts/anthropic/JetBrainsMono-Variable.ttf?url'
import latinModernMathUrl from '@/assets/fonts/anthropic/latinmodern-math.otf?url'
import { getTypographyWeights, typographyCssVariables, type TypographyWeights } from './typography'

export type FontRole = 'ui' | 'content' | 'mono'

export interface FontAsset {
  id: string
  name: string
  family: string
  source: string
  format: 'woff2' | 'woff' | 'ttf' | 'otf'
  /** Optional source metadata; the active typography profile controls rendered weights. */
  textWeight?: number
}

export interface FontStylePack {
  id: string
  name: string
  roles: Partial<Record<FontRole, string>>
}

export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  ui: '界面字体',
  content: '正文与标题',
  mono: '等宽字体',
}

const FALLBACK_FAMILIES: Record<FontRole, string> = {
  ui: '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI", sans-serif',
  content: '"Songti SC", STSong, "Noto Serif SC", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, "Times New Roman", serif',
  mono: '"Cascadia Code", Consolas, "SF Mono", monospace',
}

interface FontFace extends Pick<FontAsset, 'family' | 'source' | 'format'> {
  style?: 'italic'
  weight?: string
  fallback?: boolean
}

const CHAT_SANS_FACE: FontFace = { family: 'Anthropic Chat Sans', source: anthropicChatSansUrl, format: 'ttf', weight: '300 800' }
const MATH_FACE: FontFace = { family: 'Latin Modern Math', source: latinModernMathUrl, format: 'otf', weight: '400' }
const ANTHROPIC_FACES: Partial<Record<string, FontFace[]>> = {
  'anthropic-sans': [
    { family: 'Anthropic Sans', source: anthropicSansItalicUrl, format: 'ttf', style: 'italic', weight: '300 800' },
    { ...CHAT_SANS_FACE, fallback: true },
    { ...CHAT_SANS_FACE, source: anthropicSansItalicUrl, style: 'italic' },
  ],
  'anthropic-serif': [
    { family: 'Anthropic Serif', source: anthropicSerifItalicUrl, format: 'ttf', style: 'italic', weight: '300 800' },
    { family: 'Anthropic Serif Android', source: anthropicSerifAndroidUrl, format: 'ttf', weight: '300 800', fallback: true },
  ],
  'anthropic-mono': [
    { family: 'JetBrains Mono', source: jetBrainsMonoUrl, format: 'ttf', weight: '100 800', fallback: true },
  ],
}

// The Anthropic web cuts are variable fonts (wght 300-800) drawn for 14-16px;
// at this UI's 11-13px sizes the normalized profile keeps regular text at 500.
export const BUILTIN_FONT_ASSETS: FontAsset[] = [
  { id: 'anthropic-sans', name: 'Anthropic Sans', family: 'Anthropic Sans', source: anthropicSansUrl, format: 'woff2', textWeight: 500 },
  { id: 'anthropic-serif', name: 'Anthropic Serif', family: 'Anthropic Serif', source: anthropicSerifUrl, format: 'woff2', textWeight: 500 },
  { id: 'anthropic-mono', name: 'Anthropic Mono', family: 'Anthropic Mono', source: anthropicMonoUrl, format: 'woff2', textWeight: 500 },
]

export const BUILTIN_FONT_STYLES: FontStylePack[] = [
  {
    id: 'anthropic',
    name: 'Anthropic 字体风格',
    roles: { ui: 'anthropic-sans', content: 'anthropic-serif', mono: 'anthropic-mono' },
  },
]

const FONT_FORMATS = new Set<FontAsset['format']>(['woff2', 'woff', 'ttf', 'otf'])
const FONT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,72}$/i

function isFontSource(value: unknown): value is string {
  return typeof value === 'string' && /^(data:|blob:|https?:\/\/|\/)/i.test(value)
}

function normalizeFontAsset(value: unknown): FontAsset | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<FontAsset>
  if (typeof item.id !== 'string' || !FONT_ID_PATTERN.test(item.id)) return null
  if (typeof item.name !== 'string' || !item.name.trim()) return null
  if (typeof item.family !== 'string' || !item.family.trim()) return null
  if (!isFontSource(item.source) || item.source.length > 16_000_000) return null
  if (!FONT_FORMATS.has(item.format as FontAsset['format'])) return null
  return {
    id: item.id.trim(),
    name: item.name.trim().slice(0, 120),
    family: item.family.trim().slice(0, 120),
    source: item.source,
    format: item.format as FontAsset['format'],
  }
}

export function registerCustomFonts(values: unknown): FontAsset[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  return values
    .map(normalizeFontAsset)
    .filter((font): font is FontAsset => Boolean(font))
    .filter((font) => {
      if (seen.has(font.id)) return false
      seen.add(font.id)
      return true
    })
}

export function registerCustomFontStyles(values: unknown, fonts: FontAsset[] = []): FontStylePack[] {
  if (!Array.isArray(values)) return []
  const fontIds = new Set([...BUILTIN_FONT_ASSETS, ...fonts].map((font) => font.id))
  const seen = new Set<string>()
  return values
    .filter((value): value is FontStylePack => Boolean(value && typeof value === 'object'))
    .map((value) => {
      const item = value as Partial<FontStylePack>
      if (typeof item.id !== 'string' || !FONT_ID_PATTERN.test(item.id)) return null
      if (typeof item.name !== 'string' || !item.name.trim() || BUILTIN_FONT_STYLES.some((style) => style.id === item.id)) return null
      const roles: Partial<Record<FontRole, string>> = {}
      for (const role of ['ui', 'content', 'mono'] as FontRole[]) {
        const id = item.roles?.[role]
        if (typeof id === 'string' && fontIds.has(id)) roles[role] = id
      }
      return { id: item.id.trim(), name: item.name.trim().slice(0, 80), roles }
    })
    .filter((style): style is FontStylePack => Boolean(style))
    .filter((style) => {
      if (seen.has(style.id)) return false
      seen.add(style.id)
      return true
    })
}

export function getFontStyleOptions(customStyles: FontStylePack[] = []): FontStylePack[] {
  return [...BUILTIN_FONT_STYLES, ...customStyles]
}

export function getFontStyle(styleId: string | null | undefined, customStyles: FontStylePack[] = []): FontStylePack {
  return getFontStyleOptions(customStyles).find((style) => style.id === styleId) ?? BUILTIN_FONT_STYLES[0]
}

function cssString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function fontFaceCss(font: FontFace): string {
  const format = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[font.format]
  return `@font-face{font-family:${cssString(font.family)};src:url(${JSON.stringify(font.source)}) format('${format}');font-style:${font.style ?? 'normal'};font-weight:${font.weight ?? '100 900'};font-display:swap;}`
}

function additionalFontFaces(font: FontAsset): FontFace[] {
  return BUILTIN_FONT_ASSETS.includes(font) ? ANTHROPIC_FACES[font.id] ?? [] : []
}

function fontFaces(fonts: FontAsset[]): FontFace[] {
  return [MATH_FACE, ...fonts.flatMap((font) => [font, ...additionalFontFaces(font)])]
}

const embeddedFontSources = new Map<string, Promise<string>>()

function embeddedFontSource(source: string): Promise<string> {
  if (source.startsWith('data:')) return Promise.resolve(source)
  const cached = embeddedFontSources.get(source)
  if (cached) return cached
  const pending = fetch(source).then(async (response) => {
    if (!response.ok) throw new Error(`字体资源加载失败：${response.status}`)
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('字体资源读取失败'))
      reader.readAsDataURL(blob)
    })
  }).catch((error) => {
    embeddedFontSources.delete(source)
    throw error
  })
  embeddedFontSources.set(source, pending)
  return pending
}

/** Sandboxed documents need their own font faces and cannot share the parent's font origin. */
export async function embeddedFontFaceCss(
  styleId: string | null | undefined,
  customFonts: FontAsset[] = [],
  customStyles: FontStylePack[] = [],
): Promise<string> {
  const style = getFontStyle(styleId, customStyles)
  const ids = new Set(Object.values(style.roles))
  const assets = [...BUILTIN_FONT_ASSETS, ...customFonts].filter((font) => ids.has(font.id))
  const faces = await Promise.all(fontFaces(assets).map(async (font) => fontFaceCss({
    ...font,
    source: await embeddedFontSource(font.source),
  })))
  return faces.join('')
}

function setFontFaceStyles(fonts: FontAsset[]) {
  if (typeof document === 'undefined') return
  const id = 'superhigh-font-face-styles'
  let style = document.getElementById(id) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = id
    document.head.appendChild(style)
  }
  const css = fontFaces(fonts).map(fontFaceCss).join('')
  if (style.textContent !== css) style.textContent = css
}

function familyForRole(role: FontRole, style: FontStylePack, assets: FontAsset[]): string {
  const asset = assets.find((font) => font.id === style.roles[role])
  if (!asset) return FALLBACK_FAMILIES[role]
  const families = [asset.family, ...additionalFontFaces(asset).filter((face) => face.fallback).map((face) => face.family)]
  return [...families.map(cssString), FALLBACK_FAMILIES[role]].join(', ')
}

function weightForRole(role: FontRole, weights: TypographyWeights): string {
  if (role === 'content') return String(weights.content)
  if (role === 'mono') return String(weights.mono)
  return String(weights.regular)
}

export function fontStyleCssVariables(
  styleId: string | null | undefined,
  customFonts: FontAsset[] = [],
  customStyles: FontStylePack[] = [],
): Record<string, string> {
  const assets = [...BUILTIN_FONT_ASSETS, ...customFonts]
  const style = getFontStyle(styleId, customStyles)
  const weights = getTypographyWeights()
  setFontFaceStyles(assets)
  const uiFamily = familyForRole('ui', style, assets)
  return {
    ...typographyCssVariables(),
    '--font-ui': uiFamily,
    '--font-content': familyForRole('content', style, assets),
    '--font-mono': familyForRole('mono', style, assets),
    '--font-chat-user': style.roles.ui === 'anthropic-sans' ? `${cssString(CHAT_SANS_FACE.family)}, ${FALLBACK_FAMILIES.ui}` : uiFamily,
    '--font-math': `${cssString(MATH_FACE.family)}, "Cambria Math", math`,
    '--font-ui-weight': weightForRole('ui', weights),
    '--font-content-weight': weightForRole('content', weights),
    '--font-mono-weight': weightForRole('mono', weights),
  }
}

export function applyFontStyle(
  styleId: string | null | undefined,
  customFonts: FontAsset[] = [],
  customStyles: FontStylePack[] = [],
): FontStylePack {
  const style = getFontStyle(styleId, customStyles)
  const root = document.documentElement
  Object.entries(fontStyleCssVariables(style.id, customFonts, customStyles)).forEach(([key, value]) => root.style.setProperty(key, value))
  root.dataset.fontStyleId = style.id
  return style
}

export function inferFontRole(fileName: string): FontRole {
  const name = fileName.toLocaleLowerCase()
  if (/(mono|monospace|code|console|terminal)/.test(name)) return 'mono'
  if (/(serif|roman|editorial|text)/.test(name)) return 'content'
  return 'ui'
}

export function inferFontFormat(fileName: string): FontAsset['format'] | null {
  const extension = fileName.split('.').pop()?.toLocaleLowerCase()
  return extension && FONT_FORMATS.has(extension as FontAsset['format']) ? extension as FontAsset['format'] : null
}

export async function readFontFile(file: File): Promise<FontAsset> {
  const format = inferFontFormat(file.name)
  if (!format) throw new Error('仅支持 WOFF2、WOFF、TTF 和 OTF 字体文件')
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取字体文件失败'))
    reader.readAsDataURL(file)
  })
  const id = `font-${crypto.randomUUID()}`
  const name = file.name.replace(/\.[^.]+$/, '').trim() || '导入字体'
  return { id, name, family: `SuperHigh ${id}`, source, format }
}
