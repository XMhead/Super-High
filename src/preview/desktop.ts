import { createApp } from 'vue'
import { createPinia } from 'pinia'
import DesktopPreview from './DesktopPreview.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { applyTheme, registerCustomThemes } from '@/lib/theme'
import { parseDesktopPreviewOptions } from './options'
import { installDesktopSimulator } from './desktopSimulator'
import '@/styles.css'

async function startPreview() {
  const options = parseDesktopPreviewOptions(window.location.search)
  const pinia = createPinia()
  const store = useWorkspaceStore(pinia)
  let inheritedThemeId: string | null = null
  try {
    const response = await fetch('/__superhigh_workspace/theme', { headers: { Accept: 'application/json' } })
    if (response.ok) {
      const settings = await response.json() as { themeId?: unknown; customThemes?: unknown }
      store.settings.customThemes = registerCustomThemes(Array.isArray(settings.customThemes) ? settings.customThemes : [])
      inheritedThemeId = typeof settings.themeId === 'string' ? settings.themeId : null
    }
  } catch { /* Use the shared built-in theme when no local desktop settings are available. */ }
  if (!options.theme && inheritedThemeId) store.settings.themeId = inheritedThemeId
  if (options.theme) store.settings.themeId = options.theme
  const simulator = await installDesktopSimulator(pinia, options)
  applyTheme(store.settings.themeId)
  const app = createApp(DesktopPreview, { options, simulator })
  app.use(pinia)
  app.mount('#app')
  if (import.meta.hot) {
    import.meta.hot.dispose(() => { app.unmount(); simulator.dispose() })
    // Pinia replaces action definitions during HMR; reinstall the simulator on store changes.
    import.meta.hot.on('vite:afterUpdate', payload => {
      if (payload.updates.some(update => /\/src\/stores\/(workspace|appUpdate)\.ts/.test(update.path))) window.location.reload()
    })
  }
}
startPreview().catch((error) => {
  const root = document.querySelector('#app')!
  const heading = document.createElement('h1')
  heading.textContent = '预览参数错误'
  const message = document.createElement('p')
  message.textContent = error instanceof Error ? error.message : String(error)
  const reset = document.createElement('a')
  reset.href = window.location.pathname
  reset.textContent = '打开默认模拟场景'
  root.replaceChildren(heading, message, reset)
})
