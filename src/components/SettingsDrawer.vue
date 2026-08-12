<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import {
  AlertTriangle,
  CheckSquare,
  Copy,
  Database,
  EyeOff,
  FolderOpen,
  HardDrive,
  History,
  KeyRound,
  Palette,
  Plus,
  Power,
  PowerOff,
  Puzzle,
  RefreshCw,
  ServerCog,
  Smartphone,
  Terminal,
  TerminalSquare,
  Trash2,
  X,
  ArrowRight,
} from 'lucide-vue-next'

import { THEME_IDS, getTheme } from '@/lib/theme'
import { useWorkspaceStore } from '@/stores/workspace'
import type { PluginRuntimeStatus, RecentProject } from '@/types'

type SettingsSection = 'appearance' | 'history' | 'mobile' | 'remote' | 'ssh' | 'cli' | 'plugins' | 'storage'

const store = useWorkspaceStore()
const activeSection = ref<SettingsSection>('history')

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
const settingSections: Array<{ id: SettingsSection; label: string; icon: Component }> = [
  { id: 'history', label: '工作区历史', icon: History },
  { id: 'mobile', label: '手机端', icon: Smartphone },
  { id: 'remote', label: '远程端', icon: ServerCog },
  { id: 'ssh', label: 'SSH 连接', icon: Terminal },
  { id: 'cli', label: 'CLI 管理', icon: TerminalSquare },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'storage', label: '数据存储', icon: Database },
  { id: 'appearance', label: '外观主题', icon: Palette },
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

function onNicknameChange(root: string, event: Event) {
  const value = (event.target as HTMLInputElement).value
  void store.setProjectNickname(root, value)
}

function displayProjectName(project: RecentProject) {
  return store.recentProjectTitle(project)
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

async function removeRecent(project: RecentProject) {
  const confirmed = window.confirm(`从历史工作区移除：${displayProjectName(project)}？`)
  if (!confirmed) return
  await store.removeRecentProject(project.path)
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

const mapScriptText = computed(() => {
  const config = store.remoteConfig
  if (!config || !config.remoteHost) return 'net use S: \\\\<Tailscale IP>\\<共享名> /persistent:yes'
  const letter = (config.localDriveLetter || 'S').replace(/:$/, '')
  const user = config.username ? ` /user:${config.username}` : ''
  return `net use ${letter}: \\\\${config.remoteHost}\\${config.shareName || 'Projects'} /persistent:yes${user}`
})

function toggleRenderColorCodes() {
  void store.setRenderColorCodes(!store.settings.renderColorCodes)
}

watch(activeSection, (section) => {
  if (section === 'plugins') void store.refreshPlugins()
  if (section === 'ssh') void store.refreshSshConnections()
  if (section === 'mobile') void store.refreshMobileHostStatus()
  if (section === 'remote') { void store.checkTailscaleStatus(); void store.refreshRemoteDriveStatus() }
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
        <section v-if="activeSection === 'history'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">工作区历史</div>
              <p>打开过的项目会保留在这里，可改显示昵称，也可只删除历史记录。</p>
            </div>
            <button class="ghost-button small" @click="store.refreshRecentProjects()">
              <RefreshCw :size="13" />
              <span>刷新</span>
            </button>
          </div>

          <div class="settings-list">
            <article v-for="project in store.recentProjects" :key="project.path" class="settings-row history-row">
              <div class="settings-main">
                <input
                  class="app-input"
                  :value="store.settings.projectNicknames[project.path] ?? ''"
                  :placeholder="project.name"
                  @change="onNicknameChange(project.path, $event)"
                />
                <div class="settings-name">{{ displayProjectName(project) }}</div>
                <div class="settings-path">{{ project.path }}</div>
                <div class="settings-path">最后打开：{{ project.lastOpenedAt }}</div>
              </div>
              <div class="settings-actions">
                <button class="ghost-button small" @click="store.openProject(project.path)">
                  <FolderOpen :size="13" />
                  <span>打开</span>
                </button>
                <button class="ghost-button small" @click="store.toggleHiddenProject(project.path)">
                  <EyeOff :size="13" />
                  <span>{{ store.settings.hiddenProjectPaths.includes(project.path) ? '取消隐藏' : '欢迎页隐藏' }}</span>
                </button>
                <button class="ghost-button small danger" @click="removeRecent(project)">
                  <Trash2 :size="13" />
                  <span>删除历史</span>
                </button>
              </div>
            </article>
            <div v-if="!store.recentProjects.length" class="empty-hint">还没有历史工作区。</div>
          </div>
        </section>

        <section v-else-if="activeSection === 'mobile'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">手机端</div>
              <p>启动电脑上的 Super High Host，安卓 App 通过同一局域网连接这里。</p>
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

          <div class="settings-note">
            第一次启动时 Windows 可能询问是否允许专用网络访问；选择允许后，安卓手机才能连上这台电脑。
          </div>
        </section>

        <section v-else-if="activeSection === 'remote'" class="settings-content-section">
          <div class="settings-section-heading">
            <div>
              <div class="section-title">远程端</div>
              <p>通过 Tailscale + SMB 把远程服务器目录映射成本地盘符，AI CLI 仍读取本机 skills 与 AGENTS.md。</p>
            </div>
            <div class="settings-heading-actions">
              <button class="ghost-button small" :disabled="store.remoteLoading" @click="store.refreshRemoteDriveStatus()">
                <RefreshCw :size="13" />
                <span>{{ store.remoteLoading ? '检测中' : '刷新状态' }}</span>
              </button>
            </div>
          </div>

          <!-- Step 1: Tailscale -->
          <div class="settings-block">
            <div class="settings-subtitle">
              <span class="step-badge">1</span>
              安装 Tailscale
            </div>
            <p class="settings-hint">
              在<strong>远程服务器</strong>和<strong>本机</strong>都安装
              <a href="https://tailscale.com/download/windows" target="_blank" rel="noopener">Tailscale</a>，
              登录<strong>同一个账号</strong>。
            </p>
            <div class="remote-status-row">
              <span>Tailscale 状态</span>
              <span :class="store.tailscaleStatus?.available ? 'text-ok' : 'text-warn'">
                {{ store.tailscaleStatus?.available ? `✓ 已连接 (${store.tailscaleStatus?.ip ?? 'IP未知'})` : '未检测到' }}
              </span>
              <button class="ghost-button tiny" :disabled="store.remoteLoading" @click="store.checkTailscaleStatus()">
                <RefreshCw :size="11" />
                <span>检测</span>
              </button>
            </div>
          </div>

          <!-- Step 2: Configure & Map -->
          <div class="settings-block">
            <div class="settings-subtitle">
              <span class="step-badge">2</span>
              配置并映射远程共享
            </div>
            <p class="settings-hint">
              先在远程服务器上把项目文件夹设为共享（右键 → 属性 → 共享），填好下面信息后点击"映射盘符"。
            </p>
            <div class="remote-config-form">
              <div class="config-field">
                <label>远程 Tailscale IP 或主机名</label>
                <input
                  type="text"
                  :value="store.remoteConfig?.remoteHost ?? ''"
                  placeholder="100.x.x.x"
                  @input="store.updateRemoteConfig({ remoteHost: ($event.target as HTMLInputElement).value })"
                />
              </div>
              <div class="config-field">
                <label>远程共享名</label>
                <input
                  type="text"
                  :value="store.remoteConfig?.shareName ?? 'Projects'"
                  placeholder="Projects"
                  @input="store.updateRemoteConfig({ shareName: ($event.target as HTMLInputElement).value })"
                />
              </div>
              <div class="config-field">
                <label>映射到本地盘符</label>
                <input
                  type="text"
                  :value="store.remoteConfig?.localDriveLetter ?? 'S'"
                  placeholder="S"
                  maxlength="2"
                  style="width: 60px"
                  @input="store.updateRemoteConfig({ localDriveLetter: ($event.target as HTMLInputElement).value })"
                />
              </div>
              <div class="config-field">
                <label>远程子目录（可选，相对共享根）</label>
                <input
                  type="text"
                  :value="store.remoteConfig?.remoteRoot ?? ''"
                  placeholder="留空 = 共享根目录"
                  @input="store.updateRemoteConfig({ remoteRoot: ($event.target as HTMLInputElement).value })"
                />
              </div>
              <div class="config-field">
                <label>远程 Windows 用户名</label>
                <input
                  type="text"
                  :value="store.remoteConfig?.username ?? ''"
                  placeholder="admin"
                  @input="store.updateRemoteConfig({ username: ($event.target as HTMLInputElement).value })"
                />
              </div>
            </div>
            <div class="remote-action-row">
              <button class="primary-button small" :disabled="store.remoteLoading || !store.remoteConfig?.remoteHost" @click="store.mapRemoteDrive()">
                <HardDrive :size="14" />
                <span>映射盘符</span>
              </button>
              <button class="ghost-button small" :disabled="store.remoteLoading || !store.remoteDriveStatus?.driveMapped" @click="store.unmapRemoteDrive()">
                <X :size="14" />
                <span>断开映射</span>
              </button>
            </div>
            <div class="settings-note">
              映射时会弹出 Windows 凭据提示或命令行窗口要求输入远程管理员密码。密码不会保存在 Super High 中。
            </div>
          </div>

          <!-- Step 3: Status & Open -->
          <div class="settings-block">
            <div class="settings-subtitle">
              <span class="step-badge">3</span>
              打开远程工作区
            </div>
            <div class="remote-check-grid">
              <article
                v-for="check in store.remoteDriveStatus?.checks ?? []"
                :key="check.id"
                class="remote-check-card"
                :class="{ ok: check.ok, warn: !check.ok && check.severity !== 'error' }"
              >
                <div class="remote-check-title">
                  <CheckSquare v-if="check.ok" :size="13" />
                  <AlertTriangle v-else :size="13" />
                  <span>{{ check.label }}</span>
                </div>
                <code>{{ check.detail }}</code>
              </article>
              <div v-if="!store.remoteDriveStatus" class="empty-hint">点击"刷新状态"检测远程端连接。</div>
            </div>
            <div class="remote-action-row" style="margin-top: 12px">
              <button
                class="primary-button"
                :disabled="!store.remoteDriveStatus?.driveMapped"
                @click="store.openRemoteWorkspace()"
              >
                <FolderOpen :size="16" />
                <span>打开远程工作区</span>
              </button>
            </div>
            <div v-if="store.remoteDriveStatus?.workspaceRoot" class="storage-info-row" style="margin-top: 8px">
              <span>工作区路径</span>
              <code>{{ store.remoteDriveStatus?.workspaceRoot }}</code>
            </div>
          </div>

          <!-- Manual commands -->
          <div class="settings-block">
            <div class="settings-subtitle">手动命令（备用）</div>
            <div class="remote-command-list">
              <code>{{ mapScriptText }}</code>
              <code>net use /delete {{ store.remoteConfig?.localDriveLetter ?? 'S' }}: /y</code>
            </div>
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
