<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import MobileSessions from './MobileSessions.vue'
import {
  AlertTriangle,
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
const nativeApp = Capacitor.isNativePlatform()

type FileViewer = {
  path: string
  name: string
  type: 'text' | 'image'
  content: string
  language: string
}

const baseUrl = ref('')
const token = ref('')
const status = ref<MobileHostApiStatus | null>(null)
const recentProjects = ref<RecentProject[]>([])
const activeProject = ref<RecentProject | null>(null)
const currentPath = ref('')
const listing = ref<DirectoryListing | null>(null)
const viewer = ref<FileViewer | null>(null)
const searchQuery = ref('')
const activeTab = ref<'files' | 'terminal' | 'ai'>('files')
const searchResults = ref<ProjectSearchResult | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const connected = computed(() => !!status.value)
const api = computed(() => new MobileHostApi({
  baseUrl: normalizeHostBaseUrl(baseUrl.value),
  token: token.value,
}))
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
    if (token.value.trim()) void connect()
  }
})

async function connect() {
  const normalized = normalizeHostBaseUrl(baseUrl.value)
  if (!normalized || !token.value.trim()) {
    errorMessage.value = '需要填写 Host 地址和令牌'
    return
  }

  loading.value = true
  errorMessage.value = ''
  try {
    baseUrl.value = normalized
    const nextStatus = await api.value.status()
    localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({
      baseUrl: baseUrl.value,
      token: token.value.trim(),
    }))
    if ((nativeApp && !hostedPage) || (hostedPage && new URL(normalized).origin !== window.location.origin)) {
      await api.value.checkMobilePage()
      const page = new URL('/mobile/', normalized)
      page.hash = new URLSearchParams({ token: token.value.trim() }).toString()
      window.location.assign(page.href)
      return
    }
    const projects = await api.value.listRecentProjects()
    status.value = nextStatus
    recentProjects.value = projects
  } catch (error) {
    status.value = null
    errorMessage.value = formatError(error)
  } finally {
    loading.value = false
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
  activeTab.value = 'files'
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
  activeProject.value = null
  listing.value = null
  viewer.value = null
  searchResults.value = null
  searchQuery.value = ''
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
  status.value = null
  activeProject.value = null
  listing.value = null
  viewer.value = null
  recentProjects.value = []
  searchResults.value = null
  errorMessage.value = ''
  token.value = ''
  localStorage.removeItem(CONNECTION_STORAGE_KEY)
  if (nativeApp && hostedPage) window.location.replace('http://localhost/')
}

function reloadInterface() {
  window.location.reload()
}

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
    <header class="mobile-topbar">
      <button
        v-if="viewer"
        class="mobile-icon-button"
        type="button"
        aria-label="关闭文件"
        @click="viewer = null"
      >
        <ChevronLeft :size="20" />
      </button>
      <button
        v-else-if="activeProject"
        class="mobile-icon-button"
        type="button"
        aria-label="返回项目"
        @click="goBackToProjects"
      >
        <ChevronLeft :size="20" />
      </button>
      <div class="mobile-title">
        <strong>{{ currentTitle }}</strong>
        <span>{{ connected ? baseUrl : '未连接' }}</span>
      </div>
      <button
        v-if="hostedPage"
        class="mobile-text-button"
        type="button"
        title="从电脑加载最新界面"
        @click="reloadInterface"
      >
        <RefreshCw :size="15" />
        <span>更新界面</span>
      </button>
      <button
        v-if="connected"
        class="mobile-icon-button"
        type="button"
        aria-label="断开"
        @click="disconnect"
      >
        <X :size="19" />
      </button>
    </header>

    <section class="mobile-connection">
      <div class="mobile-connection-status" :class="{ connected }">
        <Server :size="17" />
        <span>{{ connected ? `已连接，${status?.recentProjectCount ?? 0} 个工作区` : '连接电脑 Host' }}</span>
      </div>
      <div v-if="!connected" class="mobile-form-grid">
        <label>
          <span>Host 地址</span>
          <input v-model="baseUrl" type="url" inputmode="url" placeholder="http://电脑IP:10320" />
        </label>
        <label>
          <span>令牌</span>
          <input v-model="token" type="text" autocomplete="off" />
        </label>
        <button class="mobile-primary-button" type="button" :disabled="loading" @click="connect">
          <Server :size="16" />
          <span>{{ loading ? '连接中' : '连接' }}</span>
        </button>
      </div>
    </section>

    <div v-if="errorMessage" class="mobile-error">
      <AlertTriangle :size="16" />
      <span>{{ errorMessage }}</span>
    </div>

    <section v-if="connected && !activeProject" class="mobile-section">
      <div class="mobile-section-header">
        <strong>工作区</strong>
        <button class="mobile-text-button" type="button" :disabled="loading" @click="refreshProjects">
          <RefreshCw :size="15" />
          <span>刷新</span>
        </button>
      </div>
      <button
        v-for="project in recentProjects"
        :key="project.path"
        class="mobile-project-row"
        type="button"
        @click="selectProject(project)"
      >
        <FolderOpen :size="18" />
        <span>
          <strong>{{ project.name }}</strong>
          <small>{{ project.path }}</small>
        </span>
      </button>
      <div v-if="!recentProjects.length" class="mobile-empty">电脑端还没有历史工作区。</div>
    </section>

    <nav v-if="connected && activeProject" class="mobile-tabs" aria-label="工作区功能">
      <button v-for="tab in [{ id: 'files' as const, label: '文件' }, { id: 'terminal' as const, label: '终端' }, { id: 'ai' as const, label: 'AI 对话' }]" :key="tab.id" type="button" :class="{ active: activeTab === tab.id }" :aria-pressed="activeTab === tab.id" @click="activeTab = tab.id; viewer = null">{{ tab.label }}</button>
    </nav>

    <MobileSessions v-if="connected && activeProject && activeTab !== 'files'" :key="activeProject.path" :api="api" :root="activeProject.path" :mode="activeTab" />

    <section v-if="connected && activeProject && activeTab === 'files' && !viewer" class="mobile-section project-browser">
      <div class="mobile-section-header">
        <strong>{{ activeProject.name }}</strong>
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

    <section v-if="viewer" class="mobile-viewer">
      <div class="mobile-viewer-meta">
        <span>{{ viewer.path }}</span>
        <code>{{ viewer.language }}</code>
      </div>
      <img v-if="viewer.type === 'image'" :src="viewer.content" :alt="viewer.name" />
      <pre v-else>{{ viewer.content }}</pre>
    </section>
  </main>
</template>
