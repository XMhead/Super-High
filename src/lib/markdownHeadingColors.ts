// Markdown 六级标题使用红、黄、绿、青、蓝、紫六种不透明亮色；值统一为 #RRGGBBAA。
// 默认值须与 src-tauri/src/cli_appearance.rs 的 DEFAULT_HEADING_COLORS 保持一致。
export const MARKDOWN_HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
export type MarkdownHeadingLevel = typeof MARKDOWN_HEADING_LEVELS[number]
export type MarkdownHeadingColors = Record<MarkdownHeadingLevel, string>

export const DEFAULT_MARKDOWN_HEADING_COLORS: MarkdownHeadingColors = {
  h1: '#FF9B9BFF',
  h2: '#FFD580FF',
  h3: '#A7E89BFF',
  h4: '#8DE2E8FF',
  h5: '#A8BEFFFF',
  h6: '#D8B2FFFF',
}

export const MARKDOWN_HEADING_LABELS: Record<MarkdownHeadingLevel, string> = {
  h1: '一级标题', h2: '二级标题', h3: '三级标题', h4: '四级标题', h5: '五级标题', h6: '六级标题',
}

const hex2 = (value: number) => Math.round(value).toString(16).padStart(2, '0').toUpperCase()

/** 接受 #RGB、#RGBA、#RRGGBB、#RRGGBBAA、rgb()/rgba()（alpha 0~1 或百分比），返回 #RRGGBBAA；无法识别返回 null。 */
export function normalizeHeadingColor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    return `#${(full.length === 6 ? `${full}FF` : full).toUpperCase()}`
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(value)
  if (!rgb) return null
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some((c) => !Number.isFinite(c) || c > 255)) return null
  const rawAlpha = rgb[4] ?? '1'
  const alpha = rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha)
  if (!Number.isFinite(alpha) || alpha > 1) return null
  return `#${channels.map(hex2).join('')}${hex2(alpha * 255)}`
}

export function normalizeMarkdownHeadingColors(input: unknown): MarkdownHeadingColors {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  return Object.fromEntries(MARKDOWN_HEADING_LEVELS.map((level) => [
    level, normalizeHeadingColor(source[level]) ?? DEFAULT_MARKDOWN_HEADING_COLORS[level],
  ])) as MarkdownHeadingColors
}

/** 拆成颜色选择器所需的 #RRGGBB 与 0~100 的透明度百分比。 */
export function splitHeadingColor(color: string): { rgb: string, alphaPercent: number } {
  const normalized = normalizeHeadingColor(color) ?? '#000000FF'
  return { rgb: normalized.slice(0, 7), alphaPercent: Math.round(parseInt(normalized.slice(7), 16) / 255 * 100) }
}

export function joinHeadingColor(rgb: string, alphaPercent: number): string {
  const alpha = Math.min(100, Math.max(0, Number.isFinite(alphaPercent) ? alphaPercent : 100))
  return `${rgb.slice(0, 7).toUpperCase()}${hex2(alpha / 100 * 255)}`
}

export function applyMarkdownHeadingColors(colors: MarkdownHeadingColors, root: HTMLElement = document.documentElement) {
  for (const level of MARKDOWN_HEADING_LEVELS) root.style.setProperty(`--md-${level}-color`, colors[level])
}
