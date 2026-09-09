<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PanelRightClose, PanelRightOpen } from 'lucide-vue-next'

import PreviewPane from './PreviewPane.vue'
import TerminalPane from './TerminalPane.vue'
import { useWorkspaceStore } from '@/stores/workspace'

type ToolsFilePayload = {
  projectPath?: string
  filePath?: string
}

const store = useWorkspaceStore()
const ready = ref(false)
const cliOpen = ref(false)
const params = new URLSearchParams(window.location.search)
const initialProjectPath = params.get('projectPath') ?? ''
const initialFilePath = params.get('filePath') ?? ''
let unlistenFile: UnlistenFn | null = null
let unlistenClose: UnlistenFn | null = null

async function closeDragonCliSessions() {
  await Promise.all(store.dragonCliSessionIds.map((sessionId) => store.closeTerminalSession(sessionId)))
}

async function openProjectFile(payload: ToolsFilePayload) {
  const projectPath = payload.projectPath?.trim()
  if (!projectPath) return
  await store.openDragonCoreToolsFile(projectPath, payload.filePath?.trim() ?? '')
}

onMounted(() => {
  void (async () => {
    await store.initializeDragonCoreTools()
    store.settings.activePreviewMode = 'code'
    await openProjectFile({ projectPath: initialProjectPath, filePath: initialFilePath })
    ready.value = true
    unlistenFile = await listen<ToolsFilePayload>('dragoncore-tools-open-file', (event) => {
      void openProjectFile(event.payload)
    })
    unlistenClose = await getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault()
      void closeDragonCliSessions().finally(() => emit('dragoncore-tools-close-request'))
    })
  })()
})

onBeforeUnmount(() => {
  void closeDragonCliSessions()
  unlistenFile?.()
  unlistenClose?.()
})
</script>

<template>
  <main v-if="ready" class="dragoncore-tools-window" :class="{ 'is-cli-open': cliOpen }">
    <PreviewPane />
    <button
      class="dragoncore-cli-toggle"
      type="button"
      :title="cliOpen ? '收起 CLI' : '展开 CLI'"
      :aria-label="cliOpen ? '收起 CLI' : '展开 CLI'"
      @click="cliOpen = !cliOpen"
    >
      <PanelRightClose v-if="cliOpen" :size="16" />
      <PanelRightOpen v-else :size="16" />
    </button>
    <TerminalPane v-if="cliOpen" mode="cli" scope="dragon" :cwd="store.workspace?.rootPath ?? ''" />
  </main>
</template>

<style scoped>
.dragoncore-tools-window {
  width: 100vw;
  height: 100vh;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  background: var(--color-bg-primary);
}

.dragoncore-tools-window.is-cli-open {
  grid-template-columns: minmax(0, 3fr) minmax(360px, 2fr);
}

.dragoncore-cli-toggle {
  position: absolute;
  z-index: 2;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
}

.dragoncore-cli-toggle:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-hover);
}

.dragoncore-tools-window :deep(.panel) {
  min-width: 0;
  min-height: 0;
  border-radius: 0;
}

.dragoncore-tools-window :deep(.terminal-panel) {
  border-width: 0 0 0 1px;
}
</style>
