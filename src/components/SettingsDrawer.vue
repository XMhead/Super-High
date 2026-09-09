<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import {
  AlertTriangle,
  CheckSquare,
  Copy,
  Database,
  FolderOpen,
  HardDrive,
  KeyRound,
  Map,
  Palette,
  Plus,
  Power,
  PowerOff,
  Puzzle,
  RefreshCw,
  Smartphone,
  Terminal,
  TerminalSquare,
  Trash2,
  X,
  ArrowRight,
} from 'lucide-vue-next'

import { THEME_IDS, getTheme } from '@/lib/theme'
import { backend } from '@/lib/tauri'
import AppUpdatePanel from '@/components/AppUpdatePanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { PluginRuntimeStatus } from '@/types'

type SettingsSection = 'appearance' | 'mobile' | 'ssh' | 'cli' | 'plugins' | 'storage' | 'updates'

const store = useWorkspaceStore()
const activeSection = ref<SettingsSection>('mobile')

const sshFormOpen = ref(false)
const sshEditingId = ref<string | null>(null)
const sshFormName = ref('')
const sshFormHost = ref('')
const sshFormPort = ref(22)
const sshFormUsername = ref('')
const sshFormExtraArgs = ref('')

function openSshNewForm() {
  sshEditingId.value = null
  sshFormName.value = ''
  sshFormHost.value = ''
  sshFormPort.value = 22
  sshFormUsername.value = ''
  sshFormExtraArgs.value = ''
  sshFormOpen.value = true
}

function openSshEditForm(config: { id: string; name: string; host: string; port: number; username: string; extraArgs: string }) {
  sshEditingId.value = config.id
  sshFormName.value = config.name
  sshFormHost.value = config.host
  sshFormPort.value = config.port
  sshFormUsername.value = config.username
  sshFormExtraArgs.value = config.extraArgs
  sshFormOpen.value = true
}

function cancelSshForm() {
  sshFormOpen.value = false
  sshEditingId.value = null
}

async function submitSshForm() {
  const now = new Date().toISOString()
  await store.saveSshConnection({
    id: sshEditingId.value ?? crypto.randomUUID(),
    name: sshFormName.value.trim(),
    host: sshFormHost.value.trim(),
    port: sshFormPort.value,
    username: sshFormUsername.value.trim(),
    extraArgs: sshFormExtraArgs.value.trim(),
    createdAt: now,
    updatedAt: now,
  })
}

async function connectSshAndClose(connectionId: string) {
  await store.connectSsh(connectionId)
}

const themeOptions = computed(() => THEME_IDS.map((id) => getTheme(id)))
const availableCliCount = computed(() => store.cliEnvironments.filter((item) => item.available).length)
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
  { id: 'mobile', label: '手机端', icon: Smartphone },
  { id: 'ssh', label: 'SSH 连接', icon: Terminal },
  { id: 'cli', label: 'CLI 管理', icon: TerminalSquare },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'storage', label: '数据存储', icon: Database },
  { id: 'appearance', label: '外观主题', icon: Palette },
  { id: 'updates', label: '应用更新', icon: RefreshCw },
]


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

watch(activeSection, (section) => {
  if (section === 'cli') void store.refreshCliEnvironments()
  if (section === 'storage') void store.refreshAppStorageInfo()
  if (section === 'plugins') void store.refreshPlugins()
  if (section === 'ssh') void store.refreshSshConnections()
  if (section === 'mobile') void store.refreshMobileHostStatus()
})
</script>

<template>
  <section v-if="store.settingsOpen" class="settings-workspace-panel" aria-label="设置">
    <header class="settings-page-header">
      <div>
        <div class="panel-title">设置</div>
        <div class="dialog-subtitle">按分类管理工作区、CLI 和本机数据。</div>
      </div>
      <button class="ghost-button" @click="store.setSettingsOpen(false)">
        <X :size="14" />
        <span>返回工作区</span>
      </button>
    </header>

    <div class="settings-page-body">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="section in settingSections"
          :key="section.id"
          class="settings-nav-button"
          :class="{ active: activeSection === section.id }"
          @click="activeSection = section.id"
        >
          <component :is="section.icon" :size="15" />
          <span>{{ section.label }}</span>
        </button>
      </nav>

      <main class="settings-content">
        <section v-if="activeSection === 'mobile'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">手机端</div>
              <p>启动 Host 后，手机 App 或浏览器通过同一局域网加载电脑上的手机界面。</p>
            </div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="store.mobileHostLoading" @click="store.refreshMobileHostStatus()">
                <RefreshCw :size="13" />
                <span>{{ store.mobileHostLoading ? '刷新中' : '刷新状态' }}</span>
              </button>
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-subtitle">
              <span class="step-badge">1</span>
              Host 状态
            </div>
            <div class="mobile-host-status">
              <div class="mobile-host-state" :class="{ running: store.mobileHostStatus?.running }">
                <Smartphone :size="18" />
                <div>
                  <strong>{{ store.mobileHostStatus?.running ? '运行中' : '未启动' }}</strong>
                  <span>端口 {{ store.mobileHostStatus?.port ?? store.mobileHostConfig?.port ?? store.settings.mobileHost.port }}</span>
                </div>
              </div>
              <div class="remote-action-row">
                <button class="primary-button small" :disabled="store.mobileHostLoading" @click="store.startMobileHost()">
                  <Power :size="14" />
                  <span>启动 Host</span>
                </button>
                <button class="ghost-button small" :disabled="store.mobileHostLoading || !store.mobileHostStatus?.running" @click="store.stopMobileHost()">
                  <PowerOff :size="14" />
                  <span>停止 Host</span>
                </button>
              </div>
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-subtitle">
              <span class="step-badge">2</span>
              连接信息
            </div>
            <div class="remote-config-form">
              <div class="config-field">
                <label>监听端口</label>
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  :value="store.mobileHostConfig?.port ?? store.settings.mobileHost.port"
                  @input="onMobilePortInput"
                />
              </div>
              <div class="config-field">
                <label>连接令牌</label>
                <div class="mobile-token-row">
                  <input
                    type="text"
                    :value="mobileHostToken"
                    @input="onMobileTokenInput"
                  />
                  <button class="ghost-button small" title="生成新令牌" @click="store.regenerateMobileHostToken()">
                    <KeyRound :size="13" />
                  </button>
                </div>
              </div>
            </div>

            <div class="mobile-url-list">
              <div v-if="!mobileHostUrls.length" class="empty-hint">启动 Host 后会显示手机 App 可连接的地址。</div>
              <article v-for="url in mobileHostUrls" :key="url" class="mobile-url-card">
                <div>
                  <span>{{ url === mobilePrimaryUrl ? '推荐地址' : '备用地址' }}</span>
                  <code>{{ url }}</code>
                </div>
                <button class="ghost-button small" @click="copyText(url)">
                  <Copy :size="13" />
                  <span>复制</span>
                </button>
              </article>
            </div>

            <div class="mobile-url-card token">
              <div>
                <span>手机 App 令牌</span>
                <code>{{ mobileHostToken }}</code>
              </div>
              <button class="ghost-button small" @click="copyText(mobileHostToken)">
                <Copy :size="13" />
                <span>复制</span>
              </button>
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-subtitle"><span class="step-badge">3</span>手机网页</div>
            <div v-if="store.mobileHostStatus?.running" class="mobile-url-card">
              <div><span>手机浏览器地址</span><code>{{ mobileWebUrl }}</code></div>
              <div class="remote-action-row">
                <button class="ghost-button small" @click="copyText(mobileWebUrl)"><Copy :size="13" /><span>复制地址</span></button>
                <button class="ghost-button small" @click="previewMobile"><Smartphone :size="13" /><span>预览手机界面</span></button>
              </div>
            </div>
            <div v-else class="empty-hint">启动 Host 后可预览手机界面。</div>
            <p class="settings-note">手机界面由电脑提供，更新后刷新页面即可；安卓原生能力变更仍需更新 App。</p>
          </div>

          <div class="settings-note">
            第一次启动时 Windows 可能询问是否允许专用网络访问；选择允许后，安卓手机才能连上这台电脑。
          </div>
        </section>

        <section v-else-if="activeSection === 'ssh'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">SSH 连接</div>
              <p>保存的 SSH 服务器，点击连接后在终端中打开交互式 SSH 会话。</p>
            </div>
            <button class="ghost-button small" :disabled="store.sshConnectionsLoading" @click="openSshNewForm">
              <Plus :size="14" />
              <span>新建连接</span>
            </button>
          </div>

          <div v-if="sshFormOpen" class="ssh-form-card">
            <div class="ssh-form-grid">
              <label>
                <span>连接名称</span>
                <input v-model="sshFormName" type="text" placeholder="例如：生产服务器" />
              </label>
              <label>
                <span>主机地址</span>
                <input v-model="sshFormHost" type="text" placeholder="hostname 或 IP 地址" />
              </label>
              <label>
                <span>端口</span>
                <input v-model.number="sshFormPort" type="number" min="1" max="65535" />
              </label>
              <label>
                <span>用户名</span>
                <input v-model="sshFormUsername" type="text" placeholder="root" />
              </label>
            </div>
            <label style="margin-top: 8px">
              <span>额外参数（可选）</span>
              <input v-model="sshFormExtraArgs" type="text" placeholder="例如：-i ~/.ssh/my_key -v" />
            </label>
            <div class="ssh-form-actions">
              <button class="primary-button small" :disabled="!sshFormHost.trim() || !sshFormUsername.trim()" @click="submitSshForm">
                <span>{{ sshEditingId ? '保存' : '新建' }}</span>
              </button>
              <button class="ghost-button small" @click="cancelSshForm">取消</button>
            </div>
          </div>

          <div v-if="store.sshConnectionsLoading" class="empty-hint" style="padding: 24px">加载中...</div>
          <div v-else-if="!store.sshConnections.length" class="empty-hint" style="padding: 24px">暂无保存的 SSH 连接。</div>
          <div v-else class="ssh-connection-list">
            <div
              v-for="conn in store.sshConnections"
              :key="conn.id"
              class="ssh-connection-card"
            >
              <div class="ssh-conn-info">
                <strong>{{ conn.name }}</strong>
                <span>{{ conn.username }}@{{ conn.host }}:{{ conn.port }}</span>
                <small v-if="conn.extraArgs">{{ conn.extraArgs }}</small>
              </div>
              <div class="ssh-conn-actions">
                <button class="ghost-button small" title="连接" @click="connectSshAndClose(conn.id)">
                  <Power :size="13" />
                  <span>连接</span>
                </button>
                <button class="icon-mini" title="编辑" @click="openSshEditForm(conn)">
                  <ArrowRight :size="13" />
                </button>
                <button class="icon-mini danger" title="删除" @click="store.deleteSshConnection(conn.id)">
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="activeSection === 'cli'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">CLI 管理</div>
              <p>{{ availableCliCount }}/{{ store.cliEnvironments.length }} 可用。这里仅检测本机 CLI 启动器。</p>
            </div>
            <button class="ghost-button small" :disabled="store.cliEnvironmentsLoading" @click="store.refreshCliEnvironments()">
              <RefreshCw :size="13" />
              <span>{{ store.cliEnvironmentsLoading ? '检测中' : '刷新' }}</span>
            </button>
          </div>

          <div class="settings-block">
            <div class="settings-option-row">
              <div class="settings-main">
                <div class="settings-subtitle"><Map :size="14" /> 对话管理</div>
              </div>
              <button
                class="toggle-button settings-switch"
                :class="{ active: store.settings.dialogueMapMode }"
                type="button"
                role="switch"
                :aria-checked="store.settings.dialogueMapMode"
                :title="store.settings.dialogueMapMode ? '关闭对话管理' : '打开对话管理'"
                @click="store.setDialogueMapMode(!store.settings.dialogueMapMode)"
              >
                <span />
              </button>
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


        <section v-else-if="activeSection === 'plugins'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">插件</div>
              <p>打开项目时自动加载全局插件与当前项目 `.superhigh/plugins`。插件是本机全权限代码，安装即表示信任。</p>
            </div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="!store.pluginEnvironment" @click="store.openPath(store.pluginEnvironment?.pluginRoot ?? '')">
                <FolderOpen :size="13" />
                <span>全局目录</span>
              </button>
              <button
                class="ghost-button small"
                :disabled="!store.pluginEnvironment?.projectPluginRoot"
                @click="store.openPath(store.pluginEnvironment?.projectPluginRoot ?? '')"
              >
                <FolderOpen :size="13" />
                <span>项目目录</span>
              </button>
              <button class="ghost-button small" :disabled="store.pluginsLoading" @click="store.refreshPlugins()">
                <RefreshCw :size="13" />
                <span>{{ store.pluginsLoading ? '刷新中' : '刷新' }}</span>
              </button>
            </div>
          </div>

          <div class="settings-block">
            <div class="storage-info-row">
              <span>全局插件目录</span>
              <code>{{ store.pluginEnvironment?.pluginRoot ?? '未读取' }}</code>
            </div>
            <div class="storage-info-row">
              <span>当前项目插件目录</span>
              <code>{{ store.pluginEnvironment?.projectPluginRoot ?? '未打开项目' }}</code>
            </div>
            <div class="storage-info-row">
              <span>禁用标记</span>
              <code>{{ store.pluginEnvironment?.disableFlagPath ?? '未读取' }}</code>
            </div>
            <div class="storage-info-row">
              <span>日志</span>
              <code>{{ store.pluginEnvironment?.logPath ?? '未读取' }}</code>
            </div>
            <div v-if="store.pluginEnvironment?.allDisabled" class="settings-note warning">
              所有插件已禁用：{{ store.pluginEnvironment?.disabledReason }}
            </div>
          </div>

          <div class="plugin-manager-list">
            <article v-for="plugin in store.pluginStatuses" :key="`${plugin.source}:${plugin.id}`" class="plugin-manager-card">
              <div class="plugin-manager-top">
                <div>
                  <div class="settings-name">{{ plugin.name }}</div>
                  <div class="settings-path">{{ plugin.id }} · {{ plugin.version }} · {{ pluginSourceLabel(plugin.source) }}</div>
                </div>
                <span class="plugin-status-badge" :class="plugin.status">{{ pluginStatusLabel(plugin.status) }}</span>
              </div>
              <div class="settings-path">{{ plugin.rootPath }}</div>
              <div v-if="plugin.mainPath" class="settings-path">main: {{ plugin.mainPath }}</div>
              <div v-if="plugin.stylePath" class="settings-path">style: {{ plugin.stylePath }}</div>
              <div v-if="plugin.matchReason" class="settings-path">{{ plugin.matchReason }}</div>
              <div v-if="plugin.disabledReason" class="settings-path">{{ plugin.disabledReason }}</div>
              <pre v-if="plugin.error" class="plugin-error">{{ plugin.error }}</pre>
              <div class="settings-plugin-actions">
                <button class="ghost-button small" @click="store.openPath(plugin.rootPath)">
                  <FolderOpen :size="13" />
                  <span>目录</span>
                </button>
                <button class="ghost-button small" :disabled="plugin.status === 'disabled'" @click="store.reloadPlugin(plugin.id)">
                  <RefreshCw :size="13" />
                  <span>重载</span>
                </button>
                <button
                  v-if="store.settings.disabledPluginIds.includes(plugin.id) || plugin.status === 'disabled'"
                  class="ghost-button small"
                  @click="store.enablePlugin(plugin.id)"
                >
                  <Power :size="13" />
                  <span>启用</span>
                </button>
                <button v-else class="ghost-button small danger" @click="store.disablePlugin(plugin.id)">
                  <PowerOff :size="13" />
                  <span>停用</span>
                </button>
              </div>
            </article>
            <div v-if="!store.pluginStatuses.length" class="empty-hint">还没有发现全局或当前项目插件。</div>
          </div>
        </section>

        <section v-else-if="activeSection === 'storage'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">数据存储</div>
              <p>设置和历史工作区都存放在本机应用数据目录。</p>
            </div>
            <button class="ghost-button small" :disabled="store.appStorageInfoLoading" @click="store.refreshAppStorageInfo()">
              <RefreshCw :size="13" />
              <span>{{ store.appStorageInfoLoading ? '读取中' : '刷新' }}</span>
            </button>
          </div>

          <div class="storage-action-grid">
            <button class="storage-action" :disabled="!store.workspace" @click="openStoragePath(store.workspace?.rootPath)">
              <FolderOpen :size="18" />
              <span>当前项目根目录</span>
              <code>{{ store.workspace?.rootPath ?? '未打开项目' }}</code>
            </button>
            <button class="storage-action" :disabled="!store.appStorageInfo" @click="openStoragePath(store.appStorageInfo?.dataDir)">
              <HardDrive :size="18" />
              <span>打开数据目录</span>
              <code>{{ store.appStorageInfo?.dataDir ?? '未读取' }}</code>
            </button>
            <button class="storage-action" :disabled="!store.appStorageInfo" @click="openStoragePath(store.appStorageInfo?.databasePath)">
              <Database :size="18" />
              <span>定位数据库</span>
              <code>{{ store.appStorageInfo?.databasePath ?? '未读取' }}</code>
            </button>
            <button class="storage-action" :disabled="!store.appStorageInfo" @click="openStoragePath(store.appStorageInfo?.superHighRoot)">
              <FolderOpen :size="18" />
              <span>Super High 根目录</span>
              <code>{{ store.appStorageInfo?.superHighRoot ?? '未读取' }}</code>
            </button>
          </div>

          <div class="settings-block">
            <div class="settings-subtitle">当前项目与本机数据</div>
            <div class="storage-info-row">
              <span>数据库大小</span>
              <strong>{{ storageSize }}</strong>
            </div>
            <div class="storage-info-row">
              <span>历史工作区</span>
              <strong>{{ store.recentProjects.length }}</strong>
            </div>
          </div>
        </section>

        <AppUpdatePanel v-else-if="activeSection === 'updates'" />
        <section v-else class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">外观主题</div>
              <p>主题会立即应用，并保存到本机设置。</p>
            </div>
          </div>
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
          <div class="theme-grid">
            <button
              v-for="theme in themeOptions"
              :key="theme.id"
              class="theme-card"
              :class="{ active: store.settings.themeId === theme.id }"
              @click="store.setTheme(theme.id)"
            >
              <div class="theme-card-top">
                <div>
                  <div class="settings-name">{{ theme.name }}</div>
                  <div class="settings-path">{{ theme.type === 'light' ? '浅色' : '深色' }}</div>
                </div>
                <span class="theme-card-id">{{ theme.id }}</span>
              </div>
              <div class="theme-swatches">
                <span :style="{ background: theme.colors.bg.primary }" />
                <span :style="{ background: theme.colors.bg.secondary }" />
                <span :style="{ background: theme.colors.accent.blue }" />
                <span :style="{ background: theme.colors.accent.green }" />
                <span :style="{ background: theme.colors.accent.red }" />
              </div>
            </button>
          </div>
        </section>
      </main>
    </div>
  </section>
</template>
