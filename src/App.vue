<script lang="ts">
function eventComesFromXterm(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => (
    target instanceof Element && (target.matches('.xterm') || !!target.closest('.xterm'))
  ))
}

export function shouldBlockReloadShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  const fromXterm = eventComesFromXterm(event)
  if (key === 'f5') {
    return !(fromXterm && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey)
  }
  if (key !== 'r' || (!event.ctrlKey && !event.metaKey) || event.altKey) return false
  return !(fromXterm && event.ctrlKey && !event.metaKey && !event.shiftKey)
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { storeToRefs } from 'pinia'
import { Save, X } from 'lucide-vue-next'

import WelcomeScreen from '@/components/WelcomeScreen.vue'
import WorkspaceShell from '@/components/WorkspaceShell.vue'
import SuperhighPet from '@/components/SuperhighPet.vue'
import MediaViewer from '@/components/MediaViewer.vue'
import AppUpdateNotice from '@/components/AppUpdateNotice.vue'
import DesktopOnboarding from '@/components/DesktopOnboarding.vue'
import { openExternalLinkFromClick, urlFromExternalUrlMessage } from '@/lib/externalLinks'
import { backend, isTauri } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const { initialized, workspace } = storeToRefs(store)
const closeDialogOpen = ref(false)
const closeInProgress = ref(false)
const dirtyTabCount = computed(() => store.dirtyTextTabs.length)
const mediaViewer = ref<{ requestClose: () => void } | null>(null)

let allowWindowClose = false
let shutdownRequested = false
let unlistenCloseRequested: UnlistenFn | null = null
let unloadPersistence: Promise<void> | null = null

function requestCloseConfirmation() {
  if (closeDialogOpen.value || closeInProgress.value) return
  closeDialogOpen.value = true
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  persistTerminalStateBeforeUnload()
  if (allowWindowClose || !store.hasDirtyTextTabs) {
    return
  }
  event.preventDefault()
  event.returnValue = ''
}

function handlePageHide() {
  persistTerminalStateBeforeUnload()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (!shouldBlockReloadShortcut(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

// 统一使用系统浏览器打开网页链接，避免主 WebView 跳离 Super High。
function openUrlInSystemBrowser(url: string) {
  return backend.openUrl(url).catch((error) => {
    store.showErrorMessage(`打开网页失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

function handleGlobalClick(event: MouseEvent) {
  openExternalLinkFromClick(event, openUrlInSystemBrowser)
}

function handleWindowMessage(event: MessageEvent) {
  const url = urlFromExternalUrlMessage(event.data)
  if (!url) return
  void openUrlInSystemBrowser(url)
}

function persistTerminalStateBeforeUnload() {
  if (store.startupMediaPath) return
  if (unloadPersistence) return
  unloadPersistence = store.persistOpenTerminalStates()
    .catch(() => undefined)
    .finally(() => {
      unloadPersistence = null
    })
}

async function closeApplication() {
  if (shutdownRequested) return
  shutdownRequested = true
  if (isTauri()) {
    try {
      await backend.shutdownApp()
    } catch (error) {
      shutdownRequested = false
      allowWindowClose = false
      store.showErrorMessage(`关闭应用失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  allowWindowClose = true
  window.close()
}

async function closeMediaViewer() {
  allowWindowClose = true
  if (!isTauri()) {
    window.close()
    return
  }
  try {
    await getCurrentWindow().close()
  } catch (error) {
    allowWindowClose = false
    store.showErrorMessage(`关闭查看器失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function requestMediaViewerClose() {
  if (mediaViewer.value) {
    mediaViewer.value.requestClose()
    return
  }
  void closeMediaViewer()
}

function requestAppClose() {
  if (store.hasDirtyTextTabs) {
    requestCloseConfirmation()
    return
  }
  if (store.startupMediaPath) {
    requestMediaViewerClose()
    return
  }
  void closeApplication()
}

async function answerCloseDialog(choice: 'save' | 'discard' | 'cancel') {
  if (choice === 'cancel') {
    closeDialogOpen.value = false
    return
  }

  closeInProgress.value = true
  try {
    if (choice === 'save') {
      const saved = await store.saveDirtyTextTabs()
      if (!saved) return
    } else {
      store.discardDirtyTextTabs()
    }
    closeDialogOpen.value = false
    await closeApplication()
  } finally {
    closeInProgress.value = false
  }
}

async function answerWorkspaceCloseDialog(choice: 'save' | 'discard') {
  const rootPath = store.pendingWorkspaceCloseRootPath
  store.pendingWorkspaceCloseRootPath = null
  if (!rootPath) return
  await store.closeWorkspaceTab(rootPath, choice)
}

onMounted(() => {
  void store.initialize()
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('keydown', handleGlobalKeydown, true)
  window.addEventListener('click', handleGlobalClick, true)
  window.addEventListener('message', handleWindowMessage)
  window.addEventListener('superhigh:request-app-close', requestAppClose)
  if (isTauri()) {
    void getCurrentWindow().onCloseRequested((event) => {
      if (allowWindowClose) return
      if (store.startupMediaPath) {
        event.preventDefault()
        requestMediaViewerClose()
        return
      }
      event.preventDefault()
      requestAppClose()
    }).then((unlisten) => {
      unlistenCloseRequested = unlisten
    }).catch((error) => {
      store.showErrorMessage(`窗口关闭监听失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('pagehide', handlePageHide)
  window.removeEventListener('keydown', handleGlobalKeydown, true)
  window.removeEventListener('click', handleGlobalClick, true)
  window.removeEventListener('message', handleWindowMessage)
  window.removeEventListener('superhigh:request-app-close', requestAppClose)
  unlistenCloseRequested?.()
})
</script>

<template>
  <div class="app-shell">
    <div v-if="!initialized" class="app-loading">
      <div class="loading-card">
        <h1>Super High</h1>
        <p>正在加载工作区状态...</p>
      </div>
    </div>
    <MediaViewer
      v-else-if="store.startupMediaPath"
      ref="mediaViewer"
      :initial-path="store.startupMediaPath"
      @close-approved="closeMediaViewer"
    />
    <WorkspaceShell v-else-if="workspace" />
    <WelcomeScreen v-else />
    <SuperhighPet v-if="initialized" />
    <AppUpdateNotice v-if="initialized && !store.startupMediaPath" />
    <DesktopOnboarding v-if="initialized && !store.startupMediaPath" />
    <div v-if="store.activityMessage" class="toast-message" @click="store.dismissActivityMessage()">{{ store.activityMessage }}</div>
    <div v-if="store.errorMessage" class="toast-message error" @click="store.dismissErrorMessage()">{{ store.errorMessage }}</div>
    <div v-if="closeDialogOpen" class="save-dialog-backdrop">
      <div class="save-dialog" role="dialog" aria-modal="true" aria-labelledby="app-close-dialog-title">
        <div class="save-dialog-titlebar">
          <span id="app-close-dialog-title">保存</span>
          <button
            class="save-dialog-window-close"
            type="button"
            :disabled="closeInProgress"
            @click="answerCloseDialog('cancel')"
          >
            <X :size="15" />
          </button>
        </div>
        <div class="save-dialog-body">
          <div class="save-dialog-icon">?</div>
          <div class="save-dialog-message">
            还有 {{ dirtyTabCount }} 个文件未保存。关闭 Super High 前是否保存？
          </div>
        </div>
        <div class="save-dialog-actions">
          <button
            type="button"
            class="save-dialog-button primary"
            :disabled="closeInProgress"
            @click="answerCloseDialog('save')"
          >
            <Save :size="13" />
            <span>保存</span>
          </button>
          <button
            type="button"
            class="save-dialog-button"
            :disabled="closeInProgress"
            @click="answerCloseDialog('discard')"
          >
            <X :size="13" />
            <span>不保存</span>
          </button>
          <button
            type="button"
            class="save-dialog-button"
            :disabled="closeInProgress"
            @click="answerCloseDialog('cancel')"
          >
            <X :size="13" />
            <span>取消</span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="store.pendingWorkspaceCloseRootPath" class="save-dialog-backdrop">
      <div class="save-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-close-dialog-title">
        <div class="save-dialog-titlebar">
          <span id="workspace-close-dialog-title">保存</span>
          <button
            class="save-dialog-window-close"
            type="button"
            @click="store.pendingWorkspaceCloseRootPath = null"
          >
            <X :size="15" />
          </button>
        </div>
        <div class="save-dialog-body">
          <div class="save-dialog-icon">?</div>
          <div class="save-dialog-message">
            该工作区有未保存文件。关闭前是否保存？
          </div>
        </div>
        <div class="save-dialog-actions">
          <button
            type="button"
            class="save-dialog-button primary"
            @click="answerWorkspaceCloseDialog('save')"
          >
            <Save :size="13" />
            <span>保存</span>
          </button>
          <button
            type="button"
            class="save-dialog-button"
            @click="answerWorkspaceCloseDialog('discard')"
          >
            <X :size="13" />
            <span>不保存</span>
          </button>
          <button
            type="button"
            class="save-dialog-button"
            @click="store.pendingWorkspaceCloseRootPath = null"
          >
            <X :size="13" />
            <span>取消</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
