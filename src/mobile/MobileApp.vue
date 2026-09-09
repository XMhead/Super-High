<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
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
} from 'lucide-vue-next'

import { MobileHostApi, normalizeHostBaseUrl } from '@/lib/hostApi'
import { fileNameFromPath, inferLanguage, isPreviewableImage } from '@/lib/path'
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
}

const baseUrl = ref('')
const token = ref('')
const activeConnection = ref<{ baseUrl: string; token: string } | null>(null)
const connectionEpoch = ref(0)
let connectionAttempt = 0
const status = ref<MobileHostApiStatus | null>(null)
const recentProjects = ref<RecentProject[]>([])
const activeProject = ref<RecentProject | null>(null)
const currentPath = ref('')
const listing = ref<DirectoryListing | null>(null)
const viewer = ref<FileViewer | null>(null)
const searchQuery = ref('')
const drawerOpen = ref(false)
const settingsOpen = ref(false)
const appearance = ref({ theme: 'dark', fontSize: 14 })
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

async function connect() {
  const normalized = normalizeHostBaseUrl(baseUrl.value)
  if (!normalized || !token.value.trim()) {
    errorMessage.value = '需要填写 Host 地址和令牌'
    return
  }

  loading.value = true
  errorMessage.value = ''
  const attempt = ++connectionAttempt
  const candidate = { baseUrl: normalized, token: token.value.trim() }
  const candidateApi = new MobileHostApi(candidate)
  try {
    const nextStatus = await candidateApi.status()
    if (attempt !== connectionAttempt) return
    if ((nativeApp && !hostedPage) || (hostedPage && new URL(normalized).origin !== window.location.origin)) {
      await candidateApi.checkMobilePage()
      if (attempt !== connectionAttempt) return
      localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(candidate))
      const page = new URL('/mobile/', normalized)
      page.hash = new URLSearchParams({ token: candidate.token }).toString()
      window.location.assign(page.href)
      return
    }
    const projects = await candidateApi.listRecentProjects()
    if (attempt !== connectionAttempt) return
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(candidate))
    activeConnection.value = candidate
    baseUrl.value = normalized
    connectionEpoch.value += 1
    status.value = nextStatus
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
    if (attempt === connectionAttempt) errorMessage.value = formatError(error).split(candidate.token).join('[令牌已隐藏]')
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
      viewer.value = {
        path,
        name,
        type: 'text',
        content: await api.value.readTextFile(path),
        language: inferLanguage(path),
      }
    }
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    loading.value = false
  }
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
  window.visualViewport?.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('scroll', updateViewport)
})
onBeforeUnmount(() => {
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
      <div class="mobile-title"><strong>{{ currentTitle }}</strong><span>{{ connected ? '已连接工作区' : '未连接电脑' }}</span></div>
      <button v-if="viewer" class="mobile-icon-button" type="button" aria-label="关闭文件" @click="viewer = null"><X :size="19" /></button>
      <button v-else class="mobile-icon-button" type="button" aria-label="设置" @click="settingsOpen = true"><MoreHorizontal :size="20" /></button>
    </header>
    <div v-if="errorMessage && !settingsOpen" class="mobile-error" role="alert"><AlertTriangle :size="16" /><span>{{ errorMessage }}</span><button class="mobile-icon-button" @click="errorMessage = ''" aria-label="关闭提示"><X :size="14" /></button></div>
    <MobileSessions v-show="!viewer" :key="`${connectionEpoch}:${activeProject?.path ?? 'disconnected'}`" :api="api" :root="activeProject?.path ?? ''" :connected="connected" :inert="settingsOpen || drawerOpen" mode="ai" :theme="appearance.theme" :font-size="appearance.fontSize" @connect="connected ? drawerOpen = true : settingsOpen = true" />
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
    <MobileSettings v-show="settingsOpen" v-model:base-url="baseUrl" v-model:token="token" :api="api" :connected="connected" :status="status" :loading="loading" :error-message="errorMessage" @close="settingsOpen = false" @connect="connect" @disconnect="disconnect" @preferences="appearance = $event" />
    <section v-if="viewer" :inert="settingsOpen || drawerOpen" class="mobile-viewer">
      <div class="mobile-viewer-meta">
        <span>{{ viewer.path }}</span>
        <code>{{ viewer.language }}</code>
      </div>
      <img v-if="viewer.type === 'image'" :src="viewer.content" :alt="viewer.name" />
      <pre v-else>{{ viewer.content }}</pre>
    </section>
  </main>
</template>



