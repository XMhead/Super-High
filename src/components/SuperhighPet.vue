<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Gauge, Grip, LayoutPanelTop, ListTree, Map, Minus, Plus, RefreshCw, Volume2, VolumeX, X } from 'lucide-vue-next'
import idleImage from '@/assets/superhigh-pet-idle.png'
import actionImage from '@/assets/superhigh-pet.gif'
import pressSound from '@/assets/superhigh-pet-press.mp3'
import releaseSound from '@/assets/superhigh-pet-release.mp3'
import { backend, isTauri, type CodexOfficialUsageResult, type CodexOfficialUsageWindow } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const visible = ref(true)
const expanded = ref(false)
const balanceLoading = ref(false)
const balanceError = ref('')
const balance = ref<number | null>(null)
const officialLoading = ref(false)
const officialError = ref('')
const officialUsage = ref<CodexOfficialUsageResult | null>(null)
const officialStale = ref(false)
const position = ref({ left: 8, top: 8 })
const size = ref(116)
const interacting = ref(false)
const soundEnabled = ref(true)
const drag = ref<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
const resizing = ref<{ pointerId: number; x: number; y: number; size: number } | null>(null)
const panelElement = ref<HTMLElement | null>(null)
const layoutVersion = ref(0)
let actionTimer: number | null = null
let officialRefreshTimer: number | null = null
let officialFailureCount = 0
let previewObserver: ResizeObserver | null = null
let suppressDraggedClick = false

const POSITION_STORAGE_KEY = 'superhigh-pet-position-v2'
const TRANSFER_BALANCE_ENABLED = false
const OFFICIAL_REFRESH_INTERVAL = 300_000
const OFFICIAL_RETRY_DELAYS = [300_000]

const petStyle = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${size.value}px`, height: `${size.value}px` }))
const previewBounds = computed(() => {
  layoutVersion.value
  const preview = document.querySelector<HTMLElement>('.shared-preview-panel')
  const rect = preview?.getBoundingClientRect()
  if (rect && rect.width > 0 && rect.height > 0) return rect
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
})
const panelWidth = computed(() => Math.min(Math.max(260, size.value * 2.05), Math.max(1, previewBounds.value.width - 16)))
const panelMaxHeight = computed(() => Math.max(1, previewBounds.value.height - size.value - 20))
const panelStyle = computed(() => ({ width: `${panelWidth.value}px`, maxHeight: `${panelMaxHeight.value}px` }))
const loading = computed(() => balanceLoading.value || officialLoading.value)
const officialWindows = computed(() => {
  if (!officialUsage.value) return []
  const windows: Array<{ key: string; label: string; value: CodexOfficialUsageWindow }> = []
  if (officialUsage.value.primaryWindow) {
    windows.push({ key: 'primary', label: formatWindowLabel(officialUsage.value.primaryWindow, '主额度'), value: officialUsage.value.primaryWindow })
  }
  if (officialUsage.value.secondaryWindow) {
    windows.push({ key: 'secondary', label: formatWindowLabel(officialUsage.value.secondaryWindow, '次额度'), value: officialUsage.value.secondaryWindow })
  }
  return windows
})

function clampPosition(left: number, top: number) {
  const bounds = previewBounds.value
  const minLeft = bounds.left + 8
  const maxLeft = expanded.value
    ? Math.max(minLeft, bounds.right - panelWidth.value - 8)
    : Math.max(minLeft, bounds.right - size.value - 8)
  const panelHeight = panelElement.value?.offsetHeight ?? 134
  const minTop = expanded.value
    ? bounds.top + Math.min(panelHeight, panelMaxHeight.value) - 4
    : bounds.top + 8
  const maxTop = Math.max(minTop, bounds.bottom - size.value - 8)
  position.value = {
    left: Math.max(minLeft, Math.min(maxLeft, left)),
    top: Math.max(minTop, Math.min(maxTop, top)),
  }
}
function positionAtPreviewBottomLeft() {
  const bounds = previewBounds.value
  clampPosition(bounds.left + 8, bounds.bottom - size.value - 8)
}
function playSound(source: string) {
  if (!soundEnabled.value) return
  const audio = new Audio(source)
  audio.volume = 0.42
  void audio.play().catch(() => undefined)
}
function reactToTouch() {
  if (actionTimer !== null) window.clearTimeout(actionTimer)
  interacting.value = true
  playSound(pressSound)
  actionTimer = window.setTimeout(() => {
    interacting.value = false
    playSound(releaseSound)
    actionTimer = null
  }, 1850)
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, .superhigh-pet-grip')) return
  drag.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: position.value.left, top: position.value.top, moved: false }
}
function startResize(event: PointerEvent) {
  event.preventDefault()
  event.stopPropagation()
  resizing.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, size: size.value }
}
function handlePointerMove(event: PointerEvent) {
  if (drag.value?.pointerId === event.pointerId) {
    const dx = event.clientX - drag.value.x
    const dy = event.clientY - drag.value.y
    if (dx * dx + dy * dy > 16) {
      drag.value.moved = true
      event.preventDefault()
    }
    clampPosition(drag.value.left + dx, drag.value.top + dy)
  }
  if (resizing.value?.pointerId === event.pointerId) {
    size.value = Math.max(88, Math.min(190, resizing.value.size + Math.max(event.clientX - resizing.value.x, event.clientY - resizing.value.y)))
    clampPosition(position.value.left, position.value.top)
  }
}
function handlePointerUp(event: PointerEvent) {
  if (drag.value?.pointerId === event.pointerId) {
    const wasClick = !drag.value.moved
    suppressDraggedClick = !wasClick
    if (!wasClick) window.setTimeout(() => { suppressDraggedClick = false }, 0)
    drag.value = null
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position.value))
    if (wasClick && !(event.target as HTMLElement).closest('.superhigh-pet-panel')) {
      reactToTouch()
    }
  }
  if (resizing.value?.pointerId === event.pointerId) {
    resizing.value = null
    localStorage.setItem('superhigh-pet-size', String(size.value))
  }
}
async function openExpanded() {
  expanded.value = true
  await nextTick()
  clampPosition(position.value.left, position.value.top)
  void refreshOfficialUsage()
}
function closeExpanded() { expanded.value = false; clampPosition(position.value.left, position.value.top) }
function handleContextMenu(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('.superhigh-pet-panel')) return
  event.preventDefault()
  if (expanded.value) closeExpanded()
  else void openExpanded()
}
function handleClickCapture(event: MouseEvent) {
  if (!suppressDraggedClick) return
  suppressDraggedClick = false
  event.preventDefault()
  event.stopPropagation()
}
function adjustSize(delta: number) {
  size.value = Math.max(88, Math.min(190, size.value + delta))
  clampPosition(position.value.left, position.value.top)
  localStorage.setItem('superhigh-pet-size', String(size.value))
}
function toggleSound() {
  soundEnabled.value = !soundEnabled.value
  localStorage.setItem('superhigh-pet-sound', soundEnabled.value ? 'on' : 'off')
}
function setMultiTerminalMode(event: Event) {
  store.setWorkspaceSurface('project')
  store.setMultiTerminalMode((event.target as HTMLInputElement).checked)
}
function setDialogueMapMode(event: Event) {
  store.setWorkspaceSurface('project')
  store.setDialogueMapMode((event.target as HTMLInputElement).checked)
}
function setYamlKeyValuePanelEnabled(event: Event) {
  void store.setYamlKeyValuePanelEnabled((event.target as HTMLInputElement).checked)
}
function formatBalance(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value)
}
function formatPlanType(value: string) {
  if (!value) return 'ChatGPT'
  return value.charAt(0).toUpperCase() + value.slice(1)
}
function formatWindowLabel(window: CodexOfficialUsageWindow, fallback: string) {
  const seconds = window.limitWindowSeconds
  if (!seconds) return fallback
  if (seconds >= 4 * 3600 && seconds <= 6 * 3600) return `${Math.round(seconds / 3600)} 小时额度`
  if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return '周额度'
  if (seconds < 86400) return `${Math.max(1, Math.round(seconds / 3600))} 小时额度`
  return `${Math.max(1, Math.round(seconds / 86400))} 天额度`
}
function remainingPercent(window: CodexOfficialUsageWindow) {
  return Math.max(0, Math.min(100, 100 - window.usedPercent))
}
function formatResetTime(window: CodexOfficialUsageWindow) {
  if (window.resetAt) {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(window.resetAt * 1000))
  }
  if (window.resetAfterSeconds !== null) {
    const minutes = Math.max(1, Math.ceil(window.resetAfterSeconds / 60))
    if (minutes < 60) return `${minutes} 分钟后`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟后` : `${hours} 小时后`
  }
  return '等待官方更新'
}
function clearOfficialRefreshTimer() {
  if (officialRefreshTimer !== null) {
    window.clearTimeout(officialRefreshTimer)
    officialRefreshTimer = null
  }
}
function scheduleOfficialRefresh() {
  clearOfficialRefreshTimer()
  if (document.hidden) return
  const delay = officialFailureCount > 0
    ? OFFICIAL_RETRY_DELAYS[Math.min(officialFailureCount - 1, OFFICIAL_RETRY_DELAYS.length - 1)]
    : OFFICIAL_REFRESH_INTERVAL
  officialRefreshTimer = window.setTimeout(() => { void refreshOfficialUsage() }, delay)
}
async function refreshBalance() {
  if (balanceLoading.value || !isTauri()) return
  balanceLoading.value = true; balanceError.value = ''
  try {
    const result = await backend.queryCodexBalance()
    if (!result.ok) { balanceError.value = result.error || '查询失败'; return }
    if (result.balance === null) { balanceError.value = '余额响应缺少金额'; return }
    balance.value = result.balance
  } catch (value) { balanceError.value = value instanceof Error ? value.message : String(value) }
  finally { balanceLoading.value = false }
}
async function refreshOfficialUsage() {
  if (officialLoading.value || !isTauri()) return
  clearOfficialRefreshTimer()
  officialLoading.value = true
  officialError.value = ''
  try {
    const result = await backend.queryCodexOfficialUsage()
    if (!result.ok) {
      officialFailureCount += 1
      officialStale.value = officialUsage.value !== null
      officialError.value = result.error || 'Codex 官方额度查询失败'
      return
    }
    officialUsage.value = result
    officialStale.value = false
    officialFailureCount = 0
  } catch (value) {
    officialFailureCount += 1
    officialStale.value = officialUsage.value !== null
    officialError.value = value instanceof Error ? value.message : String(value)
  } finally {
    officialLoading.value = false
    scheduleOfficialRefresh()
  }
}
function refreshAll() {
  if (TRANSFER_BALANCE_ENABLED) void refreshBalance()
  void refreshOfficialUsage()
}
function handleVisibilityChange() {
  if (document.hidden) clearOfficialRefreshTimer()
  else void refreshOfficialUsage()
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === '`' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault(); visible.value = !visible.value
  }
}
function handleResize() { layoutVersion.value += 1; clampPosition(position.value.left, position.value.top) }
function observePreviewBounds() {
  previewObserver?.disconnect()
  const preview = document.querySelector<HTMLElement>('.shared-preview-panel')
  if (!preview || !window.ResizeObserver) return
  previewObserver = new ResizeObserver(() => {
    layoutVersion.value += 1
    clampPosition(position.value.left, position.value.top)
  })
  previewObserver.observe(preview)
}

onMounted(() => {
  let hasSavedPosition = false
  try {
    const savedPosition = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) || 'null')
    const savedSize = Number(localStorage.getItem('superhigh-pet-size'))
    if (Number.isFinite(savedSize) && savedSize >= 88) size.value = Math.min(190, savedSize)
    soundEnabled.value = localStorage.getItem('superhigh-pet-sound') !== 'off'
    if (savedPosition && Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.top)) {
      position.value = savedPosition
      hasSavedPosition = true
    }
  } catch { /* ignore malformed local UI state */ }
  void nextTick(() => {
    observePreviewBounds()
    if (!hasSavedPosition) positionAtPreviewBottomLeft()
    else clampPosition(position.value.left, position.value.top)
  })
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('resize', handleResize)
  window.addEventListener('pointermove', handlePointerMove, true)
  window.addEventListener('pointerup', handlePointerUp, true)
  window.addEventListener('pointercancel', handlePointerUp, true)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  refreshAll()
})
onBeforeUnmount(() => {
  if (actionTimer !== null) window.clearTimeout(actionTimer)
  clearOfficialRefreshTimer()
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('pointermove', handlePointerMove, true)
  window.removeEventListener('pointerup', handlePointerUp, true)
  window.removeEventListener('pointercancel', handlePointerUp, true)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  previewObserver?.disconnect()
})
</script>

<template>
  <div v-if="visible" class="superhigh-pet" :class="{ dragging: !!drag, expanded, interacting }" :style="petStyle" @pointerdown="startDrag" @contextmenu="handleContextMenu" @click.capture="handleClickCapture">
    <section v-if="expanded" ref="panelElement" class="script-tools-window superhigh-pet-panel" :style="panelStyle" aria-label="Super High 管家">
      <header class="script-tools-titlebar">
        <strong>Super High 管家</strong>
        <div class="script-tool-actions">
          <button type="button" title="刷新官方额度" :disabled="loading" @click="refreshAll"><RefreshCw :size="14" :class="{ spinning: loading }" /></button>
          <button type="button" :title="soundEnabled ? '关闭音效' : '开启音效'" @click="toggleSound"><Volume2 v-if="soundEnabled" :size="14" /><VolumeX v-else :size="14" /></button>
          <button type="button" title="缩小宠物" @click="adjustSize(-10)"><Minus :size="14" /></button>
          <button type="button" title="放大宠物" @click="adjustSize(10)"><Plus :size="14" /></button>
          <button type="button" title="收起管家" @click="closeExpanded"><X :size="14" /></button>
        </div>
      </header>
      <div class="script-tools-body superhigh-pet-panel-body">
        <section class="script-tool-list">
          <article class="script-tool-card superhigh-pet-official-card">
            <div class="superhigh-pet-card-heading">
              <span class="superhigh-pet-mode-label">
                <Gauge :size="15" />
                <span>Codex 官方额度</span>
              </span>
              <span v-if="officialUsage" class="superhigh-pet-plan">{{ formatPlanType(officialUsage.planType) }}</span>
            </div>
            <div v-if="!officialUsage && officialLoading" class="superhigh-pet-muted">正在读取官方额度...</div>
            <div v-else-if="!officialUsage && officialError" class="superhigh-pet-error">{{ officialError }}</div>
            <div v-else-if="officialUsage" class="superhigh-pet-usage-list">
              <div v-for="window in officialWindows" :key="window.key" class="superhigh-pet-usage-row">
                <div class="superhigh-pet-usage-summary">
                  <span>{{ window.label }}</span>
                  <strong>{{ Math.round(remainingPercent(window.value)) }}% 可用</strong>
                </div>
                <div class="superhigh-pet-usage-track" aria-hidden="true">
                  <span :style="{ width: `${remainingPercent(window.value)}%` }" />
                </div>
                <div class="superhigh-pet-usage-reset">{{ formatResetTime(window.value) }} 重置</div>
              </div>
              <div v-if="officialUsage.resetCreditsAvailable !== null" class="superhigh-pet-reset-credit">
                可用重置次数: {{ officialUsage.resetCreditsAvailable }}
              </div>
              <div v-if="officialLoading" class="superhigh-pet-muted">正在更新...</div>
              <div v-if="officialError" class="superhigh-pet-refresh-error">
                {{ officialStale ? `显示上次结果 · ${officialError}` : officialError }}
              </div>
            </div>
            <div v-else class="superhigh-pet-muted">暂时没有可显示的官方额度</div>
          </article>
          <article v-if="TRANSFER_BALANCE_ENABLED" class="script-tool-card superhigh-pet-balance-card">
            <div v-if="balanceLoading" class="superhigh-pet-muted">正在读取渠道余额...</div>
            <div v-else-if="balanceError" class="superhigh-pet-error">{{ balanceError }}</div>
            <div v-else-if="balance !== null" class="superhigh-pet-mode-label superhigh-pet-balance-value">
              <LayoutPanelTop :size="15" />
              <span>渠道余额:<span class="superhigh-pet-balance-amount">{{ formatBalance(balance) }}元</span></span>
            </div>
            <div v-else class="superhigh-pet-muted">暂时没有可显示的渠道余额</div>
          </article>
          <label class="script-tool-card superhigh-pet-mode-toggle">
            <span class="superhigh-pet-mode-label">
              <LayoutPanelTop :size="15" />
              <span>多终端对话</span>
            </span>
            <input
              type="checkbox"
              :checked="store.settings.multiTerminalMode"
              @change="setMultiTerminalMode"
            >
          </label>
          <label class="script-tool-card superhigh-pet-mode-toggle">
            <span class="superhigh-pet-mode-label">
              <Map :size="15" />
              <span>对话管理</span>
            </span>
            <input
              type="checkbox"
              :checked="store.settings.dialogueMapMode"
              @change="setDialogueMapMode"
            >
          </label>
          <label class="script-tool-card superhigh-pet-mode-toggle">
            <span class="superhigh-pet-mode-label">
              <ListTree :size="15" />
              <span>YAML 键值显示</span>
            </span>
            <input
              type="checkbox"
              :checked="store.settings.yamlKeyValuePanelEnabled"
              @change="setYamlKeyValuePanelEnabled"
            >
          </label>
        </section>
      </div>
    </section>
    <img v-if="interacting" class="superhigh-pet-image" :src="actionImage" alt="Super High 宠物互动" draggable="false">
    <img v-else class="superhigh-pet-image" :src="idleImage" alt="Super High 宠物" draggable="false">
    <div v-if="!expanded" class="superhigh-pet-hint">`</div>
    <Grip class="superhigh-pet-grip" :size="14" title="调整宠物尺寸" @pointerdown="startResize" />
  </div>
</template>
