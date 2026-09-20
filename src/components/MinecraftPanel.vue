<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { Box, Play, RotateCcw, Square } from 'lucide-vue-next'

import { useWorkspaceStore } from '@/stores/workspace'
import type { MinecraftEmbedRect } from '@/types'

const store = useWorkspaceStore()
const viewport = ref<HTMLElement | null>(null)
const operationError = ref('')
const hadEmbedded = ref(false)
const autoAttachStarted = ref(false)
let resizeObserver: ResizeObserver | null = null
let nativeWindowHidden = false
let activatedOnce = false
let surfaceActive = true
let activationGeneration = 0
let hidePromise: Promise<void> | null = null
const START_STATUS_POLL_INTERVAL_MS = 1000
const VIEWPORT_RECT_RETRY_COUNT = 12

const embedded = computed(() => store.minecraftClientStatus?.embedded === true)
const statusMessage = computed(() => {
  if (operationError.value) return operationError.value
  if (store.minecraftClientConfigError) return store.minecraftClientConfigError
  const status = store.minecraftClientStatus
  if (!status?.message) return ''
  return ['timeout', 'missing-config', 'error'].includes(status.state) ? status.message : ''
})

function rectForViewport(): MinecraftEmbedRect | null {
  const element = viewport.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  }
}

function rectIsPositive(rect: MinecraftEmbedRect | null): rect is MinecraftEmbedRect {
  return !!rect && rect.width > 0 && rect.height > 0
}

async function waitForViewportRect(): Promise<MinecraftEmbedRect | null> {
  for (let attempt = 0; attempt < VIEWPORT_RECT_RETRY_COUNT; attempt += 1) {
    const rect = rectForViewport()
    if (rectIsPositive(rect)) return rect
    await nextTick()
  }
  return null
}

function isCurrentActivation(generation: number) {
  return surfaceActive && generation === activationGeneration
}

async function startClient() {
  const generation = activationGeneration
  operationError.value = ''
  try {
    await store.startMinecraftClient()
    await waitForAttachableClient()
    return await embedClient(generation)
  } catch (error) {
    operationError.value = formatOperationError(error)
  }
}

async function embedClient(generation = activationGeneration) {
  const rect = await waitForViewportRect()
  if (!isCurrentActivation(generation)) return
  if (!rect) {
    operationError.value = 'Minecraft 嵌入区域尚未完成布局'
    return
  }
  operationError.value = ''
  try {
    nativeWindowHidden = false
    await store.embedMinecraftClient(rect)
    if (!surfaceActive) {
      await hideEmbeddedClient(true)
      return
    }
    if (!isCurrentActivation(generation)) return
    await reportResize(generation)
  } catch (error) {
    operationError.value = formatOperationError(error)
    throw error
  }
}

async function releaseClient() {
  operationError.value = ''
  try {
    await store.releaseMinecraftClient()
    hadEmbedded.value = false
  } catch (error) {
    operationError.value = formatOperationError(error)
  }
}

async function reportResize(generation = activationGeneration) {
  const rect = rectForViewport()
  if (!isCurrentActivation(generation) || !rectIsPositive(rect) || !embedded.value) return
  try {
    nativeWindowHidden = false
    await store.resizeMinecraftClient(rect)
    if (!surfaceActive) await hideEmbeddedClient(true)
  } catch (error) {
    operationError.value = formatOperationError(error)
  }
}

function formatOperationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function observeViewport() {
  if (!viewport.value || resizeObserver || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    void reportResize()
  })
  resizeObserver.observe(viewport.value)
}

function stopObservingViewport() {
  resizeObserver?.disconnect()
  resizeObserver = null
}

async function hideEmbeddedClient(force = false) {
  if (hidePromise) {
    await hidePromise
    return
  }
  if (nativeWindowHidden && !force) return
  nativeWindowHidden = true
  const pendingHide = store.hideMinecraftClient()
    .catch(() => {
      nativeWindowHidden = false
    })
    .finally(() => {
      hidePromise = null
    })
  hidePromise = pendingHide
  await pendingHide
}

async function restoreEmbeddedClient(generation: number) {
  if (hidePromise) await hidePromise
  if (!isCurrentActivation(generation) || !hadEmbedded.value || !nativeWindowHidden || store.minecraftClientBusy) return
  try {
    nativeWindowHidden = false
    await store.showMinecraftClient()
    if (!surfaceActive) {
      await hideEmbeddedClient(true)
      return
    }
    if (!isCurrentActivation(generation)) return
    await reportResize(generation)
  } catch {
    // Keep the window hidden so the next activation can retry.
  }
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isAttachableStatus() {
  return store.minecraftClientStatus?.embedded === true || store.minecraftClientStatus?.state === 'running'
}

async function waitForAttachableClient() {
  if (isAttachableStatus()) return
  const timeoutMs = Math.max(START_STATUS_POLL_INTERVAL_MS, store.minecraftClientConfig?.startupTimeoutMs ?? START_STATUS_POLL_INTERVAL_MS)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = await store.refreshMinecraftClientStatus()
    if (status.embedded || status.state === 'running') return
    if (status.state === 'error') throw new Error(status.message || 'Minecraft 启动失败')
    await delay(START_STATUS_POLL_INTERVAL_MS)
  }
  throw new Error('Minecraft 启动后没有找到可嵌入的最终游戏窗口')
}

async function autoAttachClient() {
  const generation = activationGeneration
  if (autoAttachStarted.value || store.minecraftClientBusy || store.minecraftClientConfigError || store.dragonCoreModeOpen) return
  autoAttachStarted.value = true
  operationError.value = ''
  try {
    const status = await store.refreshMinecraftClientStatus()
    if (!isCurrentActivation(generation)) return
    if (status.embedded || status.state === 'running') {
      await nextTick()
      await embedClient(generation)
      return
    }
    if (status.state === 'starting') {
      await waitForAttachableClient()
      await embedClient(generation)
      return
    }
    if (status.state === 'ready') {
      await startClient()
    }
  } catch (error) {
    operationError.value = formatOperationError(error)
  }
}

watch(embedded, async (isEmbedded) => {
  if (isEmbedded) {
    hadEmbedded.value = true
    const generation = activationGeneration
    await nextTick()
    await reportResize(generation)
  }
}, { immediate: true })

onMounted(() => {
  observeViewport()
  void nextTick().then(autoAttachClient)
})

onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  surfaceActive = true
  activationGeneration += 1
  const generation = activationGeneration
  observeViewport()
  void nextTick().then(() => restoreEmbeddedClient(generation))
})

onDeactivated(() => {
  surfaceActive = false
  activationGeneration += 1
  stopObservingViewport()
  void hideEmbeddedClient(true)
})

onBeforeUnmount(() => {
  surfaceActive = false
  activationGeneration += 1
  stopObservingViewport()
  void hideEmbeddedClient(true)
})
</script>

<template>
  <section class="minecraft-workspace-panel">
    <header class="minecraft-panel-header">
      <div>
        <strong>{{ store.minecraftClientConfig?.displayName || 'Minecraft' }}</strong>
        <span v-if="store.minecraftClientStatus?.windowTitle">{{ store.minecraftClientStatus.windowTitle }}</span>
      </div>
      <div class="minecraft-panel-actions">
        <button v-if="store.dragonCoreAvailable" data-testid="dragoncore-mode" title="DragonCore 模式" @click="store.toggleDragonCoreMode()">
          <Box :size="15" />
        </button>
        <button data-testid="minecraft-start" title="启动 Minecraft" :disabled="store.minecraftClientBusy" @click="startClient">
          <Play :size="15" />
        </button>
        <button data-testid="minecraft-embed" title="嵌入或重试" :disabled="store.minecraftClientBusy" @click="embedClient()">
          <Box :size="15" />
        </button>
        <button data-testid="minecraft-release" title="释放窗口" :disabled="store.minecraftClientBusy || !embedded" @click="releaseClient">
          <Square :size="15" />
        </button>
        <button data-testid="minecraft-retry" title="重新读取配置" :disabled="store.minecraftClientBusy" @click="store.loadMinecraftClientConfig()">
          <RotateCcw :size="15" />
        </button>
      </div>
    </header>
    <p v-if="statusMessage" class="minecraft-panel-status">{{ statusMessage }}</p>
    <div ref="viewport" class="minecraft-game-viewport" />
  </section>
</template>
