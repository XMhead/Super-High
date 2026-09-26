<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { backend, isTauri } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const TOOLS_WINDOW_LABEL = 'dragoncore-tools'
let unlistenCloseRequest: UnlistenFn | null = null

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

function toolsUrl() {
  const query = new URLSearchParams({
    dragoncoreTools: '1',
    projectPath: store.workspace?.rootPath ?? '',
    filePath: store.activeTab?.path ?? '',
  })
  return `index.html?${query.toString()}`
}

async function syncToolsWindow() {
  if (!store.workspace) return
  await emitTo(TOOLS_WINDOW_LABEL, 'dragoncore-tools-open-file', {
    projectPath: store.workspace.rootPath,
    filePath: store.activeTab?.path ?? '',
  })
}

async function openToolsWindow() {
  if (!isTauri() || !store.workspace) return
  let toolsWindow = await WebviewWindow.getByLabel(TOOLS_WINDOW_LABEL)
  try {
    if (!toolsWindow) {
      toolsWindow = new WebviewWindow(TOOLS_WINDOW_LABEL, {
        url: toolsUrl(),
        title: 'DragonCore 工具',
        width: 1360,
        height: 820,
        minWidth: 1100,
        minHeight: 620,
        skipTaskbar: true,
        visible: false,
      })
      await new Promise<void>((resolve, reject) => {
        void toolsWindow?.once('tauri://created', () => resolve())
        void toolsWindow?.once('tauri://error', (event) => reject(new Error(String(event.payload))))
      })
    }

    await toolsWindow.show()
    await delay(150)
    await backend.attachDragonCoreToolsWindow()
    await syncToolsWindow()
    await toolsWindow.setFocus()
  } catch (error) {
    await toolsWindow?.destroy().catch(() => undefined)
    store.closeDragonCoreMode()
    store.showErrorMessage(`DragonCore 工具无法显示在游戏窗口上方：${errorMessage(error)}`)
  }
}

async function closeToolsWindow() {
  const toolsWindow = await WebviewWindow.getByLabel(TOOLS_WINDOW_LABEL)
  await toolsWindow?.destroy()
}

watch(() => store.dragonCoreModeOpen, (isOpen) => {
  void (isOpen ? openToolsWindow() : closeToolsWindow())
}, { immediate: true })

watch(() => [store.workspace?.rootPath, store.activeTab?.path], () => {
  if (store.dragonCoreModeOpen) void syncToolsWindow()
})

onMounted(() => {
  void listen('dragoncore-tools-close-request', () => store.closeDragonCoreMode()).then((unlisten) => {
    unlistenCloseRequest = unlisten
  })
})

onBeforeUnmount(() => {
  unlistenCloseRequest?.()
  void closeToolsWindow()
})
</script>

<template><span hidden /></template>
