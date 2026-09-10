<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Capacitor } from '@capacitor/core'
import MobileSessions from './MobileSessions.vue'
import MobileSettings from './MobileSettings.vue'
import {
  AlertTriangle, Menu, MoreHorizontal,
  ChevronLeft,
  FileText,
  FolderOpen,
  ImageIcon,
  RefreshCw,
  Search,
  Server,
  X,
  Eye,
} from 'lucide-vue-next'

import { applyTheme, THEMES } from '@/lib/theme'
import { MobileHostApi, MobileHostError, normalizeHostBaseUrl } from '@/lib/hostApi'
import { fileNameFromPath, inferLanguage, isPreviewableImage } from '@/lib/path'
import { renderMarkdown as renderMd } from '@/lib/markdown'
import type {
  DirectoryListing,
  FileEntry,
  MobileHostApiStatus,
  ProjectFileMatch,
  ProjectSearchResult,
  RecentProject,
  TextSearchMatch,
} from '@/types'

const CONNECTION_STORAGE_KEY = 'super-high-mobile-connection'
const hostedPage = window.location.pathname.startsWith('/mobile/')
const nativeApp = Capacitor.isNativePlatform() || !!(window as Window & { SuperHighVoice?: unknown }).SuperHighVoice

type FileViewer = {
  path: string
  name: string
  type: 'text' | 'image'
  content: string
  language: string
  renderMarkdown?: boolean
}

const baseUrl = ref('')
const token = ref('')
const activeConnection = ref<{ baseUrl: string; token: string } | null>(null)
const connectionEpoch = ref(0)
let connectionAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let pendingConnection: { baseUrl: string; token: string } | null = null
const connectionLost = ref(false)
const connectionRejected = ref(false)
const status = ref<MobileHostApiStatus | null>(null)
const recentProjects = ref<RecentProject[]>([])
const activeProject = ref<RecentProject | null>(null)
const currentPath = ref('')
const listing = ref<DirectoryListing | null>(null)
const viewer = ref<FileViewer | null>(null)
const searchQuery = ref('')
const drawerOpen = ref(false)
const settingsOpen = ref(false)
localStorage.removeItem('super-high-mobile-theme')
const cachedTheme = localStorage.getItem('super-high-mobile-theme-cache') || 'dark'
const appearance = ref({ theme: THEMES[cachedTheme] ? cachedTheme : 'dark', fontSize: 14 })
const hiddenCliProviderIds = ref<string[]>(['dsh'])
const messageDraft = ref('')
const preferencesBusy = ref(false)
let preferencesTimer: ReturnType<typeof setTimeout> | undefined
let preferencesGeneration = 0
let preferencesRequest = 0
let preferencesDisposed = false
function acceptPreferences(value: { themeId?: string; hiddenCliProviderIds?: string[] }) {
  if (value.themeId && THEMES[value.themeId]) {
    appearance.value.theme = value.themeId
    localStorage.setItem('super-high-mobile-theme-cache', value.themeId)
    applyTheme(value.themeId)
  }
  hiddenCliProviderIds.value = value.hiddenCliProviderIds ?? ['dsh']
}
applyTheme(appearance.value.theme)
async function syncPreferences() {
  clearTimeout(preferencesTimer)
  const epoch = preferencesGeneration
  const request = ++preferencesRequest
  const client = api.value
  if (!connected.value || preferencesDisposed) return
  try {
    const next = await client.status()
    if (epoch === preferencesGeneration && request === preferencesRequest && !preferencesDisposed && !preferencesBusy.value) {
      status.value = next
      acceptPreferences(next)
      connectionLost.value = false
      connectionRejected.value = false
    }
  } catch (error) {
    if (epoch === preferencesGeneration && request === preferencesRequest && !preferencesDisposed) {
      connectionLost.value = true
      if (error instanceof MobileHostError && [401, 403].includes(error.status)) {
        connectionRejected.value = true
        errorMessage.value = '连接凭据已失效，请重新连接电脑。'
        return
      }
    }
  }
  if (epoch === preferencesGeneration && request === preferencesRequest && !preferencesDisposed) preferencesTimer = setTimeout(() => void syncPreferences(), 3000)
}
function resumePreferences() {
  if (document.visibilityState !== 'visible') return
  if (pendingConnection && !loading.value) void connect(pendingConnection)
  else void syncPreferences()
}
async function updatePreferences(value: { themeId?: string; hiddenCliProviderIds?: string[] }) {
  if (!connected.value) { acceptPreferences({ themeId: value.themeId, hiddenCliProviderIds: hiddenCliProviderIds.value }); return }
  const epoch = ++preferencesGeneration
  clearTimeout(preferencesTimer)
  preferencesBusy.value = true
  errorMessage.value = ''
  try {
    const next = await api.value.updatePreferences(value)
    if (epoch === preferencesGeneration && !preferencesDisposed) acceptPreferences(next)
  } catch (error) {
    if (epoch === preferencesGeneration) errorMessage.value = formatError(error)
  } finally {
    if (epoch === preferencesGeneration && !preferencesDisposed) { preferencesBusy.value = false; void syncPreferences() }
  }
}
watch(activeConnection, () => {
  preferencesGeneration += 1
  preferencesBusy.value = false
  clearTimeout(preferencesTimer)
  if (activeConnection.value) void syncPreferences()
})
const projectPickerOpen = ref(false)
const searchResults = ref<ProjectSearchResult | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const connected = computed(() => !!status.value)
const api = computed(() => new MobileHostApi(activeConnection.value ?? { baseUrl: '', token: '' }))
const currentTitle = computed(() => {
  if (viewer.value) return viewer.value.name
  if (activeProject.value) return activeProject.value.name
  return 'Super High'
})
const canGoUp = computed(() => {
  const project = activeProject.value
  const current = listing.value
  return !!project && !!current && !samePath(current.path, project.path)
})

onMounted(() => {
  // The fragment is a one-time handoff and must not remain in browser history.
  const handoff = new URLSearchParams(window.location.hash.slice(1))
  const disconnected = !hostedPage && handoff.get('disconnect') === '1'
  if (disconnected) {
    localStorage.removeItem(CONNECTION_STORAGE_KEY)
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  const handedToken = hostedPage ? handoff.get('token') : null
  if (handedToken !== null) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  const saved = localStorage.getItem(CONNECTION_STORAGE_KEY)
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as { baseUrl?: unknown; token?: unknown }
      if (typeof parsed.baseUrl === 'string') baseUrl.value = parsed.baseUrl
      if (typeof parsed.token === 'string') token.value = parsed.token
    } catch {
      localStorage.removeItem(CONNECTION_STORAGE_KEY)
    }
  }
  if (hostedPage) {
    baseUrl.value = window.location.origin
    if (handedToken !== null) token.value = handedToken
  }
  if (baseUrl.value.trim() && token.value.trim()) void connect()
})

async function connect(retry?: { baseUrl: string; token: string }) {
  clearTimeout(reconnectTimer)
  pendingConnection = null
  connectionRejected.value = false
  const normalized = normalizeHostBaseUrl(retry?.baseUrl ?? baseUrl.value)
  const candidateToken = (retry?.token ?? token.value).trim()
  if (!normalized || !candidateToken) {
    errorMessage.value = '需要填写 Host 地址和令牌'
    return
  }

  loading.value = true
  errorMessage.value = ''
  const attempt = ++connectionAttempt
  const candidate = { baseUrl: normalized, token: candidateToken }
  const candidateApi = new MobileHostApi(candidate)
  try {
    const nextStatus = await candidateApi.status()
    if (attempt !== connectionAttempt || preferencesDisposed) return
    if ((nativeApp && !hostedPage) || (hostedPage && new URL(normalized).origin !== window.location.origin)) {
      await candidateApi.checkMobilePage()
      if (attempt !== connectionAttempt || preferencesDisposed) return
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(candidate))
      const page = new URL('/mobile/', normalized)
      page.hash = new URLSearchParams({ token: candidate.token }).toString()
      window.location.assign(page.href)
      return
    }
    const projects = await candidateApi.listRecentProjects()
    if (attempt !== connectionAttempt || preferencesDisposed) return
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(candidate))
    activeConnection.value = candidate
    baseUrl.value = normalized
    connectionEpoch.value += 1
    status.value = nextStatus
    connectionLost.value = false
    acceptPreferences(nextStatus)
    recentProjects.value = projects
    activeProject.value = null
    listing.value = null
    viewer.value = null
    searchResults.value = null
    const activePath = (nextStatus as MobileHostApiStatus & { activeProjectPath?: string }).activeProjectPath
    const savedPath = localStorage.getItem('super-high-mobile-workspace')
    const selected = projects.find(p => activePath && samePath(p.path, activePath)) ?? projects.find(p => savedPath && samePath(p.path, savedPath)) ?? projects[0]
    if (selected) await selectProject(selected)
    settingsOpen.value = false
    drawerOpen.value = false
  } catch (error) {
    if (attempt === connectionAttempt && !preferencesDisposed) {
      errorMessage.value = formatError(error).split(candidate.token).join('[令牌已隐藏]')
      if (!activeConnection.value && error instanceof MobileHostError && [401, 403].includes(error.status)) {
        connectionRejected.value = true
        connectionLost.value = false
      }
      if (!activeConnection.value && !(error instanceof MobileHostError && [401, 403].includes(error.status))) {
        pendingConnection = candidate
        connectionLost.value = true
        reconnectTimer = setTimeout(() => void connect(candidate), 3000)
      }
    }
  } finally {
    if (attempt === connectionAttempt) loading.value = false
  }
}

async function refreshProjects() {
  if (!connected.value) return connect()
  loading.value = true
  errorMessage.value = ''
  try {
    recentProjects.value = await api.value.listRecentProjects()
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    loading.value = false
  }
}

async function selectProject(project: RecentProject) {
  activeProject.value = project
  localStorage.setItem('super-high-mobile-workspace', project.path)
  projectPickerOpen.value = false
  viewer.value = null
  searchResults.value = null
  searchQuery.value = ''
  await loadDirectory(project.path)
}

async function loadDirectory(path: string) {
  loading.value = true
  errorMessage.value = ''
  try {
    listing.value = await api.value.listDirectory(path)
    currentPath.value = listing.value.path
    viewer.value = null
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    loading.value = false
  }
}

async function openEntry(entry: FileEntry) {
  if (entry.type === 'directory') {
    await loadDirectory(entry.path)
    return
  }
  await openFile(entry.path)
}

async function openFile(path: string) {
  loading.value = true
  errorMessage.value = ''
  try {
    drawerOpen.value = false
    const name = fileNameFromPath(path)
    if (isPreviewableImage(path)) {
      viewer.value = {
        path,
        name,
        type: 'image',
        content: await api.value.readImageFile(path),
        language: 'image',
      }
    } else {
      const language = inferLanguage(path)
      viewer.value = {
        path,
        name,
        type: 'text',
        content: await api.value.readTextFile(path),
        language,
        renderMarkdown: language === 'markdown',
      }
    }
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    loading.value = false
  }
}

function toggleMarkdownRender() {
  if (viewer.value && viewer.value.type === 'text') {
    viewer.value.renderMarkdown = !viewer.value.renderMarkdown
  }
}

function renderMarkdown(content: string): string {
  return renderMd(content)
}

async function goBackToProjects() {
  projectPickerOpen.value = true
}

async function goUp() {
  if (!activeProject.value || !listing.value || !canGoUp.value) return
  const parent = parentPath(listing.value.path)
  if (!parent || !isSameOrChildPath(parent, activeProject.value.path)) {
    await loadDirectory(activeProject.value.path)
    return
  }
  await loadDirectory(parent)
}

async function runSearch() {
  const project = activeProject.value
  const query = searchQuery.value.trim()
  if (!project || !query) {
    searchResults.value = null
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    searchResults.value = await api.value.search(project.path, query)
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    loading.value = false
  }
}

function disconnect() {
  clearTimeout(reconnectTimer)
  pendingConnection = null
  connectionLost.value = false
  connectionRejected.value = false
  connectionAttempt += 1
  connectionEpoch.value += 1
  activeConnection.value = null
  loading.value = false
  status.value = null
  activeProject.value = null
  listing.value = null
  viewer.value = null
  recentProjects.value = []
  searchResults.value = null
  errorMessage.value = ''
  token.value = ''
  localStorage.removeItem(CONNECTION_STORAGE_KEY)
  if (nativeApp && hostedPage) window.location.replace('http://localhost/#disconnect=1')
}

function updateViewport() {
  const viewport = window.visualViewport
  document.documentElement.style.setProperty('--mobile-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
  document.documentElement.style.setProperty('--mobile-viewport-top', `${viewport?.offsetTop ?? 0}px`)
}

onMounted(() => {
  updateViewport()
  document.addEventListener('visibilitychange', resumePreferences)
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('scroll', updateViewport)
})
onBeforeUnmount(() => {
  connectionAttempt += 1
  clearTimeout(reconnectTimer)
  pendingConnection = null
  preferencesDisposed = true
  preferencesGeneration += 1
  clearTimeout(preferencesTimer)
  document.removeEventListener('visibilitychange', resumePreferences)
  window.visualViewport?.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('scroll', updateViewport)
})

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    === right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isSameOrChildPath(path: string, root: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (slash <= 2) return trimmed
  return trimmed.slice(0, slash)
}

function resultTitle(result: ProjectFileMatch | TextSearchMatch): string {
  return fileNameFromPath(result.path)
}
</script>

<template>
  <main class="mobile-app">
    <header class="mobile-topbar" :inert="settingsOpen || drawerOpen">
      <button class="mobile-icon-button" type="button" aria-label="打开工作区资源管理器" :aria-expanded="drawerOpen" @click="drawerOpen = true"><Menu :size="20" /></button>
      <div class="mobile-title"><strong>{{ currentTitle }}</strong><span>{{ connectionRejected ? '连接凭据已失效' : connectionLost ? '连接中断，正在重连' : connected ? '已连接工作区' : '未连接电脑' }}</span></div>
      <button v-if="viewer && viewer.language === 'markdown'" class="mobile-icon-button" type="button" :aria-label="viewer.renderMarkdown ? '切换原文' : '渲染 Markdown'" @click="toggleMarkdownRender"><FileText v-if="viewer.renderMarkdown" :size="19" /><Eye v-else :size="19" /></button>
      <button v-if="viewer" class="mobile-icon-button" type="button" aria-label="关闭文件" @click="viewer = null"><X :size="19" /></button>
      <button v-else class="mobile-icon-button" type="button" aria-label="设置" @click="settingsOpen = true"><MoreHorizontal :size="20" /></button>
    </header>
    <div v-if="errorMessage && !settingsOpen" class="mobile-error" role="alert"><AlertTriangle :size="16" /><span>{{ errorMessage }}</span><button class="mobile-icon-button" @click="errorMessage = ''" aria-label="关闭提示"><X :size="14" /></button></div>
    <MobileSessions v-show="!viewer" :key="`${connectionEpoch}:${activeProject?.path ?? 'disconnected'}`" :api="api" :root="activeProject?.path ?? ''" :connected="connected" :inert="settingsOpen || drawerOpen" mode="ai" :theme="appearance.theme" :font-size="appearance.fontSize" :hidden-cli-provider-ids="hiddenCliProviderIds" :initial-draft="messageDraft" @draft-change="messageDraft = $event" @connect="connected ? drawerOpen = true : settingsOpen = true" />
    <template v-if="drawerOpen">
      <button class="mobile-drawer-backdrop" type="button" aria-label="收起资源管理器" @click="drawerOpen = false" />
      <aside :inert="settingsOpen" class="mobile-drawer" aria-label="工作区资源管理器">
        <header class="mobile-topbar"><strong class="mobile-title">资源管理器</strong><button class="mobile-icon-button" type="button" aria-label="关闭资源管理器" @click="drawerOpen = false"><X :size="18" /></button></header>
        <div v-if="!connected" class="mobile-section"><p class="mobile-empty">连接电脑后浏览真实工作区文件。</p><button class="mobile-primary-button" type="button" @click="settingsOpen = true">账号管理 · 连接电脑</button></div>
        <section v-else-if="projectPickerOpen || !activeProject" class="mobile-section">
          <div class="mobile-section-header"><strong>工作区</strong><button class="mobile-text-button" type="button" :disabled="loading" @click="refreshProjects"><RefreshCw :size="15" />刷新</button></div>
          <button v-for="project in recentProjects" :key="project.path" class="mobile-project-row" type="button" @click="selectProject(project)"><FolderOpen :size="18" /><span><strong>{{ project.name }}</strong><small>{{ project.path }}</small></span></button>
          <p v-if="!recentProjects.length" class="mobile-empty">电脑端还没有历史工作区。</p>
        </section>    <section v-if="connected && activeProject && !projectPickerOpen" class="mobile-section project-browser">
      <div class="mobile-section-header">
        <button class="mobile-text-button" type="button" @click="goBackToProjects">{{ activeProject.name }} ▾</button>
        <button class="mobile-text-button" type="button" :disabled="loading || !canGoUp" @click="goUp">
          <ChevronLeft :size="15" />
          <span>上级</span>
        </button>
      </div>

      <form class="mobile-search" @submit.prevent="runSearch">
        <Search :size="16" />
        <input v-model="searchQuery" type="search" placeholder="搜索文件和内容" />
        <button type="submit" :disabled="loading || !searchQuery.trim()">搜索</button>
      </form>

      <div v-if="searchResults" class="mobile-search-results">
        <button
          v-for="result in searchResults.files"
          :key="`file-${result.path}`"
          class="mobile-result-row"
          type="button"
          @click="openFile(result.path)"
        >
          <FileText :size="16" />
          <span>
            <strong>{{ resultTitle(result) }}</strong>
            <small>{{ result.relativePath }}</small>
          </span>
        </button>
        <button
          v-for="match in searchResults.textMatches"
          :key="`text-${match.path}-${match.lineNumber}-${match.column}`"
          class="mobile-result-row"
          type="button"
          @click="openFile(match.path)"
        >
          <Search :size="16" />
          <span>
            <strong>{{ resultTitle(match) }}:{{ match.lineNumber }}</strong>
            <small>{{ match.preview }}</small>
          </span>
        </button>
      </div>

      <div class="mobile-path">{{ currentPath }}</div>
      <div class="mobile-file-list">
        <button
          v-for="entry in listing?.entries ?? []"
          :key="entry.path"
          class="mobile-file-row"
          type="button"
          @click="openEntry(entry)"
        >
          <FolderOpen v-if="entry.type === 'directory'" :size="18" />
          <ImageIcon v-else-if="isPreviewableImage(entry.path)" :size="18" />
          <FileText v-else :size="18" />
          <span>
            <strong>{{ entry.name }}</strong>
            <small>{{ entry.type === 'directory' ? '目录' : entry.extension || '文件' }}</small>
          </span>
        </button>
      </div>
    </section>

        <footer class="mobile-account-row"><Server :size="20" /><span>{{ connected ? activeConnection?.baseUrl : '未连接电脑' }}</span><button class="mobile-icon-button" type="button" aria-label="账号与设置" @click="settingsOpen = true"><MoreHorizontal :size="21" /></button></footer>
      </aside>
    </template>
    <MobileSettings v-show="settingsOpen" v-model:base-url="baseUrl" v-model:token="token" :api="api" :connected="connected" :status="status" :loading="loading" :error-message="errorMessage" @close="settingsOpen = false" @connect="connect()" @disconnect="disconnect" :theme-id="appearance.theme" :hidden-cli-provider-ids="hiddenCliProviderIds" :preferences-busy="preferencesBusy" @font-size="appearance.fontSize = $event" @update-preferences="updatePreferences" />
    <section v-if="viewer" :inert="settingsOpen || drawerOpen" class="mobile-viewer">
      <div class="mobile-viewer-meta">
        <span>{{ viewer.path }}</span>
        <code>{{ viewer.language }}</code>
      </div>
      <img v-if="viewer.type === 'image'" :src="viewer.content" :alt="viewer.name" />
      <div v-else-if="viewer.renderMarkdown" class="mobile-markdown-rendered" v-html="renderMarkdown(viewer.content)" />
      <pre v-else>{{ viewer.content }}</pre>
    </section>
  </main>
</template>



