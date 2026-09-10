import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ActivityBar from './ActivityBar.vue'
import SettingsDrawer from './SettingsDrawer.vue'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/lib/tauri', () => ({
  backend: {
    listPlugins: vi.fn(),
    readPluginAsset: vi.fn(),
    execPluginShell: vi.fn(),
    saveSettings: vi.fn(async (settings) => settings),
    openPath: vi.fn(),
  },
  isTauri: () => false,
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(() => null),
  loadMonaco: vi.fn(),
}))

function mount(component: any, pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(component) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('plugin runtime UI', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
  })

  it('renders plugin commands in the activity bar and runs them', async () => {
    const store = useWorkspaceStore()
    store.pluginCommands = [{ id: 'horizon.hello', pluginId: 'horizon-tools', title: '记录工具', tooltip: '运行记录工具' }]
    store.runPluginCommand = vi.fn()
    const { app, root } = mount(ActivityBar, pinia)

    const button = root.querySelector('[data-testid="plugin-command-horizon.hello"]') as HTMLButtonElement
    expect(button?.title).toBe('运行记录工具')
    button.click()
    await nextTick()
    expect(store.runPluginCommand).toHaveBeenCalledWith('horizon.hello')
    app.unmount()
    root.remove()
  })

  it('renders plugin manager status and disabled action', async () => {
    const store = useWorkspaceStore()
    store.settingsOpen = true
    store.pluginEnvironment = {
      pluginRoot: 'C:/Users/Admin/AppData/Roaming/SuperHigh/plugins',
      disableFlagPath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/disable-plugins.flag',
      logPath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/logs/plugins.log',
      allDisabled: false,
      disabledReason: null,
    }
    store.pluginStatuses = [{
      id: 'horizon-tools',
      name: '示例项目目录名工具',
      version: '0.1.0',
      rootPath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/plugins/horizon-tools',
      main: 'main.js',
      mainPath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/plugins/horizon-tools/main.js',
      style: 'style.css',
      stylePath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/plugins/horizon-tools/style.css',
      source: 'global',
      permissions: ['all'],
      unsafe: true,
      status: 'loaded',
      matchReason: 'activation matched current workspace',
      disabledReason: null,
      error: null,
    }]
    store.refreshPlugins = vi.fn()
    store.disablePlugin = vi.fn()
    const { app, root } = mount(SettingsDrawer, pinia)

    const pluginNav = [...root.querySelectorAll('button')].find((item) => item.textContent?.includes('插件')) as HTMLButtonElement
    pluginNav.click()
    await nextTick()
    expect(store.refreshPlugins).toHaveBeenCalledTimes(1)

    const pluginCard = root.querySelector('.plugin-manager-card') as HTMLElement
    expect(pluginCard.textContent).toContain('示例项目目录名工具')
    expect(pluginCard.textContent).toContain('已加载')
    expect(pluginCard.textContent).not.toContain('loaded')
    const disable = [...root.querySelectorAll('button')].find((item) => item.textContent?.includes('停用')) as HTMLButtonElement
    disable.click()
    expect(store.disablePlugin).toHaveBeenCalledWith('horizon-tools')
    app.unmount()
    root.remove()
  })
})
