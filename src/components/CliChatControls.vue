<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Check, ChevronDown, ChevronRight, LoaderCircle, X } from 'lucide-vue-next'
import { backend, type CliChatControls, type CliChatModelOption } from '@/lib/tauri'

const props = defineProps<{
  sessionId: string
  visible: boolean
  label: string
  selectionLabel?: string
  busy: boolean
  learnedModels: CliChatModelOption[]
  contextOverride?: CliChatControls['context']
  refreshingContext?: boolean
  nativeMenuOpen?: boolean
}>()
const emit = defineEmits<{
  fallback: []
  select: [model: CliChatModelOption, effort?: string]
  focusInput: []
  context: []
}>()
const state = shallowRef<CliChatControls | null>(null)
const anchor = ref<HTMLButtonElement>()
const ring = ref<HTMLButtonElement>()
const menu = ref<HTMLElement>()
const submenu = ref<HTMLElement>()
const contextPanel = ref<HTMLElement>()
const open = ref(false)
const contextOpen = ref(false)
const query = ref('')
const highlighted = ref(0)
const shown = ref<string | null>(null)
const menuStyle = ref<Record<string, string>>({})
const submenuStyle = ref<Record<string, string>>({})
const contextStyle = ref<Record<string, string>>({})
let timer: number | undefined
let switchTimer: number | undefined
let epoch = 0
let request = 0
let disposed = false
let pointer: { x: number; y: number } | undefined
const models = computed(() => state.value?.models.length ? state.value.models
  : typeof backend.readTerminalChatControls === 'function' ? props.learnedModels : [])
const filtered = computed(() => models.value.filter(model => `${model.label} ${model.id} ${model.description}`.toLowerCase().includes(query.value.toLowerCase())))
const currentSettings = computed(() => models.value.find(model => model.id === shown.value))
const effectiveLabel = computed(() => {
  if (props.selectionLabel) return props.selectionLabel
  // A freshly attached Claude screen can still contain the previous terminal's header.
  if (state.value?.provider === 'claude' && state.value.model && state.value.context?.source !== 'claude-message-usage') {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
    return normalize(props.label).startsWith(normalize(state.value.model)) ? props.label : state.value.model
  }
  return props.label !== '选择模型' ? props.label
    : state.value?.model ? [state.value.model, state.value.effort].filter(Boolean).join(' ') : props.label
})
const usage = computed(() => props.contextOverride ?? state.value?.context)
const known = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const format = (value: number | null | undefined) => !known(value) ? '—' : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`
const percent = computed(() => known(usage.value?.usedTokens) && (usage.value?.windowTokens ?? 0) > 0
  ? usage.value!.usedTokens! / usage.value!.windowTokens! : null)
const usedSegments = computed(() => usage.value?.segments.filter(segment => segment.kind === 'used' && segment.tokens > 0) ?? [])
const cacheRate = computed(() => usage.value?.cacheHitRate ?? (known(usage.value?.cachedTokens) && (usage.value?.inputTokens ?? 0) > 0 ? usage.value!.cachedTokens! / usage.value!.inputTokens! : null))
const contextTitle = computed(() => `上下文 ${format(usage.value?.usedTokens)} / ${format(usage.value?.windowTokens)}${percent.value === null ? '' : ` · ${Math.round(percent.value * 100)}%`}`)

async function refresh() {
  const ticket = epoch
  const currentRequest = ++request
  const id = props.sessionId
  window.clearTimeout(timer)
  if (!props.visible || typeof backend.readTerminalChatControls !== 'function') return
  try {
    const next = await backend.readTerminalChatControls(id)
    if (!disposed && ticket === epoch && currentRequest === request && props.sessionId === id) state.value = next
  } catch { /* Older sessions can keep using their native picker. */ }
  finally {
    if (!disposed && ticket === epoch && currentRequest === request && props.visible) timer = window.setTimeout(refresh, props.busy || contextOpen.value ? 1500 : 5000)
  }
}

function close(restoreFocus = false) {
  open.value = false
  shown.value = null
  window.clearTimeout(switchTimer)
  switchTimer = undefined
  if (restoreFocus) emit('focusInput')
}
function positionPanel(el: HTMLElement | undefined, trigger: HTMLElement | undefined, width: number): Record<string, string> {
  if (!trigger) return {}
  const rect = trigger.getBoundingClientRect()
  const top = el === contextPanel.value ? trigger.closest('.cli-chat-composer')?.getBoundingClientRect().top ?? rect.top : rect.top
  const height = el?.offsetHeight ?? 280
  return { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, top >= height + 12 ? top - height - 6 : Math.min(rect.bottom + 6, window.innerHeight - height - 8))}px`,
    width: `${Math.min(width, window.innerWidth - 16)}px`, maxHeight: `${window.innerHeight - 16}px` }
}
async function position() {
  await nextTick()
  if (open.value) {
    menuStyle.value = positionPanel(menu.value, anchor.value, 264)
    await nextTick()
    positionSubmenu()
  }
  if (contextOpen.value) contextStyle.value = positionPanel(contextPanel.value, ring.value, 560)
}
function positionSubmenu() {
  const row = menu.value?.querySelector<HTMLElement>(`[data-model-index="${filtered.value.findIndex(model => model.id === shown.value)}"]`)
  if (!row || !menu.value) return
  const rect = row.getBoundingClientRect()
  const parent = menu.value.getBoundingClientRect()
  const width = 172
  submenuStyle.value = { left: `${parent.right + width + 8 <= window.innerWidth ? parent.right + 4 : Math.max(8, parent.left - width - 4)}px`,
    top: `${Math.max(8, Math.min(rect.top - 4, window.innerHeight - (submenu.value?.offsetHeight ?? 210) - 8))}px`, width: `${width}px`, maxHeight: `${window.innerHeight - 16}px` }
}
function toggle() {
  if (props.busy) return
  if (open.value) { close(); return }
  contextOpen.value = false
  if (props.nativeMenuOpen) { emit('fallback'); return }
  if (!models.value.length) { emit('fallback'); return }
  query.value = ''
  pointer = undefined
  open.value = true
  highlighted.value = Math.max(0, models.value.findIndex(model => selected(model)))
  void position().then(() => menu.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }))
}
function show(index: number) {
  window.clearTimeout(switchTimer)
  switchTimer = undefined
  highlighted.value = index
  shown.value = filtered.value[index]?.efforts.length ? filtered.value[index]!.id : null
  void nextTick(positionSubmenu)
}
function point(index: number, event: PointerEvent) {
  highlighted.value = index
  const from = pointer
  pointer = { x: event.clientX, y: event.clientY }
  const rect = submenu.value?.getBoundingClientRect()
  if (shown.value && from && rect && filtered.value[index]?.id !== shown.value) {
    const edge = rect.left > from.x ? rect.left : rect.right
    const cross = (ax: number, ay: number, bx: number, by: number) => (bx - ax) * (event.clientY - ay) - (by - ay) * (event.clientX - ax)
    const signs = [cross(from.x, from.y, edge, rect.top), cross(edge, rect.top, edge, rect.bottom), cross(edge, rect.bottom, from.x, from.y)]
    if (signs.every(value => value >= 0) || signs.every(value => value <= 0)) {
      if (switchTimer === undefined) switchTimer = window.setTimeout(() => { switchTimer = undefined; show(highlighted.value) }, 200)
      return
    }
  }
  show(index)
}
function selected(model: CliChatModelOption) {
  if (model.nativeNumber !== undefined) return model.nativeSelected === true
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]/g, '')
  return normalize(effectiveLabel.value).startsWith(normalize(model.id))
    || normalize(effectiveLabel.value).startsWith(normalize(model.label))
}
function choose(model: CliChatModelOption, effort?: string) {
  close(true)
  emit('select', model, effort)
}
function outside(event: PointerEvent) {
  const target = event.target as Node
  if (![anchor.value, ring.value, menu.value, submenu.value, contextPanel.value].some(el => el?.contains(target))) {
    close()
    contextOpen.value = false
  }
}
function keydown(event: KeyboardEvent) {
  if (!open.value && !contextOpen.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); contextOpen.value = false; return }
  if (submenu.value?.contains(event.target as Node)) return
  if (!open.value || event.target instanceof HTMLInputElement && !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
  if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      show((highlighted.value + (event.key === 'ArrowDown' ? 1 : -1) + filtered.value.length) % Math.max(1, filtered.value.length))
      menu.value?.querySelector<HTMLElement>(`[data-model-index="${highlighted.value}"]`)?.scrollIntoView?.({ block: 'nearest' })
    } else if (event.key === 'ArrowLeft') shown.value = null
    else if (event.key === 'ArrowRight') { show(highlighted.value); void nextTick(() => submenu.value?.querySelector<HTMLButtonElement>('button')?.focus()) }
    else if (filtered.value[highlighted.value]) choose(filtered.value[highlighted.value]!)
  }
}
function toggleContext() {
  close()
  contextOpen.value = !contextOpen.value
  if (contextOpen.value) { emit('context'); window.clearTimeout(timer); void refresh(); void position() }
}
function enterSettings() { window.clearTimeout(switchTimer); switchTimer = undefined }
function settingsKey(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); shown.value = null; anchor.value?.focus() }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const buttons = [...submenu.value?.querySelectorAll<HTMLButtonElement>('button') ?? []]
    const current = buttons.indexOf(event.target as HTMLButtonElement)
    buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }
}
watch(query, () => { highlighted.value = 0; shown.value = null; void position() })
watch(() => props.contextOverride, value => {
  if (!value || !props.visible || (props.refreshingContext && !contextOpen.value)) return
  close()
  contextOpen.value = true
  void position()
})
watch([() => props.sessionId, () => props.visible], () => {
  epoch++
  window.clearTimeout(timer)
  close()
  contextOpen.value = false
  state.value = null
  if (props.visible) void refresh()
}, { immediate: true })
document.addEventListener('pointerdown', outside)
document.addEventListener('keydown', keydown, true)
window.addEventListener('resize', position)
window.addEventListener('scroll', position, true)
onBeforeUnmount(() => {
  disposed = true; epoch++
  window.clearTimeout(timer); window.clearTimeout(switchTimer)
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', keydown, true)
  window.removeEventListener('resize', position)
  window.removeEventListener('scroll', position, true)
})
</script>

<template>
  <div class="chat-controls">
    <button ref="anchor" class="cli-chat-model" type="button" title="选择模型与推理强度" :disabled="busy" :aria-expanded="open" aria-haspopup="listbox"
      @pointerdown="event => { if (event.button === 0) { event.preventDefault(); toggle() } }" @click="event => { if (event.detail === 0) toggle() }">
      <span>{{ effectiveLabel }}</span><LoaderCircle v-if="busy" :size="12" class="controls-spin" /><ChevronDown v-else :size="12" />
    </button>
    <button ref="ring" class="chat-context-button" type="button" :title="contextTitle" :aria-label="contextTitle" :aria-expanded="contextOpen" @click="toggleContext">
      <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true"><circle cx="9" cy="9" r="6.5" class="context-track" /><circle cx="9" cy="9" r="6.5" class="context-fill" pathLength="100" :stroke-dasharray="`${Math.max(0, Math.min(1, percent ?? 0)) * 100} 100`" /></svg>
    </button>
    <Teleport to="body">
      <Transition name="chat-menu">
        <div v-if="open" ref="menu" class="chat-control-panel chat-model-menu" :style="menuStyle" role="listbox" aria-label="选择模型" @scroll="positionSubmenu">
          <input v-if="models.length >= 8" v-model="query" class="chat-model-search" aria-label="搜索模型" placeholder="搜索模型" />
          <button v-for="(model, index) in filtered" :key="model.id" type="button" class="chat-model-row" :class="{ highlighted: index === highlighted }" :data-model-index="index" role="option" :aria-selected="selected(model)"
            :title="model.description" @pointermove="point(index, $event)" @focus="show(index)" @click="choose(model)">
            <span>{{ model.label }}<small v-if="model.nativeNumber !== undefined && model.description">{{ model.description }}</small></span><Check v-if="selected(model)" :size="13" /><ChevronRight v-if="model.efforts.length" :size="12" />
          </button>
          <span v-if="!filtered.length" class="chat-model-empty">没有匹配的模型</span>
        </div>
      </Transition>
      <Transition name="chat-submenu">
        <div v-if="open && currentSettings" ref="submenu" class="chat-control-panel chat-model-submenu" :style="submenuStyle" aria-label="推理强度" @pointerenter="enterSettings">
          <div class="chat-control-heading">推理强度</div>
          <button v-for="effort in currentSettings.efforts" :key="effort.id" type="button" class="chat-model-row" :title="effort.description" @keydown.stop="settingsKey" @click="choose(currentSettings!, effort.id)">
            <span>{{ effort.label }}</span><Check v-if="selected(currentSettings) && (state?.effort || currentSettings.defaultEffort) === effort.id" :size="13" />
          </button>
        </div>
      </Transition>
      <Transition name="chat-menu">
        <section v-if="contextOpen" ref="contextPanel" class="chat-control-panel chat-context-panel" :style="contextStyle" aria-label="上下文用量">
          <div class="chat-context-heading"><span>上下文窗口</span><LoaderCircle v-if="refreshingContext" :size="12" class="controls-spin" /><span class="chat-context-value">{{ format(usage?.usedTokens) }} / {{ format(usage?.windowTokens) }} token<span v-if="percent !== null"> · {{ Math.round(percent * 100) }}%</span></span><button type="button" class="chat-context-button" aria-label="关闭上下文用量" @click="contextOpen = false"><X :size="13" /></button></div>
          <template v-if="usage && known(usage.usedTokens)">
            <div class="chat-context-track"><template v-if="usedSegments.length && usage.windowTokens"><span v-for="(segment, index) in usedSegments" :key="segment.id" :style="{ width: `${segment.tokens / usage.windowTokens * 100}%`, background: `var(--memo-title-${index % 14})` }" /></template><span v-else :style="{ width: `${Math.min(1, percent ?? 0) * 100}%` }" /></div>
            <div v-if="usedSegments.length" class="chat-context-legend"><span v-for="(segment, index) in usedSegments" :key="segment.id"><i :style="{ background: `var(--memo-title-${index % 14})` }" />{{ segment.label }} {{ format(segment.tokens) }}</span><span v-for="segment in usage.segments.filter(segment => segment.kind === 'buffer')" :key="segment.id">{{ segment.label }} {{ format(segment.tokens) }}</span></div>
            <div class="chat-context-stats"><span v-if="known(usage.inputTokens)">输入 {{ format(usage.inputTokens) }}</span><span v-if="known(usage.outputTokens)">输出 {{ format(usage.outputTokens) }}</span><span v-if="known(usage.cachedTokens)">缓存读取 {{ format(usage.cachedTokens) }}</span><span v-if="cacheRate !== null">缓存命中 {{ Math.round(cacheRate * 100) }}%</span></div>
            <div class="chat-context-note">{{ usage.source === 'claude-context-command' ? 'CLI 分类估算 · /context' : usage.source === 'claude-message-usage' ? '最近请求的输入统计；窗口大小暂未报告' : '原生会话统计 · 最近请求' }}</div>
          </template>
          <p v-else class="chat-context-note">{{ state?.unavailableReason ? '此会话尚不支持上下文统计，新建会话后可用。' : 'CLI 尚未报告上下文用量，收到统计后自动更新。' }}</p>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.chat-controls { display: flex; align-items: center; flex: 0 1 auto; min-width: 0; gap: 2px; }
.cli-chat-model { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 260px; height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 12.5px; cursor: pointer; }
.cli-chat-model span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cli-chat-model:hover, .cli-chat-model[aria-expanded=true] { border-color: var(--color-border); background: var(--color-bg-hover); }
.cli-chat-model:disabled { color: var(--color-text-muted); cursor: wait; }
.chat-context-button { display: grid; place-items: center; flex: none; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.chat-context-button:hover, .chat-context-button[aria-expanded=true] { background: var(--color-bg-hover); color: var(--color-text-primary); }
.context-track, .context-fill { fill: none; stroke-width: 2; }
.context-track { stroke: var(--color-border); }
.context-fill { stroke: currentColor; transform: rotate(-90deg); transform-origin: center; transition: stroke-dasharray 400ms ease; }
.chat-control-panel { position: fixed; z-index: 1000; box-sizing: border-box; padding: 4px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-secondary-solid, var(--color-bg-secondary)); color: var(--color-text-primary); font-family: var(--font-ui); font-size: 12.5px; box-shadow: none; }
.chat-model-menu { max-height: min(360px, calc(100vh - 16px)) !important; }
.chat-model-row { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 29px; padding: 4px 8px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.chat-model-row span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-model-row small { display: block; overflow: hidden; text-overflow: ellipsis; color: var(--color-text-muted); font-size: 11px; }
.chat-model-row svg { flex: none; }
.chat-model-row.highlighted, .chat-model-submenu .chat-model-row:hover { background: var(--color-bg-hover); }
.chat-model-search { box-sizing: border-box; width: 100%; height: 28px; margin-bottom: 4px; padding: 4px 8px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-tertiary); color: inherit; font: inherit; }
.chat-control-heading, .chat-model-empty { display: block; padding: 5px 8px; color: var(--color-text-muted); font-size: 11px; }
.chat-context-panel { padding: 8px 12px; }
.chat-context-heading { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.chat-context-heading > .chat-context-button { margin-left: auto; }
.chat-context-value { color: var(--color-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.chat-context-track { display: flex; height: 5px; margin: 8px 0; overflow: hidden; border-radius: 2px; background: var(--color-border); }
.chat-context-track > span { flex: none; height: 100%; background: var(--color-accent-blue); transition: width 400ms ease; }
.chat-context-stats, .chat-context-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; color: var(--color-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.chat-context-legend span { display: inline-flex; align-items: center; gap: 4px; }
.chat-context-legend i { width: 6px; height: 6px; border-radius: 1px; }
.chat-context-note { margin: 8px 0 0; color: var(--color-text-muted); font-size: 11px; }
.chat-menu-enter-active { transition: opacity 140ms ease-out, transform 140ms ease-out; }
.chat-menu-leave-active { transition: opacity 100ms ease-out; pointer-events: none; }
.chat-submenu-enter-active { transition: opacity 90ms ease-out; }
.chat-submenu-leave-active { transition: opacity 80ms ease-out; pointer-events: none; }
.chat-menu-enter-from { opacity: 0; transform: scale(.96); }
.chat-menu-leave-to, .chat-submenu-enter-from, .chat-submenu-leave-to { opacity: 0; }
.controls-spin { animation: controls-spin 1s linear infinite; }
@keyframes controls-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { *, .context-fill, .chat-context-track > span { transition: none; animation: none; } }
</style>
