<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, Image, RefreshCw, RotateCcw, Save, Search, Send, SlidersHorizontal, Trash2, Type, UserRound, X } from 'lucide-vue-next'

import { applyItemSearchPhrases } from '@/lib/itemSearchPhrases'
import { loadProjectItemLibraryMainSource } from '@/lib/itemLibraryConfig'
import { buildItemYamlPreviewLines } from '@/lib/itemYamlPreview'
import { replaceItemYamlBlockInFile } from '@/lib/itemYamlBlockEdit'
import { backend, onWorkspaceFilesChanged } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type {
  ItemLibrarySearchItem,
  ItemLibrarySearchResult,
  ItemLibrarySource,
  ItemSearchPhraseHistoryEntry,
  ItemSearchPhraseRule,
  DragonCoreFontImage,
} from '@/types'

const DEFAULT_WIDTH = 1120
const DEFAULT_HEIGHT = 760
const MIN_WIDTH = 640
const MIN_HEIGHT = 560
const PAGE_SIZE = 9
const RESULT_COLUMNS = 3
const YAML_EDITOR_MAX_VISIBLE_LINES = 20
const RESIZE_HANDLES = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const

type ResizeHandle = typeof RESIZE_HANDLES[number]
type DragState = {
  mode: 'move' | 'resize'
  handle?: ResizeHandle
  pointerId: number
  x: number
  y: number
  left: number
  top: number
  width: number
  height: number
}

type SendPanelMode = 'admin' | 'player'
type SendPanelState = {
  item: ItemLibrarySearchItem
  mode: SendPanelMode
  left: number
  top: number
}
type ItemPanelNameSegment = {
  text: string
  color?: string
}

const MINECRAFT_LEGACY_COLORS: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
}

const store = useWorkspaceStore()
const source = ref<ItemLibrarySource>('ni')
const query = ref('')
const response = ref<ItemLibrarySearchResult | null>(null)
const itemKeys = ref<string[]>([])
const itemKeysSource = ref<ItemLibrarySource | null>(null)
const itemIndexInvalidated = ref(false)
const loading = ref(false)
const error = ref('')
const currentPage = ref(1)
const pageJumpInput = ref('1')
const itemDrafts = ref<Record<string, string>>({})
const itemSaveErrors = ref<Record<string, string>>({})
const itemSaving = ref<Record<string, boolean>>({})
const itemSending = ref<Record<string, boolean>>({})
const itemCursorLines = ref<Record<string, number>>({})
const sendPanel = ref<SendPanelState | null>(null)
const sendAmount = ref('1')
const onlinePlayers = ref<string[]>([])
const onlinePlayersLoading = ref(false)
const onlinePlayersError = ref('')
const playerQuery = ref('')
const selectedPlayer = ref('')
const phrasePanelOpen = ref(false)
const dragonCorePanelOpen = ref(false)
const dragonCoreFontRenderEnabled = ref(false)
const newPhrase = ref('')
const newValue = ref('')
const dragonCorePathDraft = ref('')
const bodyRef = ref<HTMLElement | null>(null)
const drag = ref<DragState | null>(null)
const rect = ref(defaultRect())
const lastSearchSignature = ref('')

let searchTimer: number | null = null
let searchToken = 0
let onlinePlayersRequestToken = 0
let stopWorkspaceFilesChanged: (() => void) | null = null

const phraseSignature = computed(() => (
  (store.settings.itemSearchPhrases ?? [])
    .map((rule) => `${rule.id}:${rule.phrase}:${rule.value}`)
    .join('\n')
))
const expandedQuery = computed(() => {
  const expanded = applyItemSearchPhrases(query.value, store.settings.itemSearchPhrases ?? [])
  const cleanExpanded = expanded.trim()
  const cleanQuery = query.value.trim()
  return cleanExpanded && cleanExpanded !== cleanQuery ? cleanExpanded : undefined
})
const items = computed(() => response.value?.items ?? [])
const ignoredPathCount = computed(() => Math.max(0, Number(response.value?.ignoredPathCount ?? 0) || 0))
const hasDragonCoreFontImages = computed(() => items.value.some((item) => (item.dragonCoreFontImages?.length ?? 0) > 0))
const dialogSubtitleText = computed(() => {
  if (loading.value) return `${sourceTitle.value} · 搜索中`
  if (response.value) {
    const parts = [`${sourceTitle.value} · ${response.value.totalItems ?? items.value.length} 项`]
    if (ignoredPathCount.value > 0) parts.push(`已屏蔽 ${ignoredPathCount.value} 个路径`)
    return parts.join(' · ')
  }
  if (error.value) return `${sourceTitle.value} · ${error.value}`
  return sourceTitle.value
})
const dialogStatusTitle = computed(() => {
  const lines: string[] = []
  if (workspaceTitle.value) lines.push(workspaceTitle.value)
  const libraryRoot = response.value?.libraryRootPath
  if (libraryRoot) lines.push(`物品库：${libraryRoot}`)
  if (ignoredPathCount.value > 0) {
    const configPath = response.value?.ignoreConfigPath
    lines.push(configPath
      ? `屏蔽配置：${configPath}`
      : `已按 .superhigh/item-library-ignore.yml 屏蔽 ${ignoredPathCount.value} 个路径`)
  }
  return lines.join('\n')
})
const totalPages = computed(() => Math.max(1, Math.ceil((response.value?.totalItems ?? items.value.length) / PAGE_SIZE)))
const visibleItems = computed(() => items.value)
const pageStatusText = computed(() => `${currentPage.value} / ${totalPages.value}`)
const dialogStyle = computed(() => ({
  left: `${rect.value.left}px`,
  top: `${rect.value.top}px`,
  width: `${rect.value.width}px`,
  height: `${rect.value.height}px`,
}))
const canGoPreviousPage = computed(() => currentPage.value > 1)
const canGoNextPage = computed(() => currentPage.value < totalPages.value)
const sourceTitle = computed(() => source.value === 'ni' ? 'NeigeItems' : 'MythicMobs')
const workspaceTitle = computed(() => store.workspace?.rootPath ?? '未打开工作区')
const dragonCoreClientRootPath = computed(() => (store.settings.dragonCoreClientRootPath ?? '').trim())
const sendAmountValue = computed(() => {
  const value = String(sendAmount.value ?? '').trim()
  if (!/^\d+$/.test(value)) return null
  const amount = Number(value)
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= 4_294_967_295 ? amount : null
})
const filteredOnlinePlayers = computed(() => {
  const query = playerQuery.value.trim().toLocaleLowerCase()
  if (!query) return onlinePlayers.value
  return onlinePlayers.value.filter((player) => player.toLocaleLowerCase().includes(query))
})
const sendPanelStyle = computed(() => {
  if (!sendPanel.value) return {}
  return {
    left: `${sendPanel.value.left}px`,
    top: `${sendPanel.value.top}px`,
  }
})
const sendPanelCanSubmit = computed(() => {
  if (!sendPanel.value || !sendAmountValue.value || onlinePlayersLoading.value) return false
  return sendPanel.value.mode === 'admin' || Boolean(selectedPlayer.value)
})

function defaultRect() {
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 32))
  const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 96))
  return {
    left: Math.max(16, Math.round(window.innerWidth / 2 - width / 2)),
    top: Math.max(56, Math.round(window.innerHeight / 2 - height / 2)),
    width,
    height,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function scheduleSearch(delay = 180, forceRefresh = false) {
  if (searchTimer) window.clearTimeout(searchTimer)
  if (!store.itemSearchDialogOpen) return
  if (delay <= 0) {
    void runSearch(1, forceRefresh)
    return
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void runSearch(1, forceRefresh)
  }, delay)
}

function currentSearchSignature(): string | null {
  const projectPath = store.workspace?.rootPath
  if (!projectPath) return null
  return JSON.stringify({
    projectPath,
    source: source.value,
    query: query.value.trim(),
    expandedQuery: expandedQuery.value ?? '',
    dragonCoreClientRootPath: dragonCoreClientRootPath.value || '',
  })
}

function restoreCachedSearch() {
  const result = response.value
  if (!result) return
  loading.value = false
  error.value = ''
  syncItemDrafts(result.items)
  currentPage.value = result.page ?? 1
  pageJumpInput.value = String(currentPage.value)
  void nextTick(() => {
    scrollBodyToTop()
  })
}

async function runSearch(page = 1, forceRefresh = false) {
  const projectPath = store.workspace?.rootPath
  if (!projectPath) {
    response.value = null
    error.value = '未打开工作区'
    return
  }
  const signature = currentSearchSignature() ?? ''
  const token = ++searchToken
  loading.value = true
  error.value = ''
  try {
    const result = await backend.searchItemLibrary(
      projectPath,
      source.value,
      query.value.trim(),
      expandedQuery.value,
      dragonCoreClientRootPath.value || undefined,
      page,
      PAGE_SIZE,
      forceRefresh,
    )
    if (token !== searchToken) return
    const keyResult = (forceRefresh || itemKeysSource.value !== source.value)
      ? await backend.itemLibraryKeys(projectPath, source.value)
      : null
    if (token !== searchToken) return
    response.value = result
    if (keyResult) {
      itemKeys.value = keyResult.itemKeys
      itemKeysSource.value = source.value
    }
    if (forceRefresh) itemIndexInvalidated.value = false
    lastSearchSignature.value = signature
    syncItemDrafts(result.items)
    currentPage.value = result.page ?? page
    pageJumpInput.value = String(currentPage.value)
    await nextTick()
    scrollBodyToTop()
  } catch (searchError) {
    if (token !== searchToken) return
    response.value = null
    error.value = formatError(searchError)
  } finally {
    if (token === searchToken) loading.value = false
  }
}

function setSource(next: ItemLibrarySource) {
  if (source.value === next) return
  source.value = next
  itemKeys.value = []
  itemKeysSource.value = null
  scheduleSearch(0, true)
}

function syncItemDrafts(nextItems: ItemLibrarySearchItem[]) {
  itemDrafts.value = Object.fromEntries(nextItems.map((item) => [itemDraftKey(item), item.yamlBlock]))
  itemSaveErrors.value = {}
  itemSaving.value = {}
  itemSending.value = {}
}

function setResultPage(page: number) {
  const nextPage = clamp(page, 1, totalPages.value)
  if (nextPage === currentPage.value) return
  currentPage.value = nextPage
  pageJumpInput.value = String(nextPage)
  void runSearch(nextPage)
}

function applyPageJump() {
  const parsed = Number.parseInt(pageJumpInput.value.trim(), 10)
  if (!Number.isFinite(parsed)) {
    pageJumpInput.value = String(currentPage.value)
    return
  }
  setResultPage(parsed)
}

function completeItemKey(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const typed = query.value.trim().toLocaleLowerCase()
  if (!typed) return
  const match = itemKeys.value.find((key) => key.toLocaleLowerCase().startsWith(typed))
  if (!match || match === query.value) return
  event.preventDefault()
  query.value = match
}

function isItemLibraryChange(path: string) {
  const workspaceRoot = store.workspace?.rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
  if (!workspaceRoot) return false
  const normalizedPath = path.replace(/\\/g, '/').toLocaleLowerCase()
  return [
    `${workspaceRoot}/plugins/neigeitems/items/`,
    `${workspaceRoot}/plugins/mythicmobs/items/`,
  ].some((root) => normalizedPath.startsWith(root))
    || normalizedPath === `${workspaceRoot}/.superhigh/item-library-ignore.yml`
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function onWindowKeydown(event: KeyboardEvent) {
  if (!store.itemSearchDialogOpen) return
  if (event.key === 'Escape' && sendPanel.value) {
    event.preventDefault()
    closeSendPanel()
    return
  }
  if (event.defaultPrevented) return
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (isEditableTarget(event.target)) return
  if (event.key === 'ArrowLeft') {
    if (!canGoPreviousPage.value) return
    event.preventDefault()
    setResultPage(currentPage.value - 1)
    return
  }
  if (event.key === 'ArrowRight') {
    if (!canGoNextPage.value) return
    event.preventDefault()
    setResultPage(currentPage.value + 1)
  }
}

function itemPanelLabel(item: ItemLibrarySearchItem) {
  const display = (item.displayName || '').trim()
  if (display && display !== item.itemKey) return display
  return item.itemKey
}

function itemPanelNameSegments(item: ItemLibrarySearchItem): ItemPanelNameSegment[] {
  const label = itemPanelLabel(item)
  const segments: ItemPanelNameSegment[] = []
  let color: string | undefined
  let plainText = ''

  function flush() {
    if (!plainText) return
    segments.push({ text: plainText, color })
    plainText = ''
  }

  for (let index = 0; index < label.length; index += 1) {
    const prefix = label[index]
    const code = label[index + 1]?.toLowerCase()
    if (prefix !== '&' && prefix !== '§') {
      plainText += prefix
      continue
    }

    if (code === '#') {
      const hex = label.slice(index + 2, index + 8)
      if (/^[0-9a-f]{6}$/i.test(hex)) {
        flush()
        color = `#${hex}`
        index += 7
        continue
      }
    }

    if (code === 'x') {
      const hex = Array.from({ length: 6 }, (_, offset) => label[index + 3 + offset * 2]).join('')
      const validPrefixes = Array.from({ length: 6 }, (_, offset) => label[index + 2 + offset * 2]).every((value) => value === '&' || value === '§')
      if (validPrefixes && /^[0-9a-f]{6}$/i.test(hex)) {
        flush()
        color = `#${hex}`
        index += 13
        continue
      }
    }

    if (code && (code in MINECRAFT_LEGACY_COLORS || 'klmno'.includes(code))) {
      flush()
      if (code in MINECRAFT_LEGACY_COLORS) color = MINECRAFT_LEGACY_COLORS[code]
      index += 1
      continue
    }

    if (code === 'r') {
      flush()
      color = undefined
      index += 1
      continue
    }

    plainText += prefix
  }
  flush()
  return segments
}

function itemPanelPlainLabel(item: ItemLibrarySearchItem) {
  return itemPanelNameSegments(item).map((segment) => segment.text).join('')
}

function scrollBodyToTop() {
  const element = bodyRef.value
  if (!element) return
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top: 0 })
    return
  }
  element.scrollTop = 0
}

async function addPhrase() {
  const added = await store.addItemSearchPhrase(newPhrase.value, newValue.value)
  if (!added) return
  newPhrase.value = ''
  newValue.value = ''
}

async function chooseDragonCorePath() {
  const selected = await store.selectDirectory(dragonCorePathDraft.value || dragonCoreClientRootPath.value || store.workspace?.rootPath)
  if (selected) dragonCorePathDraft.value = selected
}

async function saveDragonCorePath() {
  await store.setDragonCoreClientRootPath(dragonCorePathDraft.value)
  dragonCorePathDraft.value = store.settings.dragonCoreClientRootPath
  store.showActivityMessage('已保存龙核来源路径')
  scheduleSearch(0)
}

function updatePhrase(id: string, key: 'phrase' | 'value', event: Event) {
  const value = (event.target as HTMLInputElement).value
  void store.updateItemSearchPhrase(id, { [key]: value })
}

function dragonCoreIconTitle(item: ItemLibrarySearchItem): string {
  const icon = item.dragonCoreIcon
  if (!icon) return ''
  return `${icon.texture} · ${icon.relativeConfigPath}:${icon.lineNumber}`
}

function dragonCoreEffectTitle(item: ItemLibrarySearchItem): string {
  const effect = item.dragonCoreEffect
  if (!effect) return ''
  return `${effect.matchText} -> ${effect.texture} · ${effect.relativeConfigPath}:${effect.lineNumber}`
}

function dragonCoreFontImageTitle(image: DragonCoreFontImage): string {
  return `${image.character} -> ${image.path} · ${image.relativeConfigPath}:${image.lineNumber}`
}

function dragonCoreFontImageStyle(image: DragonCoreFontImage): Record<string, string> {
  const width = Number.isFinite(image.width) && image.width > 0 ? image.width : 12
  const height = Number.isFinite(image.height) && image.height > 0 ? image.height : 12
  const scale = height > 16 ? 16 / height : 1
  const displayWidth = clamp(width * scale, 1, 240)
  const displayHeight = clamp(height * scale, 1, 18)
  const yOffset = Number(image.yOffset ?? 0)
  const displayOffset = clamp(yOffset * scale, -8, 8)
  const style: Record<string, string> = {
    width: `${displayWidth}px`,
    height: `${displayHeight}px`,
  }
  if (displayOffset) style.transform = `translateY(${displayOffset}px)`
  return style
}

function itemDraftKey(item: ItemLibrarySearchItem): string {
  return `${item.filePath}:${item.lineNumber}:${item.itemKey}`
}

function itemDraft(item: ItemLibrarySearchItem): string {
  return itemDrafts.value[itemDraftKey(item)] ?? item.yamlBlock
}

function itemDirty(item: ItemLibrarySearchItem): boolean {
  return itemDraft(item) !== item.yamlBlock
}

function itemIsSaving(item: ItemLibrarySearchItem): boolean {
  return Boolean(itemSaving.value[itemDraftKey(item)])
}

function itemCanSend(item: ItemLibrarySearchItem): boolean {
  return item.source === 'ni'
}

function itemIsSending(item: ItemLibrarySearchItem): boolean {
  return Boolean(itemSending.value[itemDraftKey(item)])
}

function itemSaveError(item: ItemLibrarySearchItem): string {
  return itemSaveErrors.value[itemDraftKey(item)] ?? ''
}

function yamlPreviewLines(item: ItemLibrarySearchItem) {
  return buildItemYamlPreviewLines(
    itemDraft(item),
    item.dragonCoreFontImages ?? [],
    dragonCoreFontRenderEnabled.value,
  )
}

function itemYamlLineCount(item: ItemLibrarySearchItem): number {
  return Math.max(1, itemDraft(item).split(/\r?\n/).length)
}

function itemYamlVisibleLineCount(item: ItemLibrarySearchItem): number {
  return Math.min(itemYamlLineCount(item), YAML_EDITOR_MAX_VISIBLE_LINES)
}

function itemResultCardStyle(item: ItemLibrarySearchItem): Record<string, string> {
  const lineCount = itemYamlLineCount(item)
  return {
    '--item-yaml-line-count': String(lineCount),
    '--item-yaml-visible-line-count': String(Math.min(lineCount, YAML_EDITOR_MAX_VISIBLE_LINES)),
  }
}

function itemCurrentLine(item: ItemLibrarySearchItem): number {
  return itemCursorLines.value[itemDraftKey(item)] ?? 0
}

function isCurrentLine(item: ItemLibrarySearchItem, lineNumber: number): boolean {
  return itemCurrentLine(item) === lineNumber
}

function updateItemDraft(item: ItemLibrarySearchItem, event: Event) {
  const key = itemDraftKey(item)
  itemDrafts.value = {
    ...itemDrafts.value,
    [key]: (event.target as HTMLTextAreaElement).value,
  }
  if (itemSaveErrors.value[key]) {
    const nextErrors = { ...itemSaveErrors.value }
    delete nextErrors[key]
    itemSaveErrors.value = nextErrors
  }
}

function syncYamlEditorScroll(event: Event) {
  const editor = event.target as HTMLTextAreaElement
  const highlight = editor
    .closest('.item-yaml-editor-surface')
    ?.querySelector<HTMLElement>('.item-yaml-highlight')
  if (!highlight) return
  highlight.scrollTop = editor.scrollTop
  highlight.scrollLeft = editor.scrollLeft
}

function updateCursorLine(item: ItemLibrarySearchItem, event: Event) {
  const editor = event.target as HTMLTextAreaElement
  const text = editor.value
  const cursorPos = editor.selectionStart
  const lines = text.substring(0, cursorPos).split('\n')
  const lineNumber = lines.length
  const key = itemDraftKey(item)
  itemCursorLines.value = {
    ...itemCursorLines.value,
    [key]: lineNumber,
  }
}

function handleTabKey(item: ItemLibrarySearchItem, event: KeyboardEvent) {
  const editor = event.target as HTMLTextAreaElement
  if (event.key !== 'Tab') return
  event.preventDefault()

  const start = editor.selectionStart
  const end = editor.selectionEnd
  const value = editor.value

  // 插入两个空格
  const newValue = value.substring(0, start) + '  ' + value.substring(end)
  const key = itemDraftKey(item)
  itemDrafts.value = {
    ...itemDrafts.value,
    [key]: newValue,
  }

  // 设置新的光标位置
  void nextTick(() => {
    editor.selectionStart = editor.selectionEnd = start + 2
  })
}

function revertItemDraft(item: ItemLibrarySearchItem) {
  const key = itemDraftKey(item)
  itemDrafts.value = {
    ...itemDrafts.value,
    [key]: item.yamlBlock,
  }
  const nextErrors = { ...itemSaveErrors.value }
  delete nextErrors[key]
  itemSaveErrors.value = nextErrors
}

async function saveItemDraft(item: ItemLibrarySearchItem) {
  const key = itemDraftKey(item)
  if (!itemDirty(item) || itemIsSaving(item)) return
  itemSaving.value = { ...itemSaving.value, [key]: true }
  itemSaveErrors.value = { ...itemSaveErrors.value, [key]: '' }
  try {
    const latestContent = await backend.readFile(item.filePath)
    const replaced = replaceItemYamlBlockInFile(latestContent, {
      itemKey: item.itemKey,
      lineNumber: item.lineNumber,
      nextBlock: itemDraft(item),
    })
    await backend.writeFile(item.filePath, replaced.content)
    store.showActivityMessage('已保存物品')
    await runSearch(1, true)
  } catch (saveError) {
    itemSaveErrors.value = {
      ...itemSaveErrors.value,
      [key]: formatError(saveError),
    }
  } finally {
    const nextSaving = { ...itemSaving.value }
    delete nextSaving[key]
    itemSaving.value = nextSaving
  }
}

async function sendItemToPlayer(item: ItemLibrarySearchItem) {
  const projectPath = store.workspace?.rootPath
  if (!projectPath || !itemCanSend(item) || itemIsSending(item)) return
  const key = itemDraftKey(item)
  itemSending.value = { ...itemSending.value, [key]: true }
  try {
    const result = await backend.sendItemToPlayer(projectPath, item.itemKey, 1)
    store.showActivityMessage(`已发送给 ${result.playerName}：${result.itemKey}`)
  } catch (sendError) {
    store.showActivityMessage(`发送物品失败：${formatError(sendError)}`)
  } finally {
    const nextSending = { ...itemSending.value }
    delete nextSending[key]
    itemSending.value = nextSending
  }
}

function sendPanelPosition(trigger: HTMLElement, mode: SendPanelMode) {
  const bounds = trigger.getBoundingClientRect()
  const panelWidth = 320
  const panelHeight = mode === 'player' ? 330 : 190
  const left = clamp(bounds.right - panelWidth, 8, Math.max(8, window.innerWidth - panelWidth - 8))
  const below = bounds.bottom + 6
  const top = below + panelHeight <= window.innerHeight
    ? below
    : Math.max(8, bounds.top - panelHeight - 6)
  return { left, top }
}

function closeSendPanel() {
  sendPanel.value = null
  onlinePlayersRequestToken += 1
}

async function openSendPanel(item: ItemLibrarySearchItem, mode: SendPanelMode, event: MouseEvent) {
  if (!itemCanSend(item) || itemIsSending(item)) return
  const projectPath = store.workspace?.rootPath
  if (!projectPath) return
  const trigger = event.currentTarget as HTMLElement
  sendPanel.value = {
    item,
    mode,
    ...sendPanelPosition(trigger, mode),
  }
  sendAmount.value = '1'
  selectedPlayer.value = ''
  playerQuery.value = ''
  onlinePlayersError.value = ''
  onlinePlayers.value = []
  if (mode !== 'player') return

  onlinePlayersLoading.value = true
  const requestToken = ++onlinePlayersRequestToken
  try {
    const result = await backend.onlinePlayers(projectPath)
    if (requestToken !== onlinePlayersRequestToken || sendPanel.value?.mode !== 'player') return
    onlinePlayers.value = result.players
  } catch (listError) {
    if (requestToken !== onlinePlayersRequestToken) return
    onlinePlayersError.value = formatError(listError)
  } finally {
    if (requestToken === onlinePlayersRequestToken) onlinePlayersLoading.value = false
  }
}

function updatePlayerQuery(event: Event) {
  const value = (event.target as HTMLInputElement).value
  playerQuery.value = value
  if (value !== selectedPlayer.value) selectedPlayer.value = ''
}

function selectOnlinePlayer(player: string) {
  selectedPlayer.value = player
  playerQuery.value = player
}

async function sendItemFromPanel() {
  const panel = sendPanel.value
  const projectPath = store.workspace?.rootPath
  const amount = sendAmountValue.value
  if (!panel || !projectPath || !amount || !sendPanelCanSubmit.value || itemIsSending(panel.item)) return
  const key = itemDraftKey(panel.item)
  itemSending.value = { ...itemSending.value, [key]: true }
  try {
    const result = panel.mode === 'admin'
      ? await backend.sendItemToPlayer(projectPath, panel.item.itemKey, amount)
      : await backend.sendItemToNamedPlayer(projectPath, panel.item.itemKey, selectedPlayer.value, amount)
    store.showActivityMessage(`已发送给 ${result.playerName}：${result.itemKey} ×${result.amount}`)
    closeSendPanel()
  } catch (sendError) {
    store.showActivityMessage(`发送物品失败：${formatError(sendError)}`)
  } finally {
    const nextSending = { ...itemSending.value }
    delete nextSending[key]
    itemSending.value = nextSending
  }
}

function phraseHistoryEntries(rule: ItemSearchPhraseRule): ItemSearchPhraseHistoryEntry[] {
  return [...(rule.history ?? [])].reverse().slice(0, 5)
}

function phraseHistoryText(entry: ItemSearchPhraseHistoryEntry): string {
  const current = `${entry.phrase} → ${entry.value}`
  if (entry.action === 'created') return `创建 ${current}`
  const previous = `${entry.previousPhrase ?? ''} → ${entry.previousValue ?? ''}`.trim()
  return previous ? `${previous} 改为 ${current}` : `修改 ${current}`
}

function phraseHistoryTime(entry: ItemSearchPhraseHistoryEntry): string {
  const date = new Date(entry.createdAt)
  if (Number.isNaN(date.getTime())) return entry.createdAt
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function copyLocation(item: ItemLibrarySearchItem) {
  await copyText(`${item.filePath}:${item.lineNumber}`)
  store.showActivityMessage('已复制物品位置')
}

async function jumpToItem(item: ItemLibrarySearchItem) {
  const targetPath = item.filePath
  store.setWorkspaceSurface('project')
  if (store.settings.activePreviewMode !== 'code') store.setPreviewMode('code')
  await store.openFile(targetPath)
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('superhigh:reveal-editor-position', {
      detail: { path: targetPath, lineNumber: item.lineNumber, column: 1 },
    }))
  }, 100)
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
    throw new Error('clipboard api unavailable')
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

function close() {
  closeSendPanel()
  store.setItemSearchDialogOpen(false)
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!sendPanel.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.item-send-panel, [data-send-panel-trigger]')) return
  closeSendPanel()
}

function refresh() {
  scheduleSearch(0, true)
}

function beginMove(event: PointerEvent) {
  if ((event.target as HTMLElement | null)?.closest('button, input, textarea, select, a, .item-search-resize')) return
  drag.value = {
    mode: 'move',
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    ...rect.value,
  }
  event.preventDefault()
}

function beginResize(event: PointerEvent, handle: ResizeHandle) {
  drag.value = {
    mode: 'resize',
    handle,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    ...rect.value,
  }
  event.preventDefault()
  event.stopPropagation()
}

function onPointerMove(event: PointerEvent) {
  const state = drag.value
  if (!state || state.pointerId !== event.pointerId) return
  const dx = event.clientX - state.x
  const dy = event.clientY - state.y
  if (state.mode === 'move') {
    rect.value = {
      ...rect.value,
      left: clamp(state.left + dx, 0, window.innerWidth - state.width),
      top: clamp(state.top + dy, 0, window.innerHeight - 48),
    }
    return
  }

  const handle = state.handle ?? 'se'
  let left = state.left
  let top = state.top
  let width = state.width
  let height = state.height
  if (handle.includes('e')) width = state.width + dx
  if (handle.includes('s')) height = state.height + dy
  if (handle.includes('w')) {
    width = state.width - dx
    left = state.left + dx
  }
  if (handle.includes('n')) {
    height = state.height - dy
    top = state.top + dy
  }
  width = clamp(width, MIN_WIDTH, window.innerWidth - 8)
  height = clamp(height, MIN_HEIGHT, window.innerHeight - 16)
  left = clamp(left, 0, window.innerWidth - width)
  top = clamp(top, 0, window.innerHeight - 48)
  rect.value = { left, top, width, height }
}

function stopPointerInteraction() {
  drag.value = null
}

function onWindowResize() {
  rect.value = {
    ...rect.value,
    width: Math.min(rect.value.width, window.innerWidth - 8),
    height: Math.min(rect.value.height, window.innerHeight - 16),
    left: clamp(rect.value.left, 0, Math.max(0, window.innerWidth - rect.value.width)),
    top: clamp(rect.value.top, 0, Math.max(0, window.innerHeight - 48)),
  }
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

watch(
  () => store.itemSearchDialogOpen,
  async (open) => {
    if (!open) {
      searchToken++
      loading.value = false
      if (searchTimer) window.clearTimeout(searchTimer)
      searchTimer = null
      closeSendPanel()
      return
    }
    const projectPath = store.workspace?.rootPath
    const configuredSource = projectPath ? await loadProjectItemLibraryMainSource(projectPath) : null
    if (!store.itemSearchDialogOpen || projectPath !== store.workspace?.rootPath) return
    const sources = store.minecraftCapabilities?.itemSources ?? []
    source.value = configuredSource && sources.includes(configuredSource) ? configuredSource : sources[0] ?? 'ni'
    dragonCorePathDraft.value = store.settings.dragonCoreClientRootPath ?? ''
    dragonCorePanelOpen.value = false
    rect.value = defaultRect()
    if (currentSearchSignature() === lastSearchSignature.value && response.value && !itemIndexInvalidated.value) {
      restoreCachedSearch()
      return
    }
    scheduleSearch(0, true)
  },
  { immediate: true },
)

watch(
  [query, phraseSignature, () => store.workspace?.rootPath, dragonCoreClientRootPath],
  () => scheduleSearch(),
)

watch(
  () => store.minecraftCapabilities?.itemSources,
  (sources) => {
    if (!store.itemSearchDialogOpen || !sources?.length || sources.includes(source.value)) return
    source.value = sources[0]!
    scheduleSearch(0, true)
  },
)

watch(
  () => store.settings.dragonCoreClientRootPath,
  (path) => {
    if (!dragonCorePanelOpen.value) dragonCorePathDraft.value = path ?? ''
  },
)

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopPointerInteraction)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('keydown', onWindowKeydown)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  void onWorkspaceFilesChanged((event) => {
    if (!event.changedPaths.some(isItemLibraryChange)) return
    itemIndexInvalidated.value = true
    if (!store.itemSearchDialogOpen) return
    scheduleSearch(180, true)
  }).then((unlisten) => {
    stopWorkspaceFilesChanged = unlisten
  })
})

onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopPointerInteraction)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onWindowKeydown)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  stopWorkspaceFilesChanged?.()
  stopWorkspaceFilesChanged = null
})
</script>

<template>
  <section
    v-if="store.itemSearchDialogOpen && store.itemLibraryAvailable"
    class="item-search-dialog"
    :style="dialogStyle"
    role="dialog"
    aria-label="物品搜索"
  >
    <header class="item-search-header" @pointerdown="beginMove">
      <div class="item-search-heading">
        <div
          class="dialog-subtitle"
          data-testid="item-search-status"
          :title="dialogStatusTitle"
        >{{ dialogSubtitleText }}</div>
      </div>
      <div class="item-search-actions">
        <button class="icon-button" type="button" title="刷新" aria-label="刷新" data-testid="item-search-refresh" @click="refresh">
          <RefreshCw :size="14" />
        </button>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="close">
          <X :size="15" />
        </button>
      </div>
    </header>

    <div class="item-search-toolbar">
      <label class="item-search-input-wrap">
        <Search :size="14" />
        <input
          v-model="query"
          class="app-input item-search-input"
          placeholder="key / Display（Tab 补全真实 key）"
          autocomplete="off"
          @keydown="completeItemKey"
        />
      </label>
      <div v-if="items.length" class="item-page-controls" data-testid="item-page-controls">
        <button
          class="icon-button"
          type="button"
          title="上一页"
          aria-label="上一页"
          data-testid="item-prev-page"
          :disabled="!canGoPreviousPage"
          @click="setResultPage(currentPage - 1)"
        >
          <ChevronLeft :size="14" />
        </button>
        <span class="item-page-status" data-testid="item-page-status">{{ pageStatusText }}</span>
        <button
          class="icon-button"
          type="button"
          title="下一页"
          aria-label="下一页"
          data-testid="item-next-page"
          :disabled="!canGoNextPage"
          @click="setResultPage(currentPage + 1)"
        >
          <ChevronRight :size="14" />
        </button>
        <label class="item-page-jump" title="跳转页数">
          <span>跳转</span>
          <input
            v-model="pageJumpInput"
            class="app-input item-page-jump-input"
            data-testid="item-page-jump-input"
            inputmode="numeric"
            autocomplete="off"
            @keydown.enter.prevent="applyPageJump"
            @blur="applyPageJump"
          />
        </label>
      </div>
      <div v-if="(store.minecraftCapabilities?.itemSources.length ?? 0) > 1" class="item-source-toggle" role="tablist" aria-label="物品来源">
        <button
          class="item-source-button"
          :class="{ active: source === 'ni' }"
          type="button"
          data-testid="item-source-ni"
          @click="setSource('ni')"
        >
          NeigeItems
        </button>
        <button
          class="item-source-button"
          :class="{ active: source === 'mm' }"
          type="button"
          data-testid="item-source-mm"
          @click="setSource('mm')"
        >
          MythicMobs
        </button>
      </div>
      <button
        class="mode-button item-phrase-button"
        :class="{ active: phrasePanelOpen }"
        type="button"
        title="短语"
        @click="phrasePanelOpen = !phrasePanelOpen"
      >
        <SlidersHorizontal :size="13" />
        <span>短语</span>
      </button>
      <button
        v-if="store.dragonCoreAvailable"
        class="mode-button item-dragoncore-button"
        :class="{ active: dragonCorePanelOpen }"
        type="button"
        title="龙核资源"
        data-testid="item-dragoncore-button"
        @click="dragonCorePanelOpen = !dragonCorePanelOpen"
      >
        <Image :size="13" />
        <span>龙核</span>
      </button>
      <button
        class="mode-button item-font-render-button"
        :class="{ active: dragonCoreFontRenderEnabled }"
        type="button"
        :title="dragonCoreFontRenderEnabled ? '关闭生僻字渲染' : '开启生僻字渲染'"
        data-testid="item-font-render-button"
        :disabled="!hasDragonCoreFontImages"
        @click="dragonCoreFontRenderEnabled = !dragonCoreFontRenderEnabled"
      >
        <Type :size="13" />
        <span>生僻字</span>
      </button>
    </div>

    <section v-if="phrasePanelOpen" class="item-phrase-panel" aria-label="短语管理">
      <form class="item-phrase-form" @submit.prevent="addPhrase">
        <input v-model="newPhrase" class="app-input" placeholder="短语" />
        <input v-model="newValue" class="app-input" placeholder="换算为" />
        <button class="mode-button" type="submit">新增</button>
      </form>
      <div v-if="store.settings.itemSearchPhrases.length" class="item-phrase-list">
        <div v-for="rule in store.settings.itemSearchPhrases" :key="rule.id" class="item-phrase-card">
          <div class="item-phrase-row">
            <input class="app-input" :value="rule.phrase" @change="updatePhrase(rule.id, 'phrase', $event)" />
            <input class="app-input" :value="rule.value" @change="updatePhrase(rule.id, 'value', $event)" />
            <button class="icon-button" type="button" title="删除" aria-label="删除" @click="store.deleteItemSearchPhrase(rule.id)">
              <Trash2 :size="13" />
            </button>
          </div>
          <div v-if="phraseHistoryEntries(rule).length" class="item-phrase-history">
            <div class="item-phrase-history-title">历史</div>
            <div v-for="entry in phraseHistoryEntries(rule)" :key="entry.id" class="item-phrase-history-row">
              <span>{{ phraseHistoryText(entry) }}</span>
              <time>{{ phraseHistoryTime(entry) }}</time>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="dragonCorePanelOpen" class="item-dragoncore-panel" aria-label="龙核资源来源">
      <div class="item-dragoncore-form">
        <label class="item-dragoncore-path-wrap">
          <span>客户端龙核目录</span>
          <input
            v-model="dragonCorePathDraft"
            class="app-input"
            data-testid="item-dragoncore-path"
            placeholder="客户端 .minecraft\resourcepacks\DragonCore"
            autocomplete="off"
          />
        </label>
        <button class="icon-button" type="button" title="选择目录" aria-label="选择目录" @click="chooseDragonCorePath">
          <FolderOpen :size="14" />
        </button>
        <button class="mode-button item-dragoncore-save" type="button" data-testid="item-dragoncore-save" @click="saveDragonCorePath">
          <Save :size="13" />
          <span>保存</span>
        </button>
      </div>
      <div class="item-dragoncore-status" :title="dragonCoreClientRootPath" data-testid="item-dragoncore-status">
        {{ dragonCoreClientRootPath ? '已配置 DragonCore 资源包' : '未配置 - 配置后可显示物品图标、品质框和图片字' }}
      </div>
      <div v-if="!dragonCoreClientRootPath" class="item-dragoncore-hint">
        提示：直接选择客户端 DragonCore 文件夹即可；图标、品质框和 FontConfig 图片字会从同一个资源根查找。
      </div>
    </section>

    <div class="item-search-main">
      <div ref="bodyRef" class="item-search-body">
        <div v-if="loading" class="item-search-empty">搜索中...</div>
        <div v-else-if="error" class="item-search-empty error">{{ error }}</div>
        <div v-else-if="!items.length" class="item-search-empty">没有匹配结果</div>
        <div v-else class="item-result-grid">
          <article
            v-for="item in visibleItems"
            :key="`${item.filePath}:${item.lineNumber}`"
            class="item-result-card"
            :style="itemResultCardStyle(item)"
          >
            <div class="item-yaml-editor-surface" data-testid="item-yaml-editor-surface">
              <div class="item-yaml-highlight" aria-hidden="true" data-testid="item-yaml-highlight">
                <div
                  v-for="line in yamlPreviewLines(item)"
                  :key="line.lineNumber"
                  class="item-yaml-line"
                  :class="{ 'current-line': isCurrentLine(item, line.lineNumber) }"
                >
                  <span
                    v-for="(segment, segmentIndex) in line.segments"
                    :key="`${line.lineNumber}-${segmentIndex}`"
                    class="item-yaml-token"
                    :class="segment.kind"
                    :style="segment.color ? { color: segment.color } : undefined"
                  ><img
                      v-if="segment.fontImage"
                      class="item-yaml-font-image"
                      data-testid="item-font-image"
                      :src="segment.fontImage.dataUrl"
                      :alt="segment.text"
                      :title="dragonCoreFontImageTitle(segment.fontImage)"
                      :style="dragonCoreFontImageStyle(segment.fontImage)"
                    /><template v-else>{{ segment.text }}</template></span>
                </div>
              </div>
              <textarea
                class="item-yaml-editor"
                data-testid="item-yaml-editor"
                spellcheck="false"
                wrap="off"
                :rows="itemYamlVisibleLineCount(item)"
                :value="itemDraft(item)"
                @input="updateItemDraft(item, $event)"
                @scroll="syncYamlEditorScroll"
                @keydown="handleTabKey(item, $event)"
                @click="updateCursorLine(item, $event)"
                @keyup="updateCursorLine(item, $event)"
              />
            </div>
            <div v-if="itemSaveError(item)" class="item-save-error" data-testid="item-save-error">
              {{ itemSaveError(item) }}
            </div>
          </article>
        </div>
      </div>

      <aside
        v-if="items.length && !loading && !error"
        class="item-expand-panel"
        data-testid="item-expand-panel"
        aria-label="当前页物品拓展板"
      >
        <div class="item-expand-panel-header">
          <span class="item-expand-panel-title">拓展板</span>
          <span class="item-expand-panel-meta">当前页 {{ visibleItems.length }} 项</span>
        </div>
        <div class="item-expand-panel-list">
          <div
            v-for="item in visibleItems"
            :key="`panel-${item.filePath}:${item.lineNumber}`"
            class="item-expand-row"
            data-testid="item-expand-row"
          >
            <div class="item-expand-row-main">
              <div
                v-if="item.dragonCoreIcon || item.dragonCoreEffect"
                class="item-expand-preview"
                :title="[dragonCoreIconTitle(item), dragonCoreEffectTitle(item)].filter(Boolean).join('\n')"
              >
                <img
                  v-if="item.dragonCoreIcon"
                  class="item-expand-icon"
                  data-testid="item-expand-icon"
                  :src="item.dragonCoreIcon.dataUrl"
                  alt=""
                />
                <img
                  v-if="item.dragonCoreEffect"
                  class="item-expand-effect"
                  data-testid="item-expand-effect"
                  :src="item.dragonCoreEffect.dataUrl"
                  alt=""
                />
              </div>
              <div class="item-expand-text">
                <div class="item-expand-name" :title="itemPanelPlainLabel(item)">
                  <span
                    v-for="(segment, segmentIndex) in itemPanelNameSegments(item)"
                    :key="`${item.filePath}:${item.lineNumber}:${segmentIndex}`"
                    :style="segment.color ? { color: segment.color } : undefined"
                  >{{ segment.text }}</span>
                </div>
                <div class="item-expand-key" :title="item.itemKey">{{ item.itemKey }}</div>
              </div>
            </div>
            <div class="item-expand-actions" data-testid="item-expand-actions">
              <button
                class="icon-button"
                type="button"
                title="保存物品"
                aria-label="保存物品"
                data-testid="item-save-yaml"
                :disabled="!itemDirty(item) || itemIsSaving(item)"
                @click="saveItemDraft(item)"
              >
                <Save :size="13" />
              </button>
              <button
                class="icon-button"
                type="button"
                title="撤回更改"
                aria-label="撤回更改"
                data-testid="item-revert-yaml"
                :disabled="!itemDirty(item) || itemIsSaving(item)"
                @click="revertItemDraft(item)"
              >
                <RotateCcw :size="13" />
              </button>
              <button
                class="icon-button"
                type="button"
                :title="itemCanSend(item) ? '发送 1 个给管理员' : '仅 NeigeItems 支持发送'"
                aria-label="发送 1 个给管理员"
                data-testid="item-send-to-player"
                :disabled="!itemCanSend(item) || itemIsSending(item)"
                @click="sendItemToPlayer(item)"
              >
                <Send :size="13" />
              </button>
              <button
                class="icon-button"
                type="button"
                :title="itemCanSend(item) ? '自定义管理员发送数量' : '仅 NeigeItems 支持发送'"
                aria-label="自定义管理员发送数量"
                data-testid="item-send-admin-options"
                data-send-panel-trigger
                :disabled="!itemCanSend(item) || itemIsSending(item)"
                @click="openSendPanel(item, 'admin', $event)"
              >
                <ChevronDown :size="13" />
              </button>
              <button
                class="icon-button"
                type="button"
                :title="itemCanSend(item) ? '发送物品给在线玩家' : '仅 NeigeItems 支持发送'"
                aria-label="发送物品给在线玩家"
                data-testid="item-send-to-online-player"
                data-send-panel-trigger
                :disabled="!itemCanSend(item) || itemIsSending(item)"
                @click="openSendPanel(item, 'player', $event)"
              >
                <UserRound :size="13" />
              </button>
              <button
                class="icon-button"
                type="button"
                title="跳转到文件行"
                aria-label="跳转到文件行"
                data-testid="item-jump-location"
                @click="jumpToItem(item)"
              >
                <ExternalLink :size="13" />
              </button>
              <button
                class="icon-button"
                type="button"
                title="复制位置"
                aria-label="复制位置"
                data-testid="item-copy-location"
                @click="copyLocation(item)"
              >
                <Copy :size="13" />
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <section
      v-if="sendPanel"
      class="item-send-panel"
      :style="sendPanelStyle"
      :aria-label="sendPanel.mode === 'admin' ? '自定义管理员发送' : '发送物品给在线玩家'"
      @pointerdown.stop
    >
      <div class="item-send-panel-title">
        {{ sendPanel.mode === 'admin' ? '自定义发送给管理员' : '发送物品给在线玩家' }}
      </div>
      <div class="item-send-panel-item" :title="sendPanel.item.itemKey">{{ sendPanel.item.itemKey }}</div>

      <label v-if="sendPanel.mode === 'admin'" class="item-send-field">
        <span>目标</span>
        <span class="item-send-static-value">项目配置的管理员</span>
      </label>
      <label v-else class="item-send-field">
        <span>玩家</span>
        <input
          class="app-input"
          data-testid="item-online-player-input"
          :value="playerQuery"
          placeholder="输入名称筛选"
          autocomplete="off"
          :disabled="onlinePlayersLoading || Boolean(onlinePlayersError)"
          @input="updatePlayerQuery"
        />
      </label>
      <div v-if="sendPanel.mode === 'player'" class="item-online-player-list" data-testid="item-online-player-list">
        <div v-if="onlinePlayersLoading" class="item-online-player-status">正在通过 RCON 获取在线玩家...</div>
        <div v-else-if="onlinePlayersError" class="item-online-player-status error">获取在线玩家失败：{{ onlinePlayersError }}</div>
        <div v-else-if="!onlinePlayers.length" class="item-online-player-status">当前没有在线玩家</div>
        <div v-else-if="!filteredOnlinePlayers.length" class="item-online-player-status">没有匹配的在线玩家</div>
        <button
          v-for="player in filteredOnlinePlayers"
          :key="player"
          class="item-online-player-choice"
          :class="{ selected: selectedPlayer === player }"
          type="button"
          :data-testid="`item-online-player-${player}`"
          @click="selectOnlinePlayer(player)"
        >{{ player }}</button>
      </div>

      <label class="item-send-field">
        <span>数量</span>
        <input
          v-model="sendAmount"
          class="app-input"
          data-testid="item-send-amount"
          type="number"
          min="1"
          max="4294967295"
          step="1"
          inputmode="numeric"
        />
      </label>
      <div v-if="!sendAmountValue" class="item-send-validation">数量必须是 1 到 4294967295 的整数</div>
      <div class="item-send-actions">
        <button class="mode-button" type="button" @click="closeSendPanel">取消</button>
        <button
          class="mode-button primary"
          type="button"
          data-testid="item-send-panel-submit"
          :disabled="!sendPanelCanSubmit || itemIsSending(sendPanel.item)"
          @click="sendItemFromPanel"
        >{{ sendPanel.mode === 'admin' ? '按此数量发送' : `发送给 ${selectedPlayer || '玩家'}` }}</button>
      </div>
    </section>

    <button
      v-for="handle in RESIZE_HANDLES"
      :key="handle"
      class="item-search-resize"
      :class="`resize-${handle}`"
      type="button"
      aria-label="调整大小"
      @pointerdown="beginResize($event, handle)"
    />
  </section>
</template>

<style scoped>
.item-search-dialog {
  position: fixed;
  z-index: 70;
  display: flex;
  flex-direction: column;
  min-width: 440px;
  min-height: 340px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-dialog);
  box-shadow: 0 20px 80px rgba(0, 0, 0, 0.38);
}

.item-search-header,
.item-search-toolbar,
.item-phrase-panel,
.item-dragoncore-panel {
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.025);
}

.item-search-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  cursor: move;
}

.item-search-heading {
  min-width: 0;
}

.item-search-heading .dialog-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 650;
}

.item-search-actions,
.item-search-toolbar,
.item-phrase-form,
.item-phrase-row,
.item-dragoncore-form,
.item-page-controls,
.item-expand-row,
.item-expand-row-main,
.item-expand-actions,
.item-page-jump {
  display: flex;
  align-items: center;
}

.item-search-actions {
  gap: 6px;
}

.item-search-toolbar {
  flex-wrap: nowrap;
  gap: 8px;
  padding: 8px 12px;
  overflow-x: auto;
}

.item-search-input-wrap {
  display: flex;
  min-width: 140px;
  max-width: 280px;
  flex: 1 1 180px;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
}

.item-search-input {
  width: 100%;
}

.item-source-toggle {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(92px, 1fr));
  height: 30px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-secondary);
}

.item-source-button {
  min-width: 0;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  transition: all 0.15s ease;
}

.item-source-button:hover:not(.active) {
  background: var(--surface-panel-soft);
  color: var(--text-primary);
}

.item-source-button:last-child {
  border-right: 0;
}

.item-source-button.active {
  background: var(--accent-blue);
  color: #fff;
  font-weight: 700;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
}

.item-phrase-button {
  flex: 0 0 auto;
}

.item-phrase-panel,
.item-dragoncore-panel {
  padding: 10px 12px;
}

.item-phrase-form,
.item-phrase-row {
  gap: 8px;
}

.item-phrase-form {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(120px, 1.3fr) auto;
}

.item-phrase-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.item-phrase-card {
  display: grid;
  gap: 7px;
  border: 1px solid var(--surface-divider-muted);
  border-radius: 7px;
  padding: 7px;
  background: var(--surface-panel-soft);
}

.item-phrase-row {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(120px, 1.3fr) 30px;
}

.item-phrase-history {
  display: grid;
  gap: 4px;
  border-top: 1px solid var(--surface-divider-muted);
  padding-top: 7px;
}

.item-phrase-history-title {
  color: var(--text-muted);
  font-size: 11px;
}

.item-phrase-history-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 11px;
}

.item-phrase-history-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-phrase-history-row time {
  color: var(--text-muted);
}

.item-dragoncore-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px auto;
  gap: 8px;
}

.item-dragoncore-path-wrap {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.item-dragoncore-path-wrap input {
  min-width: 0;
}

.item-dragoncore-status {
  margin-top: 7px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-dragoncore-hint {
  margin-top: 7px;
  padding: 7px 9px;
  border-radius: 6px;
  background: var(--surface-accent-blue-soft);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.item-search-main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.item-search-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px;
}

.item-result-grid {
  display: grid;
  align-content: start;
  align-items: start;
  grid-auto-rows: max-content;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
  min-height: 0;
  overflow: visible;
}

.item-search-dialog {
  container-type: inline-size;
}

@container (max-width: 860px) {
  .item-phrase-form,
  .item-phrase-row,
  .item-dragoncore-form,
  .item-dragoncore-path-wrap {
    grid-template-columns: 1fr;
  }

  .item-expand-panel {
    width: 250px;
    min-width: 230px;
    max-width: 260px;
    flex-basis: 250px;
  }

  .item-search-input-wrap {
    max-width: 220px;
  }
}

.item-result-card {
  display: flex;
  min-height: 0;
  min-width: 0;
  height: auto;
  flex-direction: column;
  contain: paint;
  overflow: hidden;
  border: 1px solid var(--surface-divider-soft);
  border-radius: 8px;
  background: var(--surface-secondary);
  box-shadow: inset 3px 0 0 var(--surface-accent-blue-border);
}

.item-yaml-editor-surface {
  position: relative;
  flex: 0 0 auto;
  box-sizing: border-box;
  contain: paint;
  min-height: 0;
  height: calc(1.55em * var(--item-yaml-visible-line-count) + 18px);
  max-height: calc(1.55em * var(--item-yaml-visible-line-count) + 18px);
  overflow: hidden;
  background: var(--surface-primary);
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.item-yaml-highlight {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  z-index: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--surface-divider-muted);
  padding: 9px;
  color: var(--text-secondary);
  background: var(--surface-primary);
  pointer-events: none;
}

.item-yaml-line {
  min-height: 1.55em;
  min-width: 100%;
  width: max-content;
  white-space: pre;
  overflow-wrap: normal;
}

.item-yaml-line.current-line {
  background: rgba(100, 150, 255, 0.12);
  box-shadow: inset 2px 0 0 rgba(100, 150, 255, 0.5);
}

.item-yaml-token.key {
  color: var(--color-accent-blue);
  font-weight: 650;
}

.item-yaml-token.separator,
.item-yaml-token.listMarker {
  color: var(--text-muted);
}

.item-yaml-token.string {
  color: var(--text-primary);
}

.item-yaml-token.number {
  color: var(--color-accent-yellow);
}

.item-yaml-token.literal {
  color: var(--color-accent-purple);
}

.item-yaml-token.comment {
  color: var(--color-accent-green);
  font-style: italic;
}

.item-yaml-token.value {
  color: var(--text-secondary);
}

.item-yaml-font-image {
  display: inline-block;
  max-width: 240px;
  object-fit: contain;
  vertical-align: middle;
}

.item-yaml-editor {
  display: block;
  position: relative;
  box-sizing: border-box;
  z-index: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  resize: none;
  border: 0;
  border-radius: 0;
  outline: 0;
  padding: 9px;
  color: transparent;
  caret-color: var(--color-accent-purple);
  background: transparent;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre;
  overflow: auto;
  overflow-wrap: normal;
}

.item-yaml-editor::selection {
  background: var(--color-accent-blue);
  color: var(--color-text-primary);
  -webkit-text-fill-color: var(--color-text-primary);
}

.item-yaml-editor:focus {
  box-shadow: inset 0 0 0 1px var(--surface-accent-blue-border);
}

.item-search-body,
.item-yaml-editor,
.item-expand-panel-list {
  scrollbar-width: thin;
  scrollbar-color: var(--color-text-muted) var(--color-bg-primary);
}

.item-search-body::-webkit-scrollbar,
.item-yaml-editor::-webkit-scrollbar,
.item-expand-panel-list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.item-search-body::-webkit-scrollbar-track,
.item-yaml-editor::-webkit-scrollbar-track,
.item-expand-panel-list::-webkit-scrollbar-track {
  background: var(--color-bg-primary);
}

.item-search-body::-webkit-scrollbar-thumb,
.item-yaml-editor::-webkit-scrollbar-thumb,
.item-expand-panel-list::-webkit-scrollbar-thumb {
  border: 2px solid var(--color-bg-primary);
  border-radius: 4px;
  background: var(--color-text-muted);
}

.item-search-body::-webkit-scrollbar-thumb:hover,
.item-yaml-editor::-webkit-scrollbar-thumb:hover,
.item-expand-panel-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-secondary);
}

.item-search-body::-webkit-scrollbar-button,
.item-yaml-editor::-webkit-scrollbar-button,
.item-expand-panel-list::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

.item-search-body::-webkit-scrollbar-corner,
.item-yaml-editor::-webkit-scrollbar-corner,
.item-expand-panel-list::-webkit-scrollbar-corner {
  background: var(--color-bg-primary);
}

.item-save-error {
  border-top: 1px solid var(--surface-divider-muted);
  padding: 7px 9px;
  color: var(--accent-red);
  background: var(--surface-danger-soft);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.item-search-empty {
  display: grid;
  min-height: 160px;
  place-items: center;
  color: var(--text-muted);
  font-size: 13px;
}

.item-search-empty.error {
  color: var(--accent-red);
  text-align: center;
  white-space: pre-wrap;
}

.item-page-controls {
  gap: 6px;
  flex: 0 0 auto;
  min-width: 0;
}

.item-page-status {
  min-width: 46px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  text-align: center;
  font-size: 12px;
  font-weight: 650;
}

.item-page-jump {
  gap: 5px;
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.item-page-jump-input {
  width: 52px;
  min-width: 52px;
  height: 28px;
  padding: 0 6px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.item-expand-panel {
  display: flex;
  width: 300px;
  min-width: 280px;
  max-width: 340px;
  flex: 0 0 300px;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
}

.item-expand-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.025);
}

.item-expand-panel-title {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 700;
}

.item-expand-panel-meta {
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.item-expand-panel-list {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  overflow: auto;
}

.item-expand-row {
  flex: 0 0 auto;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  border-bottom: 1px solid var(--surface-divider-muted);
  padding: 8px 10px;
  background: var(--surface-secondary);
}

.item-expand-row:nth-child(even) {
  background: rgba(255, 255, 255, 0.02);
}

.item-expand-row-main {
  gap: 8px;
  min-width: 0;
}

.item-expand-preview {
  position: relative;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  overflow: hidden;
  border: 1px solid var(--surface-divider-muted);
  border-radius: 5px;
  background: var(--surface-primary);
}

.item-expand-icon,
.item-expand-effect {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.item-expand-icon {
  z-index: 2;
  padding: 2px;
}

.item-expand-effect {
  z-index: 1;
  pointer-events: none;
}

.item-expand-text {
  min-width: 0;
  flex: 1 1 auto;
}

.item-expand-name,
.item-expand-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-expand-name {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.3;
}

.item-expand-key {
  color: var(--text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  line-height: 1.3;
}

.item-expand-actions {
  justify-content: flex-start;
  gap: 4px;
  flex-wrap: nowrap;
}

.item-expand-actions .icon-button {
  width: 26px;
  height: 26px;
}

.item-send-panel {
  position: fixed;
  z-index: 90;
  display: grid;
  width: min(320px, calc(100vw - 16px));
  gap: 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  background: var(--surface-dialog);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.34);
}

.item-send-panel-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
}

.item-send-panel-item {
  overflow: hidden;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-send-field {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.item-send-static-value {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-online-player-list {
  display: grid;
  max-height: 132px;
  overflow-y: auto;
  border: 1px solid var(--surface-divider-muted);
  background: var(--surface-primary);
}

.item-online-player-status,
.item-online-player-choice {
  min-height: 28px;
  border: 0;
  border-bottom: 1px solid var(--surface-divider-muted);
  padding: 6px 8px;
  color: var(--text-secondary);
  background: transparent;
  font: inherit;
  font-size: 12px;
  text-align: left;
}

.item-online-player-status.error,
.item-send-validation {
  color: var(--accent-red);
}

.item-online-player-choice:last-child {
  border-bottom: 0;
}

.item-online-player-choice:hover,
.item-online-player-choice.selected {
  color: var(--text-primary);
  background: var(--surface-accent-blue-soft);
}

.item-send-validation {
  margin-top: -3px;
  font-size: 11px;
}

.item-send-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.item-search-resize {
  position: absolute;
  z-index: 2;
  border: 0;
  padding: 0;
  background: transparent;
}

.item-search-resize.resize-n,
.item-search-resize.resize-s {
  left: 10px;
  right: 10px;
  height: 7px;
  cursor: ns-resize;
}

.item-search-resize.resize-n {
  top: 0;
}

.item-search-resize.resize-s {
  bottom: 0;
}

.item-search-resize.resize-e,
.item-search-resize.resize-w {
  top: 48px;
  bottom: 10px;
  width: 7px;
  cursor: ew-resize;
}

.item-search-resize.resize-e {
  right: 0;
}

.item-search-resize.resize-w {
  left: 0;
}

.item-search-resize.resize-ne,
.item-search-resize.resize-nw,
.item-search-resize.resize-se,
.item-search-resize.resize-sw {
  width: 18px;
  height: 18px;
}

.item-search-resize.resize-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.item-search-resize.resize-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.item-search-resize.resize-se {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}

.item-search-resize.resize-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
</style>
