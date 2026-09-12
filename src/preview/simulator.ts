import { ref, type Ref } from 'vue'
import type { Pinia } from 'pinia'
import { backend } from '@/lib/tauri'
import { applyTheme } from '@/lib/theme'
import { useWorkspaceStore } from '@/stores/workspace'
import type { PluginDescriptor } from '@/types'

export const SETTINGS_SIMULATOR_KEY = 'superhigh.preview.settings.v1'
export interface SettingsSimulatorOptions { scenario: 'ready' | 'empty' | 'error'; persist: boolean }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// Restore only the settings exposed by this page; do not accept arbitrary store state.
function restoreSettings(saved: unknown, defaults: ReturnType<typeof useWorkspaceStore>['settings']) {
  if (!saved || typeof saved !== 'object') return defaults
  const result = clone(defaults)
  for (const key of ['themeId', 'autoSave', 'autoSaveDelay', 'renderColorCodes', 'yamlKeyValuePanelEnabled', 'htmlPreviewEnabled'] as const) {
    if (key in saved) {
      const value = Reflect.get(saved, key) as unknown
      if (typeof value === typeof result[key]) Reflect.set(result, key, value)
    }
  }
  if (!['off', 'afterDelay', 'onFocusChange'].includes(result.autoSave)) result.autoSave = defaults.autoSave
  if (!Number.isFinite(result.autoSaveDelay) || result.autoSaveDelay < 0) result.autoSaveDelay = defaults.autoSaveDelay
  for (const key of ['disabledPluginIds', 'hiddenCliProviderIds'] as const) {
    const value: unknown = Reflect.get(saved, key)
    if (Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')) result[key] = value
  }
  const mobile: unknown = Reflect.get(saved, 'mobileHost')
  if (mobile && typeof mobile === 'object' && 'port' in mobile && 'token' in mobile && typeof mobile.port === 'number' && Number.isInteger(mobile.port) && mobile.port >= 1024 && mobile.port <= 65535 && typeof mobile.token === 'string' && mobile.token.trim()) {
    result.mobileHost = { port: mobile.port, token: mobile.token }
  }
  return result
}

/** Browser-only adapter. Install once in the dedicated preview entry and dispose on unmount. */
export function installSettingsSimulator(pinia: Pinia, options: SettingsSimulatorOptions): {
  message: Ref<string>; reset: () => void; dispose: () => void
} {
  const workspace = useWorkspaceStore(pinia)
  const message = ref('模拟模式：所有操作仅在浏览器中生效。')
  const initialSettings = clone(workspace.settings)
  const restorers: Array<() => void> = []
  const pending = new Map<ReturnType<typeof setTimeout>, (active: boolean) => void>()
  let disposed = false
  let tokenSequence = 1
  let imageViewerEnabled = false
  function replace<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
    const original = target[key]
    target[key] = value
    restorers.push(() => { target[key] = original })
  }
  function receipt(text: string) { message.value = `模拟：${text}` }
  function fail(operation: string) {
    if (options.scenario !== 'error') return false
    receipt(`${operation}失败（预设错误场景，未执行真实操作）`)
    return true
  }
  function pause() {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { pending.delete(timer); resolve(!disposed) }, 250)
      pending.set(timer, resolve)
    })
  }
  function cancelPending() {
    for (const [timer, resolve] of pending) { clearTimeout(timer); resolve(false) }
    pending.clear()
  }
  function persist() {
    if (!options.persist) return
    try { sessionStorage.setItem(SETTINGS_SIMULATOR_KEY, JSON.stringify({ settings: workspace.settings, imageViewerEnabled })) }
    catch { receipt('浏览器会话存储不可用；更改仍在当前页面生效。') }
  }
  // Every backend function is denied first, including calls made directly by components.
  for (const key of Object.keys(backend) as Array<keyof typeof backend>) {
    replace(backend, key, async () => {
      const error = `模拟模式不支持后端调用：${key}`
      message.value = error
      throw new Error(error)
    })
  }
  replace(backend, 'openUrl', async (url) => { receipt(`打开链接回执：${url}（未打开）`) })
  replace(backend, 'getImageViewerRegistration', async () => ({ supported: true, enabled: imageViewerEnabled, legacyRegistered: false, defaultSelected: false }))
  replace(backend, 'setImageViewerRegistration', async (enabled) => {
    if (fail('设置图片查看器')) throw new Error('模拟注册失败，未更改系统设置')
    imageViewerEnabled = enabled
    persist()
    receipt(`系统图片查看器已模拟${enabled ? '启用' : '关闭'}，未修改 Windows 图片关联。`)
    return { supported: true, enabled, legacyRegistered: false, defaultSelected: false }
  })
  replace(backend, 'openPath', async (path) => { receipt(`打开路径回执：${path}（未打开）`) })
  replace(workspace, 'openPath', async (path) => { await backend.openPath(path) })
  replace(workspace, 'saveSettings', async () => { receipt(options.persist ? '设置已保存到当前浏览器会话。' : '设置已保留在当前预览页面。'); persist() })

  function channelRead<T>(operation: string, value: T): T {
    if (fail(operation)) throw new Error(`模拟：${operation}失败，未连接供应商或读取本机配置。`)
    return clone(value)
  }
  replace(backend, 'listCcProviders', async () => channelRead('读取渠道', options.scenario === 'empty' ? [] : [{
    app: 'codex', id: 'simulated-codex', name: '模拟 Codex 渠道', websiteUrl: 'https://preview.invalid',
    baseUrl: 'https://preview.invalid/v1', apiKey: 'SIMULATED-KEY', apiFormat: 'openai_responses',
    apiKeyAuth: 'bearer', model: 'simulated-model', models: [], category: '模拟', isCurrent: true,
  }]))
  replace(backend, 'listCcProfiles', async () => channelRead('读取渠道分组', {
    profiles: options.scenario === 'empty' ? [] : [{ id: 'simulated-group', name: '模拟分组', claudeProvider: null, codexProvider: 'simulated-codex' }],
    currentClaude: null, currentCodex: options.scenario === 'empty' ? null : 'simulated-group',
  }))
  async function channelOperation(operation: string) {
    if (!await pause()) throw new Error('模拟操作已取消。')
    channelRead(operation, null)
    receipt(`${operation}完成；仅使用模拟数据，未发出网络请求。`)
  }
  replace(backend, 'probeChannel', async (config) => {
    await channelOperation('渠道连通检测')
    return { ok: true, latencyMs: 128, endpoint: config.baseUrl, reply: '模拟回复：渠道连通正常。', error: '', status: 200 }
  })
  replace(backend, 'probeWebsiteLatency', async (config) => {
    await channelOperation('渠道延迟检测')
    return [{ url: config.websiteUrl || config.baseUrl, label: '模拟延迟', latencyMs: 42, status: 200, error: null }]
  })
  replace(backend, 'fetchChannelModels', async () => {
    await channelOperation('读取模型列表')
    return options.scenario === 'empty' ? [] : [{ id: 'simulated-model', ownedBy: '模拟供应商' }, { id: 'simulated-model-fast', ownedBy: '模拟供应商' }]
  })

  function mobile(running = workspace.mobileHostStatus?.running ?? false) {
    const config = workspace.mobileHostConfig ?? workspace.settings.mobileHost
    workspace.mobileHostStatus = { ...config, running, bind: '模拟 · preview.invalid', urls: running ? [`http://preview.invalid:${config.port}`] : [] }
    return workspace.mobileHostStatus
  }
  replace(workspace, 'ensureMobileHostConfig', async () => workspace.mobileHostConfig)
  replace(workspace, 'refreshMobileHostStatus', async () => fail('读取手机状态') ? null : mobile())
  replace(workspace, 'startMobileHost', async () => {
    if (fail('启动手机服务')) return null
    receipt('手机服务已模拟启动；未监听任何端口。')
    return mobile(true)
  })
  replace(workspace, 'stopMobileHost', async () => {
    if (fail('停止手机服务')) return null
    receipt('手机服务已模拟停止。')
    return mobile(false)
  })
  replace(workspace, 'updateMobileHostConfig', async (partial) => {
    if (fail('保存手机配置')) return
    const next = { ...workspace.settings.mobileHost, ...partial }
    if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535 || !next.token.trim()) {
      receipt('端口须为 1024–65535 的整数，令牌不能为空。'); return
    }
    next.token = next.token.trim()
    workspace.mobileHostConfig = next
    workspace.settings.mobileHost = { ...next }
    mobile()
    persist()
    receipt('手机端口与令牌已保存（模拟）。')
  })
  replace(workspace, 'regenerateMobileHostToken', async () => {
    while (`SIMULATED-TOKEN-${tokenSequence + 1}` === workspace.settings.mobileHost.token) tokenSequence++
    await workspace.updateMobileHostConfig({ token: `SIMULATED-TOKEN-${++tokenSequence}` })
  })

  function plugins() {
    workspace.pluginEnvironment = { pluginRoot: '/模拟/global/plugins', projectPluginRoot: '/模拟/project/plugins', disableFlagPath: '/模拟/plugins.disabled', logPath: '/模拟/plugins.log', allDisabled: false }
    workspace.pluginStatuses = options.scenario === 'empty' ? [] : (['global', 'project'] as const).map((source): PluginDescriptor => {
      const id = `simulated.${source}`
      const disabled = workspace.settings.disabledPluginIds.includes(id)
      return { id, source, name: `模拟${source === 'global' ? '全局' : '项目'}插件`, version: '1.0.0-simulated', rootPath: `/模拟/${source}/plugins/${id}`, main: 'simulated.js', mainPath: `/模拟/${source}/simulated.js`, permissions: [], unsafe: false, status: disabled ? 'disabled' : options.scenario === 'error' ? 'failed' : 'loaded', error: options.scenario === 'error' ? '模拟插件加载失败，可点击重载观察错误。' : null, disabledReason: disabled ? '已在浏览器模拟中禁用' : null }
    })
  }
  replace(workspace, 'refreshPlugins', async () => { plugins(); if (!fail('刷新插件')) receipt('模拟插件列表已刷新。') })
  // Existing enable/disable actions already use saveSettings + refreshPlugins, both overridden above.
  replace(workspace, 'reloadPlugin', async (id) => {
    if (!workspace.pluginStatuses.some(plugin => plugin.id === id) || workspace.settings.disabledPluginIds.includes(id)) return
    if (!fail('重载插件')) { plugins(); receipt(`插件 ${id} 已模拟重载。`) }
  })
  function cli() {
    workspace.cliEnvironments = options.scenario === 'empty' ? [] : [{ providerKind: 'codex', name: '模拟 Codex CLI', command: 'simulated-codex', launcher: '/模拟/bin/codex', available: options.scenario !== 'error', source: '浏览器内模拟数据；未检测本机', issue: options.scenario === 'error' ? '模拟：找不到启动器' : null, checkedLocations: [] }]
  }
  replace(workspace, 'refreshCliEnvironments', async () => { cli(); if (!fail('CLI 检测')) receipt('CLI 模拟检测完成。') })
  function storage() {
    workspace.appStorageInfo = options.scenario === 'empty' || options.scenario === 'error' ? null : { dataDir: '/模拟/data', databasePath: '/模拟/data/workspace.db', databaseSizeBytes: 1048576, superHighRoot: '/模拟/SuperHigh', globalLibraryRoot: '/模拟/library', globalPluginsDir: '/模拟/global/plugins', pluginLogPath: '/模拟/plugins.log', pluginDisableFlagPath: '/模拟/plugins.disabled' }
  }
  replace(workspace, 'refreshAppStorageInfo', async () => { storage(); if (!fail('读取数据目录')) receipt('数据目录模拟信息已刷新。') })

  function seed() {
    workspace.settings = clone(initialSettings)
    workspace.settings.mobileHost = { port: 10320, token: 'SIMULATED-TOKEN-1' }
    workspace.mobileHostConfig = { ...workspace.settings.mobileHost }
    workspace.mobileHostLoading = false; workspace.pluginsLoading = false; workspace.cliEnvironmentsLoading = false; workspace.appStorageInfoLoading = false
    tokenSequence = 1
    imageViewerEnabled = false
    mobile(options.scenario === 'ready'); plugins(); cli(); storage()
    applyTheme(workspace.settings.themeId)
  }
  seed()
  if (options.persist) {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(SETTINGS_SIMULATOR_KEY) ?? 'null')
      if (saved && typeof saved === 'object' && 'settings' in saved) {
        workspace.settings = restoreSettings(saved.settings, workspace.settings)
        workspace.mobileHostConfig = { ...workspace.settings.mobileHost }
        imageViewerEnabled = 'imageViewerEnabled' in saved && saved.imageViewerEnabled === true
        mobile(); plugins(); applyTheme(workspace.settings.themeId)
      }
    } catch { receipt('模拟会话数据不可用，已使用默认值。') }
  }
  return {
    message,
    reset() {
      if (disposed) return
      cancelPending()
      try { sessionStorage.removeItem(SETTINGS_SIMULATOR_KEY) } catch { /* Browser storage may be disabled. */ }
      seed(); receipt('当前模拟设置已重置。')
    },
    dispose() {
      if (disposed) return
      disposed = true; cancelPending()
      for (const restore of restorers.reverse()) restore()
    },
  }
}
