import { shallowRef } from 'vue'

export interface PluginPreviewTab {
  path: string
  content: string
  isDirty: boolean
}

export interface PluginPreviewInstance {
  update?(tab: PluginPreviewTab): void
  dispose?(): void
}

export interface PluginPreviewProvider {
  id: string
  title?: string
  extensions: string[]
  mount(container: HTMLElement, tab: PluginPreviewTab): PluginPreviewInstance | void
}

// 插件注册的文件预览：复用代码预览的「预览」开关，按扩展名接管编辑区。
const providers = shallowRef<PluginPreviewProvider[]>([])

export function registerPluginPreviewProvider(provider: PluginPreviewProvider) {
  if (!provider || typeof provider.id !== 'string' || !provider.id.trim() || typeof provider.mount !== 'function') {
    throw new Error('预览提供者需要 id 与 mount(container, tab)。')
  }
  const extensions = (Array.isArray(provider.extensions) ? provider.extensions : [])
    .filter((item): item is string => typeof item === 'string' && !!item.trim())
    .map((item) => `.${item.trim().replace(/^\./, '').toLowerCase()}`)
  if (!extensions.length) throw new Error('预览提供者至少需要一个扩展名。')
  const entry = { ...provider, extensions }
  providers.value = [...providers.value.filter((item) => item.id !== provider.id), entry]
  return () => {
    providers.value = providers.value.filter((item) => item !== entry)
  }
}

export function findPluginPreviewProvider(path: string) {
  const lower = path.toLowerCase()
  return providers.value.find((provider) => provider.extensions.some((extension) => lower.endsWith(extension))) ?? null
}
