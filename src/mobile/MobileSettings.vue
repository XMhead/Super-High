<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, UserRound, Database, Languages, Sun, Type, RefreshCw, FileText, CircleHelp, LogOut, TerminalSquare } from 'lucide-vue-next'
import { THEMES } from '@/lib/theme'
import { CLI_PROVIDER_OPTIONS } from '@/lib/cliProviders'
import { MobileHostError, type MobileHostApi } from '@/lib/hostApi'
import type { MobileHostApiStatus } from '@/types'
import type { AppUpdateStatus } from '@/lib/tauri'
import { version as uiVersion } from '../../package.json'
import { useMobileApkUpdate } from '@/lib/mobileApkUpdate'
const { nativeAvailable, installedVersion, state: apkState, latestVersion: apkVersion, progress: apkProgress, message: apkMessage, downloadUrl: apkDownloadUrl, checkUpdate: checkApkUpdate, installUpdate: installApkUpdate } = useMobileApkUpdate()
const props = defineProps<{ api: MobileHostApi; connected: boolean; status: MobileHostApiStatus | null; loading: boolean; errorMessage: string; themeId?: string; hiddenCliProviderIds?: string[]; preferencesBusy?: boolean }>()
const baseUrl = defineModel<string>('baseUrl', { required: true })
const token = defineModel<string>('token', { required: true })
const emit = defineEmits<{ close: []; connect: []; disconnect: []; fontSize: [value: number]; updatePreferences: [value: { themeId?: string; hiddenCliProviderIds?: string[] }] }>()
const section = ref('')
const theme = computed(() => props.themeId || 'dark')
function selectTheme(event: Event) { emit('updatePreferences', { themeId: (event.target as HTMLSelectElement).value }) }
function toggleCli(id: string, event: Event) {
  const hidden = new Set(props.hiddenCliProviderIds ?? ['dsh'])
  if ((event.target as HTMLInputElement).checked) hidden.delete(id)
  else hidden.add(id)
  emit('updatePreferences', { hiddenCliProviderIds: [...hidden] })
}
const fontSize = ref(Number(localStorage.getItem('super-high-mobile-font-size')) || 14)
const language = ref(localStorage.getItem('super-high-mobile-language') || 'zh-CN')
const message = ref('')
const update = ref<AppUpdateStatus | null>(null)
const busy = ref(false)
const waitingForHost = ref(false)
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let updateGeneration = 0
const en = computed(() => language.value === 'en')
const t = (zh: string, english: string) => en.value ? english : zh
watch(fontSize, () => { localStorage.setItem('super-high-mobile-font-size', String(fontSize.value)); document.documentElement.style.setProperty('--mobile-font-size', `${fontSize.value}px`); emit('fontSize', fontSize.value) }, { immediate: true })
watch(language, () => { localStorage.setItem('super-high-mobile-language', language.value); document.documentElement.lang = language.value }, { immediate: true })
watch(() => props.api, () => { updateGeneration += 1; stopWaitingForHost(); update.value = null; message.value = ''; busy.value = false })
onBeforeUnmount(() => { disposed = true; clearTimeout(reconnectTimer) })
const rows = computed(() => [
  { group: t('账户', 'Account'), items: [{ id: 'account', label: t('账号管理', 'Connection'), icon: UserRound }, { id: 'data', label: t('数据管理', 'Data'), icon: Database }] },
  { group: t('应用', 'App'), items: [{ id: 'language', label: t('语言', 'Language'), icon: Languages }, { id: 'theme', label: t('外观', 'Appearance'), icon: Sun }, { id: 'cli', label: t('CLI 显示', 'CLI visibility'), icon: TerminalSquare }, { id: 'font', label: t('字体大小', 'Font size'), icon: Type }] },
  { group: t('关于', 'About'), items: [{ id: 'update', label: t('检查更新', 'Check for updates'), icon: RefreshCw }, { id: 'terms', label: t('服务协议', 'Terms'), icon: FileText }] },
  { group: '', items: [{ id: 'help', label: t('帮助与反馈', 'Help and feedback'), icon: CircleHelp }] },
])
const title = computed(() => rows.value.flatMap(group => group.items).find(item => item.id === section.value)?.label || t('设置', 'Settings'))
async function updateAction(action: 'check' | 'download' | 'install') {
  const generation = ++updateGeneration
  const client = props.api
  busy.value = true; message.value = ''
  try {
    if (action === 'check') {
      const current = await client.status()
      if (disposed || generation !== updateGeneration) return
      const reloadKey = `super-high-mobile-reloaded-${current.version}`
      if (current.version && current.version !== uiVersion && !sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1')
        window.location.reload()
        return
      }
    }
    if (action === 'install') {
      waitingForHost.value = true
      waitForUpdatedHost(Date.now(), update.value?.version ?? null)
    }
    const result = await (action === 'check' ? client.checkAppUpdate() : action === 'download' ? client.downloadAppUpdate() : client.installAppUpdate())
    if (disposed || generation !== updateGeneration) return
    update.value = result
    if (update.value.error) message.value = update.value.error
    if (action === 'install' && update.value.phase !== 'installing') stopWaitingForHost()
  } catch (error) {
    if (disposed || generation !== updateGeneration) return
    // Windows exits inside update.install, so a dropped response is expected.
    // An HTTP error is a definite refusal; never retry the installation itself.
    if (action !== 'install' || error instanceof MobileHostError) {
      stopWaitingForHost()
      message.value = error instanceof Error ? error.message : String(error)
    }
  }
  finally { if (generation === updateGeneration) busy.value = false }
}
function stopWaitingForHost() {
  clearTimeout(reconnectTimer)
  waitingForHost.value = false
}
function waitForUpdatedHost(started: number, expectedVersion: string | null) {
  message.value = t('正在等待电脑更新。重启后请在电脑端开启手机连接，恢复后将自动加载新版界面。', 'Waiting for the desktop update. Enable mobile access after the computer app restarts; the updated interface will then load automatically.')
  const client = props.api
  reconnectTimer = setTimeout(async () => {
    if (disposed || client !== props.api || !waitingForHost.value) return
    try {
      const next = await client.status()
      if (disposed || client !== props.api || !waitingForHost.value) return
      if (expectedVersion && next.version === expectedVersion) { window.location.reload(); return }
    } catch { /* The host is temporarily unavailable during restart. */ }
    if (Date.now() - started < 180000) waitForUpdatedHost(started, expectedVersion)
    else { stopWaitingForHost(); message.value = t('电脑连接尚未恢复，请检查电脑端安装状态并开启手机连接后重新连接。', 'The computer is not available yet. Check installation, enable mobile access, and reconnect.') }
  }, 3000)
}
function resetPreferences() {
  fontSize.value = 14; language.value = 'zh-CN'
  localStorage.removeItem('super-high-mobile-workspace')
  message.value = '显示偏好已恢复默认；电脑文件和终端会话未修改。'
}
function logout() { emit('disconnect'); section.value = ''; emit('close') }
</script>
<template>
  <section class="mobile-settings" aria-label="设置">
    <header class="mobile-topbar"><button class="mobile-icon-button" type="button" :aria-label="t('返回', 'Back')" @click="section ? section = '' : emit('close')"><ChevronLeft :size="20" /></button><strong class="mobile-settings-title">{{ title }}</strong></header>
    <div class="mobile-settings-content">
      <template v-if="!section">
        <div v-for="group in rows" :key="group.group" class="mobile-settings-group"><p v-if="group.group">{{ group.group }}</p><div class="mobile-settings-card"><button v-for="item in group.items" :key="item.id" class="mobile-settings-row" type="button" @click="section = item.id; message = ''"><component :is="item.icon" :size="20" /><span>{{ item.label }}</span><small v-if="item.id === 'update'">{{ props.status?.version || uiVersion }}</small><small v-if="item.id === 'language'">{{ language === 'en' ? 'English' : '简体中文' }}</small><ChevronRight :size="17" /></button></div></div>
        <button v-if="connected" class="mobile-settings-row mobile-settings-card" type="button" @click="logout"><LogOut :size="20" /><span>{{ t('退出登录', 'Disconnect') }}</span></button>
        <p class="mobile-settings-note">Super High · {{ uiVersion }}</p>
      </template>
      <form v-else-if="section === 'account'" class="mobile-form-grid" @submit.prevent="emit('connect')">
        <p>{{ connected ? t('已连接电脑', 'Connected') : t('使用电脑端手机连接中的地址和令牌连接。', 'Use the address and token from your desktop mobile connection settings.') }}</p>
        <label><span>{{ t('电脑地址', 'Computer address') }}</span><input v-model="baseUrl" type="url" inputmode="url" autocomplete="url" required /></label>
        <label><span>{{ t('令牌', 'Token') }}</span><input v-model="token" type="password" autocomplete="off" required /></label>
        <p v-if="errorMessage" class="mobile-error" role="alert">{{ errorMessage }}</p>
        <button class="mobile-primary-button" :disabled="loading" type="submit">{{ loading ? t('连接中', 'Connecting') : t('连接', 'Connect') }}</button>
        <button v-if="connected" class="mobile-text-button" type="button" @click="logout">{{ t('退出登录', 'Disconnect') }}</button>
      </form>
      <div v-else-if="section === 'data'" class="mobile-form-grid"><p>{{ t('此手机保存连接信息、工作区选择和显示偏好。文件、CLI 会话与历史记录保存在电脑。', 'This device stores connection details, workspace selection and display preferences. Files and CLI sessions remain on your computer.') }}</p><button class="mobile-text-button" type="button" @click="resetPreferences">{{ t('重置显示偏好', 'Reset display preferences') }}</button><button class="mobile-text-button" type="button" @click="logout">{{ t('清除已保存连接并退出', 'Forget connection and disconnect') }}</button></div>
      <label v-else-if="section === 'language'" class="mobile-settings-field">{{ t('设置语言', 'Settings language') }}<select v-model="language"><option value="zh-CN">简体中文</option><option value="en">English</option></select><small>{{ t('终端输出由对应 CLI 决定。', 'Terminal output is controlled by the CLI.') }}</small></label>
      <label v-else-if="section === 'theme'" class="mobile-settings-field">{{ t('外观', 'Appearance') }}<select :value="theme" :disabled="preferencesBusy" @change="selectTheme"><option v-for="entry in THEMES" :key="entry.id" :value="entry.id">{{ entry.name }}</option></select><small>{{ t('连接后与电脑使用相同主题；更改会同步到电脑。', 'Connected devices share the desktop theme. Changes also apply to the desktop.') }}</small></label>
      <div v-else-if="section === 'cli'" class="mobile-settings-card"><label v-for="entry in CLI_PROVIDER_OPTIONS" :key="entry.id" class="mobile-settings-row"><span>{{ entry.name }}</span><input type="checkbox" role="switch" :aria-label="entry.name" :checked="!(hiddenCliProviderIds ?? ['dsh']).includes(entry.id)" :disabled="!connected || preferencesBusy" @change="toggleCli(entry.id, $event)" /></label></div>
      <label v-else-if="section === 'font'" class="mobile-settings-field">{{ t('字体大小', 'Font size') }} · {{ fontSize }} px<input v-model.number="fontSize" type="range" min="12" max="22" step="1" /><p :style="{ fontSize: `${fontSize}px` }">Super High · {{ t('工作区终端', 'Workspace terminal') }}</p></label>
      <div v-else-if="section === 'update'" class="mobile-form-grid">
        <strong>{{ t('Android 手机应用', 'Android app') }}</strong>
        <p v-if="installedVersion">{{ t('已安装版本', 'Installed version') }} {{ installedVersion }}</p>
        <p>{{ nativeAvailable ? t('直接下载新版并打开系统安装界面，无需连接电脑。', 'Download the update and open the system installer. No desktop connection is needed.') : t('直接下载最新 APK，下载完成后打开安装包更新手机应用。', 'Download the latest APK, then open it to update the Android app.') }}</p>
        <button class="mobile-primary-button" type="button" :disabled="['checking', 'downloading'].includes(apkState)" @click="checkApkUpdate">{{ apkState === 'checking' ? t('正在检查', 'Checking') : t('检查手机应用更新', 'Check Android app updates') }}</button>
        <p v-if="apkState === 'current'">{{ t('手机应用已是最新版本。', 'The Android app is up to date.') }}</p>
        <p v-if="apkVersion">{{ t('最新手机版本', 'Latest Android version') }} {{ apkVersion }}</p>
        <button v-if="nativeAvailable && apkState === 'available'" class="mobile-text-button" type="button" @click="installApkUpdate">{{ t('下载并安装手机更新', 'Download and install Android update') }}</button>
        <a v-if="!nativeAvailable && apkDownloadUrl" class="mobile-text-button" :href="apkDownloadUrl" target="_blank" rel="noopener noreferrer">{{ t('下载手机安装包', 'Download Android APK') }}</a>
        <p v-if="apkState === 'downloading'" role="status">{{ t('正在下载安装包', 'Downloading APK') }}{{ apkProgress >= 0 ? ` · ${apkProgress}%` : '…' }}</p>
        <template v-if="apkState === 'permission'"><p>{{ t('请在系统设置中允许 Super High 安装应用，然后返回继续。', 'Allow Super High to install apps in system settings, then return to continue.') }}</p><button class="mobile-text-button" type="button" @click="installApkUpdate">{{ t('继续安装手机更新', 'Continue Android installation') }}</button></template>
        <p v-if="apkState === 'installing'">{{ t('请在系统安装界面确认安装；取消后可重新检查更新。', 'Confirm installation in the system installer. If cancelled, check for updates again.') }}</p>
        <p v-if="apkMessage" role="status">{{ apkMessage }}</p>
        <strong>{{ t('电脑程序与手机界面', 'Desktop app and mobile interface') }}</strong>
        <p>{{ t('手机界面', 'Mobile interface') }} {{ uiVersion }}<template v-if="status?.version"> · {{ t('电脑', 'Desktop') }} {{ status.version }}</template></p>
        <button class="mobile-primary-button" type="button" :disabled="busy || waitingForHost || !connected" @click="updateAction('check')">{{ busy ? t('处理中', 'Working') : t('检查版本更新（含界面）', 'Check app and interface updates') }}</button>
        <p v-if="!connected">{{ t('连接电脑后可更新电脑程序与手机界面。', 'Connect to your computer to update the desktop app and mobile interface.') }}</p>
        <p v-if="update?.phase === 'upToDate'">{{ t('电脑已是最新版本。', 'The desktop app is up to date.') }}</p>
        <p v-if="update?.version">{{ t('新版本', 'New version') }} {{ update.version }}</p>
        <pre v-if="update?.notes" class="mobile-update-notes">{{ update.notes }}</pre>
        <button v-if="update?.phase === 'available'" class="mobile-text-button" type="button" :disabled="busy || waitingForHost" @click="updateAction('download')">{{ t('下载更新', 'Download update') }}</button>
        <template v-if="update?.phase === 'ready'"><p>{{ t('安装会重启电脑端；仍有内部终端会话时不会安装。', 'Installation restarts the desktop app and is blocked while internal terminal sessions are active.') }}</p><button class="mobile-text-button" type="button" :disabled="busy || waitingForHost" @click="updateAction('install')">{{ t('安装并重启电脑端', 'Install and restart desktop') }}</button></template>
        <p v-if="update?.blockingSessions.length">{{ update.blockingSessions.map(session => session.title).join('、') }}</p>
      </div>
      <div v-else-if="section === 'terms'" class="mobile-form-grid"><p>{{ t('Super High 通过你配置的电脑连接提供文件和终端访问。发送到终端的内容由所选 CLI 处理；其服务条款以对应提供方为准。', 'Super High accesses files and terminals through your configured computer. The selected CLI processes terminal input under its provider’s terms.') }}</p><a class="mobile-text-button" href="https://github.com/XMhead/Super-High" target="_blank" rel="noopener noreferrer">{{ t('查看项目说明', 'Project information') }}</a></div>
      <div v-else-if="section === 'help'" class="mobile-form-grid"><p>{{ t('在电脑端开启手机连接，使用显示的地址和令牌连接；手机需能访问该电脑。', 'Enable mobile access on your desktop and use its address and token. Your phone must be able to reach the computer.') }}</p><a class="mobile-text-button" href="https://github.com/XMhead/Super-High#readme" target="_blank" rel="noopener noreferrer">{{ t('使用说明', 'Documentation') }}</a><a class="mobile-text-button" href="https://github.com/XMhead/Super-High/issues" target="_blank" rel="noopener noreferrer">{{ t('提交反馈', 'Report an issue') }}</a></div>
      <p v-if="errorMessage && section !== 'account'" class="mobile-error" role="alert">{{ errorMessage }}</p>
      <p v-if="message" class="mobile-error" role="status">{{ message }}</p>
    </div>
  </section>
</template>
