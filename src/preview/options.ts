import { SETTINGS_SECTION_IDS, type SettingsSection } from '@/lib/settingsSections'
import { THEME_IDS } from '@/lib/theme'

export interface PreviewOptions {
  section: SettingsSection
  theme?: string
  scenario: 'ready' | 'empty' | 'error'
  mode: 'simulate' | 'readonly'
  persist: boolean
}

export function parsePreviewOptions(search: string): PreviewOptions {
  const params = new URLSearchParams(search)
  const section = params.get('section') ?? 'general'
  const scenario = params.get('scenario') ?? 'ready'
  const mode = params.get('mode') ?? 'simulate'
  const theme = params.get('theme') || undefined
  if (!SETTINGS_SECTION_IDS.includes(section as SettingsSection)) throw new Error(`未知设置页面：${section}`)
  if (!['ready', 'empty', 'error'].includes(scenario)) throw new Error(`未知场景：${scenario}`)
  if (!['simulate', 'readonly'].includes(mode)) throw new Error(`未知预览模式：${mode}`)
  if (theme && !THEME_IDS.includes(theme)) throw new Error(`未知主题：${theme}`)
  if (params.has('persist') && !['0', '1'].includes(params.get('persist')!)) throw new Error('persist 只接受 0 或 1')
  return { section: section as SettingsSection, scenario: scenario as PreviewOptions['scenario'], mode: mode as PreviewOptions['mode'], theme, persist: params.get('persist') !== '0' }
}
