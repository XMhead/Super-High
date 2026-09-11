import { createApp } from 'vue'
import { createPinia } from 'pinia'
import SettingsPreview from './SettingsPreview.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { applyTheme } from '@/lib/theme'
import { parsePreviewOptions } from './options'
import { installSettingsSimulator } from './simulator'
import '@/styles.css'

function startPreview() {
  const options = parsePreviewOptions(window.location.search)
  const pinia = createPinia()
  const store = useWorkspaceStore(pinia)
  const simulator = options.mode === 'simulate' ? installSettingsSimulator(pinia, options) : undefined
  if (!simulator) store.saveSettings = async () => {}
  if (options.theme) store.settings.themeId = options.theme
  store.settingsOpen = true
  applyTheme(store.settings.themeId)
  const app = createApp(SettingsPreview, { options, simulator })
  app.use(pinia)
  app.mount('#app')
  if (import.meta.hot) {
    import.meta.hot.dispose(() => { app.unmount(); simulator?.dispose() })
    // Pinia replaces action definitions during HMR; reinstall the simulator on store changes.
    import.meta.hot.on('vite:afterUpdate', payload => {
      if (payload.updates.some(update => /\/src\/stores\/(workspace|appUpdate)\.ts/.test(update.path))) window.location.reload()
    })
  }

}
try { startPreview() }
catch (error) {
  const root = document.querySelector('#app')!
  const heading = document.createElement('h1')
  heading.textContent = '预览参数错误'
  const message = document.createElement('p')
  message.textContent = error instanceof Error ? error.message : String(error)
  const reset = document.createElement('a')
  reset.href = window.location.pathname
  reset.textContent = '打开默认模拟场景'
  root.replaceChildren(heading, message, reset)
}
