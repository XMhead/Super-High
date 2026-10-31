import type { Monaco } from './monaco'
import { getTheme, toMonacoThemeDefinition } from './theme'

export const EDITOR_THEME_ID = 'super-high-dynamic'
const appliedThemes = new WeakMap<object, { id: string; tokens: ReturnType<typeof getTheme> }>()

/** Monaco themes are global: switching files must not retokenize every live model. */
export function applyEditorTheme(monaco: Monaco, themeId: string) {
  const tokens = getTheme(themeId)
  const applied = appliedThemes.get(monaco)
  if (applied?.id === themeId && applied.tokens === tokens) return
  monaco.editor.defineTheme(EDITOR_THEME_ID, toMonacoThemeDefinition(themeId))
  monaco.editor.setTheme(EDITOR_THEME_ID)
  appliedThemes.set(monaco, { id: themeId, tokens })
}
