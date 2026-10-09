<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckSquare,
  Copy,
  ChevronDown,
  Database,
  KeyRound,
  Keyboard,
  SlidersHorizontal,
  Settings,
  Palette,
  Power,
  PowerOff,
  Puzzle,
  RadioTower,
  RefreshCw,
  Search,
  Smartphone,
  TerminalSquare,
  Trash2,
  Upload,
} from 'lucide-vue-next'

import { CLI_PROVIDER_OPTIONS } from '@/lib/cliProviders'
import { FONT_ROLE_LABELS, BUILTIN_FONT_ASSETS, getFontStyle, getFontStyleOptions, inferFontRole, readFontFile, type FontRole } from '@/lib/fontStyles'
import { applyTheme, getTheme, getThemeIds, registerCustomThemes } from '@/lib/theme'
import { backend, type ImageViewerRegistration } from '@/lib/tauri'
import AppUpdatePanel from '@/components/AppUpdatePanel.vue'
import type { SettingsSection } from '@/lib/settingsSections'
import { useWorkspaceStore } from '@/stores/workspace'
import type { AppSettings, PluginRuntimeStatus } from '@/types'

const ChannelProbePanel = defineAsyncComponent(() => import('./ChannelProbePanel.vue'))

const props = withDefaults(defineProps<{ preview?: boolean; simulated?: boolean; initialSection?: SettingsSection }>(), { initialSection: 'general' })
const emit = defineEmits<{ sectionChange: [section: SettingsSection] }>()
const store = useWorkspaceStore()
const activeSection = ref<SettingsSection>(props.initialSection)
const search = ref('')
const imageViewer = ref<ImageViewerRegistration | null>(null)
const imageViewerBusy = ref(false)
const imageViewerError = ref('')

async function refreshImageViewer() {
  if (props.preview || imageViewerBusy.value) return
  imageViewerBusy.value = true
  imageViewerError.value = ''
  try {
    imageViewer.value = await backend.getImageViewerRegistration()
  } catch (error) {
    imageViewerError.value = `无法读取图片查看器状态：${String(error)}`
  } finally {
    imageViewerBusy.value = false
  }
}

async function toggleImageViewer() {
  if (props.preview || imageViewerBusy.value || !imageViewer.value?.supported) return
  imageViewerBusy.value = true
  imageViewerError.value = ''
  try {
    imageViewer.value = await backend.setImageViewerRegistration(!imageViewer.value.enabled)
  } catch (error) {
    imageViewerError.value = `图片查看器设置失败：${String(error)}`
    try { imageViewer.value = await backend.getImageViewerRegistration() } catch { /* Keep the last confirmed state. */ }
  } finally {
    imageViewerBusy.value = false
  }
}

const themeOptions = computed(() => getThemeIds().map((id) => getTheme(id)))
const themePickerRoot = ref<HTMLElement | null>(null)
const themeMenuOpen = ref(false)
const themePreviewId = ref<string | null>(null)
const themePreviewBaseId = ref<string | null>(null)
const themeActiveIndex = ref(0)
const themeImportInput = ref<HTMLInputElement | null>(null)
const fontImportInput = ref<HTMLInputElement | null>(null)
const currentTheme = computed(() => getTheme(themePreviewId.value ?? store.settings.themeId))
const selectedTheme = computed(() => getTheme(themePreviewBaseId.value ?? store.settings.themeId))
const fontStyleOptions = computed(() => getFontStyleOptions(store.settings.customFontStyles ?? []))
const fontAssets = computed(() => [...BUILTIN_FONT_ASSETS, ...(store.settings.customFonts ?? [])])
const selectedFontStyle = computed(() => getFontStyle(store.settings.fontStyleId, store.settings.customFontStyles ?? []))
const selectedCustomFontStyle = computed(() => (store.settings.customFontStyles ?? []).find((style) => style.id === selectedFontStyle.value.id) ?? null)
const themePalette = computed(() => [
  {
    label: '背景',
    colors: [
      { label: '主背景', value: currentTheme.value.colors.bg.primary },
      { label: '面板', value: currentTheme.value.colors.bg.secondary },
      { label: '悬停', value: currentTheme.value.colors.bg.hover },
    ],
  },
  {
    label: '文字',
    colors: [
      { label: '主文字', value: currentTheme.value.colors.text.primary },
      { label: '次文字', value: currentTheme.value.colors.text.secondary },
      { label: '弱文字', value: currentTheme.value.colors.text.muted },
    ],
  },
  {
    label: '强调色',
    colors: [
      { label: '蓝', value: currentTheme.value.colors.accent.blue },
      { label: '绿', value: currentTheme.value.colors.accent.green },
      { label: '黄', value: currentTheme.value.colors.accent.yellow },
      { label: '红', value: currentTheme.value.colors.accent.red },
      { label: '紫', value: currentTheme.value.colors.accent.purple },
    ],
  },
  {
    label: '终端',
    colors: [
      { label: '黑', value: currentTheme.value.terminal.black },
      { label: '红', value: currentTheme.value.terminal.red },
      { label: '绿', value: currentTheme.value.terminal.green },
      { label: '黄', value: currentTheme.value.terminal.yellow },
      { label: '蓝', value: currentTheme.value.terminal.blue },
      { label: '洋红', value: currentTheme.value.terminal.magenta },
      { label: '青', value: currentTheme.value.terminal.cyan },
      { label: '白', value: currentTheme.value.terminal.white },
    ],
  },
])

function setThemePreview(themeId: string | null) {
  if (themeId && !themePreviewBaseId.value) themePreviewBaseId.value = store.settings.themeId
  themePreviewId.value = themeId
  if (themeId) {
    if (store.settings.themeId !== themeId) store.settings.themeId = themeId
    applyTheme(themeId)
    return
  }
  const restoreId = themePreviewBaseId.value ?? store.settings.themeId
  themePreviewBaseId.value = null
  if (store.settings.themeId !== restoreId) store.settings.themeId = restoreId
  applyTheme(restoreId)
}

function openThemePicker() {
  const selectedIndex = themeOptions.value.findIndex(theme => theme.id === store.settings.themeId)
  themeActiveIndex.value = selectedIndex >= 0 ? selectedIndex : 0
  themeMenuOpen.value = true
}

function closeThemePicker() {
  themeMenuOpen.value = false
  setThemePreview(null)
}

function toggleThemePicker() {
  if (themeMenuOpen.value) closeThemePicker()
  else openThemePicker()
}

function previewTheme(themeId: string) {
  const index = themeOptions.value.findIndex(theme => theme.id === themeId)
  if (index >= 0) themeActiveIndex.value = index
  setThemePreview(themeId)
}

function chooseTheme(themeId: string) {
  closeThemePicker()
  void store.setTheme(themeId)
}

function exportThemes() {
  const themes = store.settings.customThemes ?? []
  const payload = JSON.stringify(themes, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'superhigh-themes.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function exportThemeTemplate() {
  const theme = getTheme('dark')
  const template = { ...theme, id: 'my-theme', name: '我的主题' }
  const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'superhigh-theme-template.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function openThemeImport() {
  themeImportInput.value?.click()
}

async function importThemes(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    const incoming = Array.isArray(parsed) ? parsed : [parsed]
    const merged = registerCustomThemes([...(store.settings.customThemes ?? []), ...incoming])
    store.settings.customThemes = merged
    await store.saveSettings()
    store.showActivityMessage(`已导入 ${merged.length} 个自定义主题`)
  } catch (error) {
    store.showErrorMessage(`主题导入失败：${String(error)}`)
  }
}

function moveThemeHighlight(index: number) {
  const options = themeOptions.value
  themeActiveIndex.value = Math.max(0, Math.min(index, options.length - 1))
  previewTheme(options[themeActiveIndex.value].id)
}

function onThemePickerKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (themeMenuOpen.value) {
      event.preventDefault()
      closeThemePicker()
    }
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!themeMenuOpen.value) {
      openThemePicker()
      return
    }
    chooseTheme(themeOptions.value[themeActiveIndex.value].id)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (!themeMenuOpen.value) openThemePicker()
  const currentIndex = themeActiveIndex.value
  const nextIndex = event.key === 'ArrowDown'
    ? currentIndex + 1
    : event.key === 'ArrowUp'
      ? currentIndex - 1
      : event.key === 'Home'
        ? 0
        : themeOptions.value.length - 1
  moveThemeHighlight(nextIndex)
}

function onThemePickerFocusOut(event: FocusEvent) {
  const nextTarget = event.relatedTarget as Node | null
  if (!nextTarget || !themePickerRoot.value?.contains(nextTarget)) closeThemePicker()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (themeMenuOpen.value && !themePickerRoot.value?.contains(event.target as Node)) closeThemePicker()
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  setThemePreview(null)
})
const pluginSearch = ref('')
const pluginSource = ref('all')
const filteredPlugins = computed(() => store.pluginStatuses.filter(plugin =>
  (pluginSource.value === 'all' || plugin.source === pluginSource.value)
  && `${plugin.name} ${plugin.id}`.toLocaleLowerCase().includes(pluginSearch.value.trim().toLocaleLowerCase()),
))
const storageLocations = computed(() => [
  { label: '当前项目根目录', path: store.workspace?.rootPath, empty: '未打开项目' },
  { label: '应用数据目录', path: store.appStorageInfo?.dataDir, empty: '未读取' },
  { label: '数据库', path: store.appStorageInfo?.databasePath, empty: '未读取' },
  { label: 'Super High 根目录', path: store.appStorageInfo?.superHighRoot, empty: '未读取' },
])
const storageSize = computed(() => formatBytes(store.appStorageInfo?.databaseSizeBytes ?? 0))
const mobileHostUrls = computed(() => store.mobileHostStatus?.urls ?? [])
const mobilePrimaryUrl = computed(() => mobileHostUrls.value.find((url) => !url.includes('127.0.0.1')) ?? mobileHostUrls.value[0] ?? '')
const mobileHostToken = computed(() => store.mobileHostConfig?.token ?? store.settings.mobileHost.token)
const mobileWebUrl = computed(() => mobilePrimaryUrl.value ? `${mobilePrimaryUrl.value}/mobile/` : '')

async function previewMobile() {
  const port = store.mobileHostStatus?.port
  if (!port || !store.mobileHostStatus?.running) return
  await backend.openUrl(`http://127.0.0.1:${port}/mobile/`)
}
const settingSections: Array<{ id: SettingsSection; label: string; icon: Component }> = [
  { id: 'general', label: '常规', icon: Settings },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'config', label: '配置', icon: SlidersHorizontal },
  { id: 'shortcuts', label: '键盘快捷键', icon: Keyboard },
  { id: 'mobile', label: '手机端', icon: Smartphone },
  { id: 'cli', label: '终端', icon: TerminalSquare },
  { id: 'storage', label: '数据', icon: Database },
  { id: 'updates', label: '应用', icon: RefreshCw },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'channels', label: '渠道检测', icon: RadioTower },
]
const filteredSections = computed(() => settingSections.filter(section =>
  section.label.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()),
))

const sectionGroups = computed(() => [
  { label: '个人', sections: filteredSections.value.filter(section => !['plugins', 'channels'].includes(section.id)) },
  { label: '集成', sections: filteredSections.value.filter(section => ['plugins', 'channels'].includes(section.id)) },
].filter(group => group.sections.length))
const editorShortcuts = [
  { label: '保存当前文件', keys: 'Ctrl + S' },
  { label: '撤销', keys: 'Ctrl + Z' },
  { label: '重做', keys: 'Ctrl + Y' },
  { label: '剪切', keys: 'Ctrl + X' },
  { label: '复制', keys: 'Ctrl + C' },
  { label: '粘贴', keys: 'Ctrl + V' },
  { label: '全选', keys: 'Ctrl + A' },
  { label: '切换行注释', keys: 'Ctrl + /' },
  { label: '查找', keys: 'Ctrl + F' },
  { label: '替换', keys: 'Ctrl + H' },
  { label: '转到行', keys: 'Ctrl + G' },
  { label: '转到符号', keys: 'Ctrl + Shift + O' },
]

function replayTutorial() {
  window.dispatchEvent(new Event('superhigh:replay-onboarding'))
}


function pluginStatusLabel(status: PluginRuntimeStatus) {
  if (status === 'loaded') return '已加载'
  if (status === 'matched') return '已匹配'
  if (status === 'notMatched') return '未匹配'
  if (status === 'disabled') return '已停用'
  if (status === 'manifestError') return '配置错误'
  if (status === 'failed') return '加载失败'
  return status
}

function pluginSourceLabel(source: string) {
  return source === 'project' ? '项目插件' : '全局插件'
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

async function openStoragePath(path: string | undefined) {
  if (!path) return
  await store.openPath(path)
}

async function copyText(text: string) {
  if (!text) return
  await navigator.clipboard.writeText(text)
  store.showActivityMessage('已复制')
}

function onMobilePortInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  void store.updateMobileHostConfig({ port: Number.isFinite(value) ? value : 10320 })
}

function onMobileTokenInput(event: Event) {
  void store.updateMobileHostConfig({ token: (event.target as HTMLInputElement).value })
}

function toggleRenderColorCodes() {
  void store.setRenderColorCodes(!store.settings.renderColorCodes)
}

function openFontImport() {
  fontImportInput.value?.click()
}

function fontAssetName(fontId: string | undefined) {
  return fontAssets.value.find((font) => font.id === fontId)?.name ?? '系统字体回退'
}

async function importFonts(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  try {
    const imported = await Promise.all(files.map(readFontFile))
    const roles: Partial<Record<FontRole, string>> = {}
    imported.forEach((font, index) => {
      const role = inferFontRole(files[index].name)
      if (!roles[role]) roles[role] = font.id
    })
    const isAnthropic = files.every((file) => file.name.toLocaleLowerCase().includes('anthropic'))
    const style: NonNullable<AppSettings['customFontStyles']>[number] = {
      id: `font-style-${crypto.randomUUID()}`,
      name: isAnthropic ? 'Anthropic 字体风格' : `${imported[0].name} 字体风格`,
      roles,
    }
    await store.setCustomFonts([...(store.settings.customFonts ?? []), ...imported], [...(store.settings.customFontStyles ?? []), style])
    await store.setFontStyle(style.id)
    store.showActivityMessage(`已导入 ${imported.length} 个字体文件`)
  } catch (error) {
    store.showErrorMessage(`字体导入失败：${String(error)}`)
  }
}

async function setFontRole(role: FontRole, fontId: string) {
  const style = selectedCustomFontStyle.value
  if (!style) return
  const styles = (store.settings.customFontStyles ?? []).map((item) => item.id === style.id
    ? { ...item, roles: { ...item.roles, [role]: fontId || undefined } }
    : item)
  await store.setCustomFonts(store.settings.customFonts, styles)
}

async function removeSelectedFontStyle() {
  const style = selectedCustomFontStyle.value
  if (!style) return
  const styles = (store.settings.customFontStyles ?? []).filter((item) => item.id !== style.id)
  await store.setCustomFonts(store.settings.customFonts, styles)
  await store.setFontStyle('anthropic')
}

watch(activeSection, (section) => {
  emit('sectionChange', section)
  if (section === 'config') void refreshImageViewer()
  if (section === 'cli') void store.refreshCliEnvironments()
  if (section === 'storage') void store.refreshAppStorageInfo()
  if (section === 'plugins') void store.refreshPlugins()
  if (section === 'mobile') void store.refreshMobileHostStatus()
}, { immediate: true })
watch(() => props.initialSection, section => { activeSection.value = section })
watch(() => store.settings, () => {
  if (props.simulated && activeSection.value === 'config') void refreshImageViewer()
})
</script>

<template>
  <section v-if="store.settingsOpen" class="settings-workspace-panel" aria-label="设置">
    <div class="settings-page-body">
      <nav class="settings-nav" aria-label="设置分类">
        <button class="settings-nav-button settings-back" @click="store.setSettingsOpen(false)">
          <ArrowLeft :size="15" /><span>返回工作区</span>
        </button>
        <label class="settings-search">
          <Search :size="14" />
          <input v-model="search" type="search" aria-label="搜索设置分类" placeholder="搜索设置分类…" />
        </label>
        <template v-for="group in sectionGroups" :key="group.label">
        <div class="settings-nav-label">{{ group.label }}</div>
        <button
          v-for="section in group.sections"
          :key="section.id"
          class="settings-nav-button"
          :class="{ active: activeSection === section.id }"
          :aria-current="activeSection === section.id ? 'page' : undefined"
          @click="activeSection = section.id"
        >
          <component :is="section.icon" :size="15" />
          <span>{{ section.label }}</span>
        </button>
        </template>
        <p v-if="!filteredSections.length" class="settings-nav-empty">没有匹配的分类</p>
      </nav>

      <main class="settings-content">
        <fieldset class="settings-controls" :disabled="preview && !['appearance', 'plugins', 'config', 'shortcuts'].includes(activeSection)">
        <section v-if="activeSection === 'general'" class="settings-content-section">
          <div class="settings-section-heading"><div class="section-title">常规</div></div>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">新手教程</div><div class="settings-path">重新了解项目、对话、文件和终端的日常用法。</div></div>
              <button class="ghost-button small" @click="replayTutorial"><BookOpen :size="14" /><span>再次播放新手教程</span></button>
            </div>
          </div>
        </section>
        <section v-else-if="activeSection === 'config'" class="settings-content-section">
          <div class="settings-section-heading"><div><div class="section-title">配置</div></div></div>
          <h3 class="settings-group-title">图片查看器</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">系统图片查看器</div>
                <div class="settings-path">启用后可在图片的“打开方式”中选择 Super High，不更改默认应用。</div>
                <div v-if="preview" class="settings-path">请在桌面应用中启用。</div>
                <div v-else-if="imageViewerBusy" class="settings-path" role="status">正在更新状态…</div>
                <div v-else-if="imageViewer && !imageViewer.supported" class="settings-path">仅支持 Windows。</div>
                <div v-if="imageViewer?.defaultSelected" class="settings-path">当前默认应用为 Super High，可在 Windows 设置中更换。</div>
                <div v-if="imageViewerError" class="settings-path" role="alert">{{ imageViewerError }}</div>
              </div>
              <div class="settings-inline-actions">
                <button v-if="imageViewerError" class="ghost-button small" :disabled="imageViewerBusy" @click="refreshImageViewer">重试</button>
                <button class="toggle-button settings-switch" type="button" role="switch" aria-label="系统图片查看器"
                  :aria-checked="imageViewer?.enabled ?? false" :class="{ active: imageViewer?.enabled }"
                  :disabled="preview || imageViewerBusy || !imageViewer?.supported" @click="toggleImageViewer"><span /></button>
              </div>
            </div>
          </div>
          <h3 class="settings-group-title">文件保存</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><label for="settings-autosave" class="settings-subtitle">自动保存</label><div class="settings-path">选择编辑后自动保存文件的时机</div></div>
              <select id="settings-autosave" class="settings-input settings-theme-select" :value="store.settings.autoSave" @change="store.setAutoSave(($event.target as HTMLSelectElement).value as AppSettings['autoSave'])"><option value="off">关闭</option><option value="afterDelay">延迟后保存</option><option value="onFocusChange">失去焦点时保存</option></select>
            </div>
            <div v-if="store.settings.autoSave === 'afterDelay'" class="settings-option-row">
              <div class="settings-main"><label for="settings-autosave-delay" class="settings-subtitle">保存延迟</label><div class="settings-path">停止输入后等待的时间，单位为毫秒</div></div>
              <input id="settings-autosave-delay" class="settings-input settings-port" type="number" min="200" max="60000" step="100" :value="store.settings.autoSaveDelay" @change="store.setAutoSaveDelay(Number(($event.target as HTMLInputElement).value) || 1000)" />
            </div>
          </div>
        </section>
        <section v-else-if="activeSection === 'shortcuts'" class="settings-content-section">
          <div class="settings-section-heading"><div><div class="section-title">键盘快捷键</div></div></div>
          <h3 class="settings-group-title">SuperHigh 管家</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row"><div class="settings-main"><span class="settings-subtitle">显示 / 隐藏管家与宠物</span><span class="settings-path">应用窗口内有效</span></div><kbd class="settings-shortcut-keys">&#96;（反引号）</kbd></div>
            <div class="settings-option-row"><span class="settings-subtitle">展开 / 收起管家面板</span><kbd class="settings-shortcut-keys">右击宠物</kbd></div>
            <div class="settings-option-row">
              <div class="settings-main"><span class="settings-subtitle">` 唤起时默认展开面板</span><span class="settings-path">开启后每次用 ` 唤起管家都直接显示展开样式</span></div>
              <button class="toggle-button settings-switch" type="button" role="switch" aria-label="` 唤起时默认展开管家面板"
                :class="{ active: store.settings.petAutoExpand }" :aria-checked="store.settings.petAutoExpand"
                :disabled="preview" @click="store.setPetAutoExpand(!store.settings.petAutoExpand)"><span /></button>
            </div>
          </div>
          <h3 class="settings-group-title">编辑器</h3>
          <div class="settings-block settings-row-group">
            <div v-for="shortcut in editorShortcuts" :key="shortcut.keys" class="settings-option-row"><span class="settings-subtitle">{{ shortcut.label }}</span><kbd class="settings-shortcut-keys">{{ shortcut.keys }}</kbd></div>
          </div>
        </section>
        <section v-else-if="activeSection === 'mobile'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">手机端</div>
            </div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="store.mobileHostLoading" @click="store.refreshMobileHostStatus()">
                <RefreshCw :size="13" />
                <span>{{ store.mobileHostLoading ? '刷新中' : '刷新状态' }}</span>
              </button>
            </div>
          </div>

          <h3 class="settings-group-title">连接</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">手机连接服务</div><div class="settings-path">{{ preview ? '运行状态请在桌面应用查看' : store.mobileHostStatus?.running ? '运行中' : '未启动' }}</div></div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" :disabled="store.mobileHostLoading || store.mobileHostStatus?.running" @click="store.startMobileHost()"><Power :size="13" /><span>启动</span></button>
                <button class="ghost-button small" :disabled="store.mobileHostLoading || !store.mobileHostStatus?.running" @click="store.stopMobileHost()"><PowerOff :size="13" /><span>停止</span></button>
              </div>
            </div>
            <div class="settings-option-row">
              <div class="settings-main"><label class="settings-subtitle" for="mobile-port">监听端口</label><div class="settings-path">手机与电脑通过此端口连接</div></div>
              <input id="mobile-port" class="settings-input settings-port" type="number" min="1024" max="65535" :value="store.mobileHostConfig?.port ?? store.settings.mobileHost.port" @change="onMobilePortInput" />
            </div>
            <div class="settings-option-row">
              <div class="settings-main"><label class="settings-subtitle" for="mobile-token">连接令牌</label><div class="settings-path">在手机端输入此令牌</div></div>
              <div class="settings-inline-actions settings-token-control">
                <input id="mobile-token" class="settings-input" type="text" :value="mobileHostToken" @change="onMobileTokenInput" />
                <button class="ghost-button small" title="生成新令牌" aria-label="生成新令牌" @click="store.regenerateMobileHostToken()"><KeyRound :size="13" /></button>
                <button class="ghost-button small" title="复制令牌" aria-label="复制令牌" :disabled="!mobileHostToken" @click="copyText(mobileHostToken)"><Copy :size="13" /></button>
              </div>
            </div>
            <div v-for="url in mobileHostUrls" :key="url" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">{{ url === mobilePrimaryUrl ? '推荐地址' : '备用地址' }}</div><code class="settings-path">{{ url }}</code></div>
              <button class="ghost-button small" @click="copyText(url)">复制</button>
            </div>
            <div v-if="!mobileHostUrls.length" class="settings-option-row"><span class="settings-path">{{ preview ? '连接地址请在桌面应用查看。' : '启动服务后显示可连接地址。' }}</span></div>
          </div>
          <h3 class="settings-group-title">手机网页</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">预览手机界面</div><div class="settings-path">{{ mobileWebUrl || '启动服务后可打开手机网页' }}</div></div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" :disabled="!mobileWebUrl" @click="copyText(mobileWebUrl)">复制地址</button>
                <button class="ghost-button small" :disabled="!store.mobileHostStatus?.running" @click="previewMobile">打开</button>
              </div>
            </div>
          </div>
          <p class="settings-footnote">手机界面由电脑提供，更新后刷新网页即可。首次启动时，请允许 Windows 专用网络访问。</p>
        </section>

        <section v-else-if="activeSection === 'cli'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">终端</div>
            </div>
            <button class="ghost-button small" :disabled="store.cliEnvironmentsLoading" @click="store.refreshCliEnvironments()">
              <RefreshCw :size="13" />
              <span>{{ store.cliEnvironmentsLoading ? '检测中' : '刷新' }}</span>
            </button>
          </div>

          <div class="settings-block">
            <div v-for="provider in CLI_PROVIDER_OPTIONS" :key="provider.id" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">{{ provider.name }}</div></div>
              <button class="toggle-button settings-switch" type="button" role="switch"
                :class="{ active: store.isCliProviderVisible(provider.id) }"
                :aria-checked="store.isCliProviderVisible(provider.id)"
                :aria-label="`显示 ${provider.name} 启动入口`"
                :title="store.isCliProviderVisible(provider.id) ? '隐藏启动入口' : '显示启动入口'"
                @click="store.setCliProviderVisible(provider.id, !store.isCliProviderVisible(provider.id))"
              ><span /></button>
            </div>
          </div>
          <div class="settings-list">
            <article v-for="environment in store.cliEnvironments" :key="environment.providerKind" class="settings-row cli-env-row">
              <div class="settings-main">
                <div class="cli-env-title-line">
                  <div class="settings-name">{{ environment.name }}</div>
                  <span class="cli-env-status" :class="{ available: environment.available }">
                    <CheckSquare v-if="environment.available" :size="12" />
                    <AlertTriangle v-else :size="12" />
                    <span>{{ environment.available ? '可用' : '未找到' }}</span>
                  </span>
                </div>
                <div class="settings-path">{{ environment.launcher }}</div>
                <div v-if="environment.source" class="settings-path">{{ environment.source }}</div>
                <div v-if="environment.issue" class="cli-env-issue">{{ environment.issue }}</div>
              </div>
            </article>
            <div v-if="!store.cliEnvironments.length && !store.cliEnvironmentsLoading" class="empty-hint">未返回 CLI 检测结果。</div>
          </div>
        </section>


        <ChannelProbePanel v-else-if="activeSection === 'channels'" class="settings-content-section settings-channel-panel" :preview="preview" />
        <section v-else-if="activeSection === 'plugins'" class="settings-content-section">
          <div class="settings-section-heading">
            <div><div class="section-title">插件</div></div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="preview || !store.pluginEnvironment" @click="store.openPath(store.pluginEnvironment?.pluginRoot ?? '')">全局目录</button>
              <button class="ghost-button small" :disabled="preview || !store.pluginEnvironment?.projectPluginRoot" @click="store.openPath(store.pluginEnvironment?.projectPluginRoot ?? '')">项目目录</button>
              <button class="ghost-button small" :disabled="preview || store.pluginsLoading" @click="store.refreshPlugins()"><RefreshCw :size="13" /><span>{{ store.pluginsLoading ? '刷新中' : '刷新' }}</span></button>
            </div>
          </div>
          <div class="settings-plugin-toolbar">
            <div class="settings-plugin-filters" aria-label="插件来源">
              <button v-for="source in [{id: 'all', label: '全部'}, {id: 'global', label: '全局'}, {id: 'project', label: '项目'}]" :key="source.id" class="ghost-button small" :class="{ selected: pluginSource === source.id }" :aria-pressed="pluginSource === source.id" @click="pluginSource = source.id">{{ source.label }} <span>{{ store.pluginStatuses.filter(plugin => source.id === 'all' || plugin.source === source.id).length }}</span></button>
            </div>
            <label class="settings-search settings-plugin-search"><Search :size="14" /><input v-model="pluginSearch" aria-label="搜索插件" placeholder="搜索插件…" type="search" /></label>
          </div>
          <p v-if="store.pluginEnvironment?.allDisabled" class="settings-footnote">所有插件已禁用：{{ store.pluginEnvironment.disabledReason }}</p>
          <div class="settings-plugin-list">
            <article v-for="plugin in filteredPlugins" :key="`${plugin.source}:${plugin.id}`" class="settings-plugin-item">
              <div class="settings-plugin-summary">
                <span class="settings-plugin-icon"><Puzzle :size="22" /></span>
                <div class="settings-main"><div class="settings-name">{{ plugin.name }}</div><div class="settings-path">{{ pluginSourceLabel(plugin.source) }} · {{ plugin.version }} · {{ pluginStatusLabel(plugin.status) }}</div></div>
                <button class="toggle-button settings-switch" type="button" role="switch" :aria-label="`启用 ${plugin.name}`" :aria-checked="!store.settings.disabledPluginIds.includes(plugin.id) && plugin.status !== 'disabled'" :class="{ active: !store.settings.disabledPluginIds.includes(plugin.id) && plugin.status !== 'disabled' }" :disabled="preview" @click="store.settings.disabledPluginIds.includes(plugin.id) || plugin.status === 'disabled' ? store.enablePlugin(plugin.id) : store.disablePlugin(plugin.id)"><span /></button>
              </div>
              <p v-if="plugin.error || plugin.disabledReason" class="settings-plugin-issue">{{ plugin.error || plugin.disabledReason }}</p>
              <details class="settings-plugin-details">
                <summary>详情</summary>
                <div class="settings-path">{{ plugin.id }} · {{ plugin.rootPath }}</div>
                <div v-if="plugin.mainPath" class="settings-path">入口：{{ plugin.mainPath }}</div>
                <div v-if="plugin.stylePath" class="settings-path">样式：{{ plugin.stylePath }}</div>
                <div v-if="plugin.matchReason" class="settings-path">{{ plugin.matchReason }}</div>
                <div class="settings-inline-actions">
                  <button class="ghost-button small" :disabled="preview" @click="store.openPath(plugin.rootPath)">目录</button>
                  <button class="ghost-button small" :disabled="preview || plugin.status === 'disabled'" @click="store.reloadPlugin(plugin.id)">重载</button>
                </div>
              </details>
            </article>
            <p v-if="!filteredPlugins.length" class="settings-footnote">{{ preview ? '浏览器预览不读取本机插件，请在桌面应用查看已安装列表。' : store.pluginsLoading ? '正在读取插件…' : store.pluginStatuses.length ? '没有匹配的插件。' : '还没有发现全局或当前项目插件。' }}</p>
          </div>
          <details v-if="store.pluginEnvironment" class="settings-plugin-details">
            <summary>目录与诊断</summary>
            <div class="settings-path">全局目录：{{ store.pluginEnvironment.pluginRoot }}</div>
            <div class="settings-path">项目目录：{{ store.pluginEnvironment.projectPluginRoot || '未打开项目' }}</div>
            <div class="settings-path">禁用标记：{{ store.pluginEnvironment.disableFlagPath }}</div>
            <div class="settings-path">日志：{{ store.pluginEnvironment.logPath }}</div>
          </details>
        </section>

        <section v-else-if="activeSection === 'storage'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">数据</div>
            </div>
            <button class="ghost-button small" :disabled="store.appStorageInfoLoading" @click="store.refreshAppStorageInfo()">
              <RefreshCw :size="13" />
              <span>{{ store.appStorageInfoLoading ? '读取中' : '刷新' }}</span>
            </button>
          </div>

          <h3 class="settings-group-title">文件位置</h3>
          <div class="settings-block settings-row-group">
            <div v-for="location in storageLocations" :key="location.label" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">{{ location.label }}</div><div class="settings-path" :title="location.path">{{ location.path || location.empty }}</div></div>
              <button class="ghost-button small" :disabled="!location.path" @click="openStoragePath(location.path)">打开</button>
            </div>
          </div>
          <h3 class="settings-group-title">本机数据</h3>
          <div class="settings-block settings-row-group">
            <div class="settings-option-row"><span class="settings-subtitle">数据库大小</span><span class="settings-value">{{ store.appStorageInfo ? storageSize : '未读取' }}</span></div>
            <div class="settings-option-row"><span class="settings-subtitle">历史工作区</span><span class="settings-value">{{ preview ? '未读取' : store.recentProjects.length }}</span></div>
          </div>
        </section>

        <AppUpdatePanel v-else-if="activeSection === 'updates'" />
        <section v-else class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">外观</div>
            </div>
          </div>
          <h3 class="settings-group-title">主题</h3>
          <div class="settings-block settings-row-group">
            <input ref="themeImportInput" class="visually-hidden" type="file" accept="application/json,.json" @change="importThemes" />
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">自定义主题</div><div class="settings-path">导入主题 JSON；主题会同步应用到界面、编辑器和终端。</div></div>
              <div class="settings-inline-actions">
                <button class="ghost-button small" type="button" @click="openThemeImport"><Palette :size="13" /><span>导入</span></button>
                <button class="ghost-button small" type="button" :disabled="!(store.settings.customThemes?.length)" @click="exportThemes"><Copy :size="13" /><span>导出</span></button>
                <button class="ghost-button small" type="button" @click="exportThemeTemplate"><Copy :size="13" /><span>模板</span></button>
              </div>
            </div>
            <div class="settings-option-row">
              <div class="settings-main"><label class="settings-subtitle" for="settings-theme">界面主题</label><div class="settings-path">统一应用到界面、编辑器和终端</div></div>
              <div ref="themePickerRoot" class="settings-theme-picker" @focusout="onThemePickerFocusOut">
                <button
                  id="settings-theme"
                  class="settings-input settings-theme-trigger"
                  type="button"
                  role="combobox"
                  aria-haspopup="listbox"
                  :aria-expanded="themeMenuOpen"
                  aria-controls="settings-theme-options"
                  @click="toggleThemePicker"
                  @keydown="onThemePickerKeydown"
                >
                  <span>{{ currentTheme.name }}</span>
                  <ChevronDown :size="14" aria-hidden="true" />
                </button>
                <div v-if="themeMenuOpen" id="settings-theme-options" class="settings-theme-menu" role="listbox" aria-label="界面主题选项" @mouseleave="setThemePreview(null)">
                  <div v-for="mode in ['dark', 'light']" :key="mode" class="settings-theme-group" role="group" :aria-label="mode === 'dark' ? '深色主题' : '浅色主题'">
                    <div class="settings-theme-group-label">{{ mode === 'dark' ? '深色主题' : '浅色主题' }}</div>
                    <button
                      v-for="theme in themeOptions.filter(theme => theme.type === mode)"
                      :id="`settings-theme-option-${theme.id}`"
                      :key="theme.id"
                      class="settings-theme-option"
                      :class="{ selected: theme.id === selectedTheme.id, active: theme.id === themePreviewId }"
                      type="button"
                      role="option"
                      :data-theme-id="theme.id"
                      :aria-selected="theme.id === selectedTheme.id"
                      @mouseenter="previewTheme(theme.id)"
                      @focus="previewTheme(theme.id)"
                      @click="chooseTheme(theme.id)"
                    >
                      <span class="settings-theme-swatch" :style="{ background: theme.colors.bg.primary, borderColor: theme.colors.border }" aria-hidden="true"><i :style="{ background: theme.colors.accent.blue }" /></span>
                      <span>{{ theme.name }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-option-row settings-theme-palette-row">
              <div class="settings-main"><div class="settings-subtitle">完整调色板</div><div class="settings-path">界面、编辑器和终端使用的全部主要颜色</div></div>
              <div class="settings-theme-palette">
                <div v-for="group in themePalette" :key="group.label" class="settings-theme-palette-group">
                  <span class="settings-theme-palette-label">{{ group.label }}</span>
                  <div class="settings-theme-palette-swatches">
                    <span v-for="color in group.colors" :key="`${group.label}-${color.label}`" class="settings-theme-palette-swatch" :title="`${color.label} ${color.value}`">
                      <i :style="{ background: color.value }" aria-hidden="true" />
                      <b>{{ color.label }}</b>
                    </span>
                  </div>
                </div>
                <span v-if="currentTheme.surfaceOpacity" class="settings-theme-opacity">表面透明度 {{ Math.round(currentTheme.surfaceOpacity * 100) }}%</span>
              </div>
            </div>
          </div>
          <h3 class="settings-group-title">字体</h3>
          <div class="settings-block settings-row-group">
            <input ref="fontImportInput" class="visually-hidden" type="file" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" multiple @change="importFonts" />
            <div class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">字体风格</div><div class="settings-path">一个风格包可以包含界面、正文和等宽字体；缺少的用途会使用系统字体。</div></div>
              <div class="settings-inline-actions">
                <select id="settings-font-style" class="settings-input settings-theme-select" :value="store.settings.fontStyleId" aria-label="字体风格" @change="store.setFontStyle(($event.target as HTMLSelectElement).value)">
                  <option v-for="style in fontStyleOptions" :key="style.id" :value="style.id">{{ style.name }}</option>
                </select>
                <button class="ghost-button small" type="button" @click="openFontImport"><Upload :size="13" /><span>导入字体</span></button>
              </div>
            </div>
            <div class="settings-option-row settings-font-role-row" v-for="role in (['ui', 'content', 'mono'] as FontRole[])" :key="role">
              <div class="settings-main"><div class="settings-subtitle">{{ FONT_ROLE_LABELS[role] }}</div><div class="settings-path">{{ fontAssetName(selectedFontStyle.roles[role]) }}</div></div>
              <select class="settings-input settings-theme-select" :disabled="!selectedCustomFontStyle" :aria-label="FONT_ROLE_LABELS[role]" :value="selectedFontStyle.roles[role] ?? ''" @change="setFontRole(role, ($event.target as HTMLSelectElement).value)">
                <option value="">系统字体回退</option>
                <option v-for="font in fontAssets" :key="font.id" :value="font.id">{{ font.name }}</option>
              </select>
            </div>
            <div v-if="selectedCustomFontStyle" class="settings-option-row">
              <div class="settings-main"><div class="settings-subtitle">导入风格管理</div><div class="settings-path">删除风格不会删除已导入的字体文件。</div></div>
              <button class="ghost-button small" type="button" @click="removeSelectedFontStyle"><Trash2 :size="13" /><span>删除风格</span></button>
            </div>
          </div>
          <h3 class="settings-group-title">偏好设置</h3>
          <div class="settings-block">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle">代码预览颜色渲染</div>
                <div class="settings-path">开启后，&amp;7、§7、§#d3d3d3 这类颜色符号会按实际颜色显示。</div>
              </div>
              <button
                class="toggle-button settings-switch"
                :class="{ active: store.settings.renderColorCodes }"
                type="button"
                role="switch"
                :aria-checked="store.settings.renderColorCodes"
                :title="store.settings.renderColorCodes ? '关闭颜色渲染' : '开启颜色渲染'"
                @click="toggleRenderColorCodes"
              >
                <span />
              </button>
            </div>
          </div>

        </section>
        </fieldset>
      </main>
    </div>
  </section>
</template>
