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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { storeToRefs } from 'pinia'
import { Save, X } from 'lucide-vue-next'

import AppSplash from '@/components/AppSplash.vue'
import WelcomeScreen from '@/components/WelcomeScreen.vue'
import WorkspaceShell from '@/components/WorkspaceShell.vue'
import SuperhighPet from '@/components/SuperhighPet.vue'
import MediaViewer from '@/components/MediaViewer.vue'
import AppUpdateNotice from '@/components/AppUpdateNotice.vue'
import DesktopOnboarding from '@/components/DesktopOnboarding.vue'
import { openExternalLinkFromClick, urlFromExternalUrlMessage } from '@/lib/externalLinks'
import { NOTICE_OPEN_FILE_EVENT } from '@/lib/cliCompletion'
import { backend, isTauri } from '@/lib/tauri'
import { readBootThemeId, SIGNATURE_THEME_ID } from '@/lib/theme'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNativeScrollSpeed } from '@/lib/scrollSpeed'

const store = useWorkspaceStore()
useNativeScrollSpeed(() => store.settings.scrollSpeedPercent)
const { initialized, workspace } = storeToRefs(store)
watch(() => workspace.value?.rootPath ?? null, (path) => {
  if (isTauri()) void backend.setActiveWorkspace(path).catch((error) => console.error('同步当前工作区失败', error))
}, { immediate: true })
let mobileViewRevision = 0
const mobileBoundTab = computed(() => {
  const binding = store.projectEditorBindings[(store.activeTab?.path ?? '').replace(/\\/g, '/').toLowerCase()]
  return binding && store.tabs.find(tab => tab.path.replace(/\\/g, '/').toLowerCase() === binding.path.replace(/\\/g, '/').toLowerCase())
})
watch(() => [workspace.value?.rootPath, store.activeTab?.path, store.activeTab?.content, store.settings.htmlPreviewEnabled, mobileBoundTab.value?.path, mobileBoundTab.value?.content, mobileBoundTab.value?.isDirty], () => {
  if (isTauri()) void backend.setMobileViewState({
    filePath: store.activeTab?.path ?? null,
    htmlPreviewEnabled: store.settings.htmlPreviewEnabled,
    revision: ++mobileViewRevision,
  }).catch((error) => console.error('同步当前预览失败', error))
}, { immediate: true, flush: 'post' })
const splashVisible = ref(true)
const splashVibe = readBootThemeId() === SIGNATURE_THEME_ID
const closeDialogOpen = ref(false)
const closeInProgress = ref(false)
const dirtyTabCount = computed(() => store.dirtyTextTabs.length)
const mediaViewer = ref<{ requestClose: () => void } | null>(null)

let allowWindowClose = false
let shutdownRequested = false
let unlistenCloseRequested: UnlistenFn | null = null
let unlistenNoticeOpenFile: UnlistenFn | null = null
let unloadMinecraftHideRequested = false

function requestCloseConfirmation() {
  if (closeDialogOpen.value || closeInProgress.value) return
  closeDialogOpen.value = true
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (allowWindowClose || !store.hasDirtyTextTabs) {
    hideMinecraftBeforeUnload()
    return
  }
  event.preventDefault()
  event.returnValue = ''
}

function handlePageHide() {
  hideMinecraftBeforeUnload()
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

// 管家通知里的文件链接：唤回主窗口并在代码预览打开，通知窗口本身不导航。
async function openNoticeFile(payload: { path?: unknown; lineNumber?: unknown }) {
  if (typeof payload?.path !== 'string' || !payload.path) return
  const appWindow = getCurrentWindow()
  await appWindow.unminimize().catch(() => undefined)
  await appWindow.show().catch(() => undefined)
  await appWindow.setFocus().catch(() => undefined)
  const lineNumber = typeof payload.lineNumber === 'number' && payload.lineNumber > 0 ? payload.lineNumber : undefined
  await store.openTerminalFileLink(payload.path, lineNumber)
}

function hideMinecraftBeforeUnload() {
  if (store.startupMediaPath || unloadMinecraftHideRequested || !isTauri()) return
  unloadMinecraftHideRequested = true
  void backend.hideMinecraftClient().catch(() => undefined)
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
    if (getCurrentWindow().label === 'main') {
      void listen<{ path?: unknown; lineNumber?: unknown }>(NOTICE_OPEN_FILE_EVENT, (event) => { void openNoticeFile(event.payload) })
        .then((unlisten) => { unlistenNoticeOpenFile = unlisten })
        .catch((error) => console.error('管家通知文件链接监听失败', error))
    }
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
  unlistenNoticeOpenFile?.()
})
</script>

<template>
  <div class="app-shell">
    <template v-if="initialized">
      <MediaViewer
        v-if="store.startupMediaPath"
        ref="mediaViewer"
        :initial-path="store.startupMediaPath"
        @close-approved="closeMediaViewer"
      />
      <WorkspaceShell v-else-if="workspace" />
      <WelcomeScreen v-else />
    </template>
    <AppSplash
      v-if="splashVisible"
      :ready="initialized"
      :skip="!!store.startupMediaPath"
      :vibe="splashVibe"
      @done="splashVisible = false"
    />
    <SuperhighPet v-if="initialized" />
    <AppUpdateNotice v-if="initialized && !store.startupMediaPath" />
    <DesktopOnboarding v-if="initialized && !store.startupMediaPath" />
    <div v-if="store.activityMessage" class="toast-message" @click="store.dismissActivityMessage()">{{ store.activityMessage }}</div>
    <div v-if="store.importRecycleNotice" class="toast-message import-recycle-tip" role="status">
      <span>导入完成后是否将“{{ store.importRecycleNotice.name }}”移到回收站？</span>
      <button type="button" @click.stop="store.recycleImportedFile">移到回收站</button>
      <button type="button" @click.stop="store.dismissImportRecycleNotice">稍后</button>
    </div>
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
