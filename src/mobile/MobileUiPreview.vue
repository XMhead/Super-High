<script setup lang="ts">
import { computed, onBeforeUnmount, provide, reactive, ref, watch } from 'vue'
import { compileSuperhighUi, superhighUiStatePath } from '@/lib/superhighUi'
import { parseDataFile, uiText, walkUiTree } from '@/lib/superhighUiData'
import { createUiScope, formatUiDraft, indexUiFields } from '@/lib/superhighUiFields'
import { normalizePath, fileNameFromPath } from '@/lib/path'
import { MobileHostApi } from '@/lib/hostApi'
import { SUPERHIGH_UI_CONTEXT, SuperhighUiNode, type SuperhighUiActionInput } from '@/components/SuperhighUiNode'
import '@/superhigh-ui.css'

const props = defineProps<{ api: MobileHostApi; root: string; path: string; content: string }>()
const source = ref(props.content)
const doc = computed(() => compileSuperhighUi(source.value))
const values = reactive<Record<string, unknown>>({})
const dataFiles = reactive(new Map<string, unknown>())
const notice = ref('')
let actions: Array<SuperhighUiActionInput & { id: number; at: string }> = []
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
let writeTimer: ReturnType<typeof setTimeout> | undefined
let writes: Promise<void> = Promise.resolve()
let disposed = false

function localPath(src: string) {
  const base = normalizePath(props.path).replace(/\/[^/]*$/, '')
  const path = /^(?:[a-z]:[\\/]|[\\/])/i.test(src) ? normalizePath(src) : `${base}/${normalizePath(src)}`
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '.') continue
    if (part === '..') { if (parts.length > 1) parts.pop() }
    else parts.push(part)
  }
  return parts.join('/')
}
const fields = computed(() => indexUiFields(doc.value.root))
const sources = computed(() => {
  const result = new Set<string>()
  walkUiTree(doc.value.root, node => { if (node.type === 'Data' && node.props.src) result.add(localPath(uiText(node.props.src))) })
  return [...result]
})
const scope = createUiScope(() => fields.value, values, src => dataFiles.get(localPath(src).toLowerCase()))
async function loadData() {
  const epoch = generation
  for (const path of sources.value) {
    try {
      const content = await props.api.readTextFile(path)
      if (epoch === generation && !disposed) dataFiles.set(path.toLowerCase(), parseDataFile(path, content))
    } catch (error) { if (epoch === generation && !disposed) notice.value = `读取数据失败：${String(error)}` }
  }
}
async function loadState() {
  const epoch = generation
  try {
    const state = JSON.parse(await props.api.readTextFile(superhighUiStatePath(props.path)))
    if (epoch !== generation || disposed || writeTimer) return
    for (const key of Object.keys(values)) delete values[key]
    if (state.values && typeof state.values === 'object') Object.assign(values, state.values)
    actions = Array.isArray(state.actions) ? state.actions.slice(-50) : []
  } catch { /* A new IUI need not have a state file yet. */ }
}
function saveState() {
  clearTimeout(writeTimer); writeTimer = undefined
  const path = props.path, root = props.root, api = props.api
  const state = { schema: 'superhigh.ui-state.v1', source: fileNameFromPath(path), updatedAt: new Date().toISOString(), values: { ...values }, actions: [...actions] }
  writes = writes.catch(() => undefined).then(async () => {
    await api.view({ operation: 'iui-state', root, path, data: { state } })
  })
  return writes
}
function setValue(name: string, value: unknown) {
  if (!name) return
  values[name] = value
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { void saveState().catch(error => { if (!disposed) notice.value = `状态写入失败：${String(error)}` }) }, 400)
}
function emitAction(input: SuperhighUiActionInput) {
  actions = [...actions, { ...input, id: (actions.at(-1)?.id ?? 0) + 1, at: new Date().toISOString() }].slice(-50)
  const draft = formatUiDraft(doc.value.root, scope, values, input.label || (input.type === 'click' ? input.action : '提交'), input.values)
  const path = props.path, root = props.root, api = props.api
  void saveState().then(async () => {
    const response = await api.view<{ result: string }>({ operation: 'iui-submit', root, path, data: { text: draft } })
    const labels: Record<string, string> = { inserted: '已填入原会话草稿', unbound: '已记录选择，未绑定原会话', ended: '原会话已结束，未填入草稿', unavailable: '无法核对原会话', duplicate: '该选择已填入草稿', pending: '正在核对原会话' }
    if (!disposed && props.path === path) notice.value = labels[response.result] || response.result
  }).catch(error => { if (!disposed && props.path === path) notice.value = `提交失败：${String(error)}` })
}
async function poll(epoch: number) {
  try {
    const text = await props.api.readTextFile(props.path)
    if (epoch !== generation || disposed) return
    if (text !== source.value) source.value = text
    await loadData()
  } catch (error) { if (epoch === generation && !disposed) notice.value = `读取界面失败：${String(error)}` }
  if (epoch === generation && !disposed) timer = setTimeout(() => void poll(epoch), 3000)
}
watch(() => [props.path, props.content, props.api] as const, ([, content]) => {
  generation++
  clearTimeout(timer); clearTimeout(writeTimer); writeTimer = undefined
  source.value = content
  actions = []
  dataFiles.clear()
  for (const key of Object.keys(values)) delete values[key]
  void loadState()
  void poll(generation)
}, { immediate: true })
onBeforeUnmount(() => { if (writeTimer) void saveState().catch(() => undefined); disposed = true; generation++; clearTimeout(timer) })
provide(SUPERHIGH_UI_CONTEXT, {
  values, setValue, emitAction,
  beginDrag: () => undefined, dragEnabled: ref(false), allowEditor: false, scope,
  resolveImage: src => /^(https?:|data:)/i.test(src) ? Promise.resolve(src) : props.api.readImageFile(localPath(src)),
  resolveMedia: src => /^(https?:|data:)/i.test(src) ? Promise.resolve(src) : props.api.readImageFile(localPath(src)),
  resolvePlayableMedia: src => /^(https?:|data:)/i.test(src) ? Promise.resolve(src) : Promise.reject(new Error('手机暂不支持本地音视频预览。')),
  openResource: async () => { notice.value = '请在资源管理器打开该文件。' }, imageRevision: () => '',
})
</script>

<template>
  <div class="shui-root mobile-iui">
    <div class="shui-scroll" :class="{ 'has-page': doc.root?.type === 'Page' }">
      <SuperhighUiNode v-if="doc.root" :node="doc.root" />
      <div v-else class="shui-empty">界面正在生成</div>
    </div>
    <div v-if="notice || doc.diagnostics.length || doc.unusedStatements.length" class="shui-status" role="status">
      <span v-if="notice">{{ notice }}</span>
      <span v-for="issue in doc.diagnostics" :key="`${issue.line}:${issue.message}`">第 {{ issue.line }} 行：{{ issue.message }}</span>
      <span v-if="doc.unusedStatements.length">未引用：{{ doc.unusedStatements.join('、') }}</span>
    </div>
  </div>
</template>
