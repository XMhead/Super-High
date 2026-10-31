<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Crosshair, ImagePlus, Maximize2, MousePointer2, Move, RotateCcw, Square, Trash2, Undo2, X } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/stores/workspace'
import { backend } from '@/lib/tauri'
import type { EditorTab } from '@/types'
import ProjectEditorFeedbackCanvas from './ProjectEditorFeedbackCanvas.vue'

defineEmits<{ close: [] }>()
type Box = { x: number; y: number; w: number; h: number }
type ElementInfo = { selector: string; tag: string; text: string; scrollX: number; scrollY: number }
type MediaSource = { name: string; type: 'image' | 'video' | 'editor'; width: number; height: number; workspace?: string; path?: string }
type Note = { id: number; kind: 'point' | 'rectangle' | 'move' | 'global'; box: Box | null; from?: Box; media: MediaSource; element?: ElementInfo; text: string; time: number | null; accepted: boolean }
type Tool = 'select' | 'point' | 'rectangle' | 'move'
const store = useWorkspaceStore()
const requestedEditor = new URLSearchParams(window.location.search).get('editor')
const editorTab = ref<EditorTab | null>(null)
const editorError = ref('')
const editorViewport = ref({ width: 960, height: 600 })
const useEditor = computed(() => !!editorTab.value && medium.value === 'image' && !imageUrl.value)
onMounted(async () => {
  if (!requestedEditor) return
  try {
    if (!/^\.superhigh\/editor\/[^/\\]+\.html$/.test(requestedEditor)) throw new Error('请选择当前工作区已登记的编辑器页面。')
    const path = `${store.workspace!.rootPath}/${requestedEditor}`
    const content = await backend.readFile(path)
    editorTab.value = { id: 'feedback-editor', path, name: requestedEditor.split('/').pop()!, content, language: 'html', contentType: 'text', isDirty: false }
    sourceName.value = editorTab.value.name
    tool.value = 'select'
    status.value = '先浏览真实编辑器；切换点批注、框批注或拖动布局，表达修改意见。'
  } catch (error) { editorError.value = error instanceof Error ? error.message : String(error) }
})
const svg = ref<SVGSVGElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const tools = [{ id: 'select' as const, label: '选择', icon: MousePointer2 }, { id: 'point' as const, label: '点批注', icon: Crosshair }, { id: 'rectangle' as const, label: '框批注', icon: Square }, { id: 'move' as const, label: '拖动布局', icon: Move }]
const tool = ref<Tool>('rectangle')
const medium = ref<'image' | 'video'>('image')
const expanded = ref(false)
const notes = ref<Note[]>([])
const selected = ref<number | null>(null)
const text = ref('')
const position = ref<Box>({ x: 756, y: 48, w: 124, h: 42 })
const pending = ref<Box | null>(null)
const imageUrl = ref('')
const sourceName = ref('示例页面 · 本地绘制')
const imageSize = ref({ width: 960, height: 600 })
const time = ref(3240)
const original = ref(false)
const showData = ref(false)
const submitted = ref(false)
const status = ref('框住一个区域，写下你想怎么改。')
const history = ref<string[]>([])
const W = computed(() => useEditor.value ? editorViewport.value.width : medium.value === 'video' ? 960 : imageSize.value.width)
const H = computed(() => useEditor.value ? editorViewport.value.height : medium.value === 'video' ? 600 : imageSize.value.height)
const current = computed(() => notes.value.find(n => n.id === selected.value))
const visibleNotes = computed(() => notes.value.filter(n => n.time === (medium.value === 'video' ? time.value : null)))
const timestamp = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(ms / 1000 % 60).toFixed(3).padStart(6, '0')}`
const currentSource = computed<MediaSource>(() => ({ name: medium.value === 'video' ? '交互演示（模拟视频）' : sourceName.value, type: useEditor.value ? 'editor' : medium.value, width: W.value, height: H.value, ...(useEditor.value ? { workspace: store.workspace?.rootPath, path: requestedEditor! } : {}) }))
const payload = computed(() => ({
  simulation: true,
  objects: notes.value.map(n => ({ id: n.id, kind: n.kind, media: n.media, coordinateSpace: n.media.type === 'editor' ? 'editor-viewport-css-pixels' : 'image-pixels', ...(n.element ? { element: n.element } : {}), source: n.from ?? n.box, ...(n.from ? { target: n.box } : {}), ...(n.time !== null ? { timestampMs: n.time } : {}), instruction: n.text, status: n.accepted ? '已验收（模拟）' : '待处理' })),
}))
let gesture: { kind: 'rectangle' | 'move'; start: { x: number; y: number }; from: Box; pointerId: number } | null = null
let lastDraft: { session: string; text: string } | null = null
watch(time, () => {
  if (current.value?.time !== time.value) { selected.value = null; pending.value = null; text.value = '' }
})
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function snapshot() { history.value.push(JSON.stringify({ notes: notes.value, position: position.value })); if (history.value.length > 30) history.value.shift(); submitted.value = false }
function undo() {
  const value = history.value.pop()
  if (!value) return
  const previous = JSON.parse(value) as { notes: Note[]; position: Box }
  notes.value = previous.notes; position.value = previous.position; selected.value = null; pending.value = null; text.value = ''; submitted.value = false
  status.value = '已撤销上一步。'
}
function selectNote(n: Note) { medium.value = n.time === null ? 'image' : 'video'; selected.value = n.id; text.value = n.text; pending.value = null; if (n.time !== null) time.value = n.time }
function addNote(kind: Note['kind'], box: Box | null, instruction = '', from?: Box, element?: ElementInfo) {
  snapshot()
  const note: Note = { id: Math.max(0, ...notes.value.map(n => n.id)) + 1, kind, box: clone(box), ...(from ? { from: clone(from) } : {}), ...(element ? { element } : {}), media: clone(currentSource.value), text: instruction, time: medium.value === 'video' ? time.value : null, accepted: false }
  notes.value.push(note); selectNote(note)
  status.value = instruction ? '已记录位置变化，可以继续补充意见。' : '已添加批注，请填写修改意见。'
}
function editorAnnotation(value: { kind: 'point' | 'rectangle' | 'move'; box: Box; from?: Box; element?: ElementInfo }) {
  const instruction = value.kind === 'move' ? `调整“${value.element?.text.slice(0, 28) || '所选元素'}”的位置：X ${value.from!.x} → ${value.box.x}，Y ${value.from!.y} → ${value.box.y}` : ''
  addNote(value.kind, value.box, instruction, value.from, value.element)
}
function saveText() {
  if (!text.value.trim()) { status.value = '先写下修改意见。'; return }
  if (current.value) { snapshot(); current.value.text = text.value.trim(); current.value.accepted = false }
  else addNote(pending.value ? 'rectangle' : 'global', pending.value, text.value.trim())
  status.value = '意见已保存到本轮反馈。'
}
function removeNote(n: Note) { snapshot(); notes.value = notes.value.filter(item => item.id !== n.id); if (selected.value === n.id) { selected.value = null; text.value = '' }; status.value = '已删除这条意见。' }
function point(event: PointerEvent) {
  const rect = svg.value!.getBoundingClientRect()
  const scale = Math.min(rect.width / W.value, rect.height / H.value)
  const offsetX = (rect.width - W.value * scale) / 2
  const offsetY = (rect.height - H.value * scale) / 2
  return { x: Math.round(Math.max(0, Math.min(W.value, (event.clientX - rect.left - offsetX) / scale))), y: Math.round(Math.max(0, Math.min(H.value, (event.clientY - rect.top - offsetY) / scale))) }
}
function start(event: PointerEvent) {
  if (event.button !== 0 || original.value) return
  const p = point(event)
  if (tool.value === 'point') { addNote('point', { ...p, w: 0, h: 0 }); return }
  if (tool.value === 'select') { selected.value = null; pending.value = null; text.value = ''; return }
  if (tool.value === 'move' && (imageUrl.value || p.x < position.value.x || p.x > position.value.x + position.value.w || p.y < position.value.y || p.y > position.value.y + position.value.h)) {
    status.value = imageUrl.value ? '导入图片请先用框批注表达目标；此方案用示例按钮演示拖动。' : '拖动右上角的“保存”按钮。'; return
  }
  gesture = { kind: tool.value, start: p, from: clone(position.value), pointerId: event.pointerId }
  svg.value!.setPointerCapture(event.pointerId)
  if (tool.value === 'rectangle') { selected.value = null; text.value = ''; pending.value = { ...p, w: 0, h: 0 } }
}
function move(event: PointerEvent) {
  if (!gesture || gesture.pointerId !== event.pointerId) return
  const p = point(event)
  if (gesture.kind === 'rectangle') pending.value = { x: Math.min(p.x, gesture.start.x), y: Math.min(p.y, gesture.start.y), w: Math.abs(p.x - gesture.start.x), h: Math.abs(p.y - gesture.start.y) }
  else position.value = { ...gesture.from, x: Math.max(0, Math.min(W.value - gesture.from.w, gesture.from.x + p.x - gesture.start.x)), y: Math.max(0, Math.min(H.value - gesture.from.h, gesture.from.y + p.y - gesture.start.y)) }
}
function end(event: PointerEvent) {
  if (!gesture || gesture.pointerId !== event.pointerId) return
  move(event)
  const g = gesture; gesture = null
  if (g.kind === 'move' && (position.value.x !== g.from.x || position.value.y !== g.from.y)) {
    const target = clone(position.value)
    position.value = g.from
    addNote('move', target, `移动保存按钮：X ${g.from.x} → ${target.x}，Y ${g.from.y} → ${target.y}`, g.from)
    position.value = target
  } else if (g.kind === 'rectangle' && pending.value && pending.value.w > 3 && pending.value.h > 3) {
    addNote('rectangle', pending.value)
  } else pending.value = null
  if (svg.value?.hasPointerCapture(event.pointerId)) svg.value.releasePointerCapture(event.pointerId)
}
function cancelGesture() { if (gesture?.kind === 'move') position.value = gesture.from; gesture = null; pending.value = null }
function switchMedium(value: 'image' | 'video') { cancelGesture(); medium.value = value; selected.value = null; text.value = ''; status.value = value === 'video' ? '拖动时间轴，在不同时间点添加意见。此处模拟视频画面。' : '框住一个区域，写下你想怎么改。' }
function reset() { snapshot(); notes.value = []; selected.value = null; text.value = ''; pending.value = null; position.value = { x: 756, y: 48, w: 124, h: 42 }; status.value = '本轮反馈已清空，可撤销。' }
async function loadImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.onload = () => { if (imageUrl.value) URL.revokeObjectURL(imageUrl.value); imageUrl.value = url; imageSize.value = { width: image.naturalWidth, height: image.naturalHeight }; sourceName.value = file.name; notes.value = []; history.value = []; selected.value = null; text.value = ''; pending.value = null; medium.value = 'image'; tool.value = 'rectangle'; status.value = '图片仅在当前浏览器读取；可以开始框选批注。'; input.value = '' }
  image.onerror = () => { URL.revokeObjectURL(url); status.value = '无法读取图片，请选择 PNG、JPEG 或 WebP。'; input.value = '' }
  image.src = url
}
function submit() {
  if (!notes.value.length || notes.value.some(n => !n.text.trim())) { status.value = '请给每条批注填写修改意见。'; return }
  const session = store.activeCliSessionId
  if (!session) { status.value = '请先在模拟工作区新建一个 CLI 会话。'; return }
  const existing = store.terminalDrafts[session] ?? ''
  const prefix = lastDraft?.session === session && existing.endsWith(lastDraft.text) ? existing.slice(0, -lastDraft.text.length) : `${existing}${existing ? '\n\n' : ''}`
  const draft = `视觉反馈（浏览器方案模拟，未发送真实 AI）\n${JSON.stringify(payload.value, null, 2)}`
  store.setTerminalDraft(session, prefix + draft)
  lastDraft = { session, text: draft }
  submitted.value = true; status.value = '反馈已放入左侧模拟 CLI 草稿，尚未发送。'
}
onBeforeUnmount(() => { if (imageUrl.value) URL.revokeObjectURL(imageUrl.value) })
</script>

<template>
  <section class="vf" :class="{ expanded }" aria-label="视觉反馈方案模拟">
    <header class="vf-title">
      <strong>视觉反馈</strong><span class="vf-badge">方案模拟 · 尚未实装</span>
      <div class="vf-spacer" />
      <button :title="expanded ? '返回分栏' : '展开画布'" @click="expanded = !expanded"><Maximize2 :size="14" /><span>{{ expanded ? '返回分栏' : '展开画布' }}</span></button>
      <button aria-label="关闭视觉反馈方案" @click="$emit('close')"><X :size="15" /></button>
    </header>
    <div class="vf-source">
      <button :class="{ active: medium === 'image' }" @click="switchMedium('image')">{{ editorTab ? '项目编辑器' : '图片 / 页面' }}</button>
      <button :class="{ active: medium === 'video' }" @click="switchMedium('video')">视频批注</button>
      <span class="vf-source-name">{{ medium === 'video' ? '交互演示 · 模拟视频' : sourceName }}</span>
      <button title="读取本地图片，仅当前浏览器可见" @click="fileInput?.click()"><ImagePlus :size="14" />导入图片</button>
      <input ref="fileInput" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="loadImage" />
    </div>
    <div class="vf-tools">
      <button v-for="item in tools" :key="item.id" :class="{ active: tool === item.id }" :aria-pressed="tool === item.id" @click="tool = item.id; original = false"><component :is="item.icon" :size="14" />{{ item.label }}</button>
      <button @click="selected = null; pending = null; text = ''; status = '在右侧填写整个画面的修改意见。'"><span>＋</span>全局意见</button>
      <div class="vf-spacer" />
      <button :disabled="!history.length" title="撤销上一步" @click="undo"><Undo2 :size="14" /></button>
      <button title="清空本轮反馈，可撤销" @click="reset"><RotateCcw :size="14" /></button>
    </div>
    <div class="vf-content">
      <div class="vf-canvas-column">
        <div class="vf-canvas-head"><span>{{ useEditor && tool === 'select' ? '浏览真实编辑器' : original ? '原始画面' : '目标示意' }}</span><span>{{ W }} × {{ H }} {{ useEditor ? 'CSS px' : 'px' }}</span></div>
        <div class="vf-canvas" :class="[{ 'real-editor': useEditor }, `tool-${tool}`]">
          <ProjectEditorFeedbackCanvas v-if="useEditor && editorTab" :tab="editorTab" :tool="tool" :original="original" :notes="visibleNotes" @annotation="editorAnnotation" @viewport="editorViewport = $event" @select="id => { const note = notes.find(n => n.id === id); if (note) selectNote(note) }" />
          <p v-else-if="editorError" role="alert">{{ editorError }}</p>
          <svg v-else ref="svg" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="可框选和拖动的反馈画布" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="cancelGesture">
            <image v-if="imageUrl && medium === 'image'" :href="imageUrl" :width="W" :height="H" />
            <g v-else class="vf-scene">
              <rect width="960" height="600" class="scene-bg" />
              <text x="64" y="73" class="scene-heading">项目概览</text>
              <text x="64" y="107" class="scene-muted">工作区与常用操作</text>
              <rect x="64" y="150" width="816" height="1" class="scene-line" />
              <rect x="64" y="184" width="390" height="210" rx="5" class="scene-card" />
              <text x="88" y="224" class="scene-subheading">工作区</text>
              <text x="88" y="266" class="scene-copy">打开文件，继续上次的工作。</text>
              <rect x="88" y="304" width="130" height="42" rx="3" class="scene-control" />
              <text x="153" y="330" text-anchor="middle" class="scene-copy">打开项目</text>
              <rect x="478" y="184" width="402" height="210" rx="5" class="scene-card" />
              <text x="502" y="224" class="scene-subheading">常用操作</text>
              <text x="502" y="266" class="scene-copy">编辑内容后，保存本次修改。</text>
              <text x="502" y="306" class="scene-muted">这是一张本地绘制的交互示例。</text>
              <rect x="64" y="422" width="816" height="94" rx="5" class="scene-card" />
              <text x="88" y="461" class="scene-subheading">最近打开</text>
              <text x="88" y="492" class="scene-muted">此处可框选，填写你希望调整的内容。</text>
              <rect v-if="!original && (position.x !== 756 || position.y !== 48)" x="756" y="48" width="124" height="42" rx="3" class="original-box" />
              <g :transform="`translate(${original ? 756 : position.x}, ${original ? 48 : position.y})`">
                <rect :width="position.w" :height="position.h" rx="3" class="scene-primary" />
                <text :x="position.w / 2" :y="position.h / 2 + 6" text-anchor="middle" class="scene-primary-text">保存</text>
                <rect v-if="tool === 'move' && !original" x="-4" y="-4" :width="position.w + 8" :height="position.h + 8" class="selection-outline" />
              </g>
              <g v-if="medium === 'video' && time >= 3000 && time < 7000">
                <rect x="650" y="105" width="230" height="128" rx="3" class="scene-control" />
                <text x="674" y="143" class="scene-copy">保存到当前工作区</text>
                <text x="674" y="185" class="scene-muted">菜单展开状态</text>
              </g>
              <text v-if="medium === 'video'" x="64" y="562" class="scene-muted">模拟播放位置：{{ timestamp(time) }}</text>
            </g>
            <g v-if="!original">
              <g v-for="note in visibleNotes" :key="note.id" class="annotation" @pointerdown.stop="selectNote(note)">
                <rect v-if="note.box && note.kind !== 'point'" :x="note.box.x" :y="note.box.y" :width="note.box.w" :height="note.box.h" :class="note.accepted ? 'accepted-box' : selected === note.id ? 'selected-box' : 'note-box'" />
                <g :transform="`translate(${note.box?.x ?? 20},${note.box?.y ?? 20})`"><rect width="30" height="25" class="note-label" /><text x="15" y="18" text-anchor="middle" class="note-number">{{ note.id }}</text></g>
              </g>
              <rect v-if="pending" :x="pending.x" :y="pending.y" :width="pending.w" :height="pending.h" class="selected-box" />
            </g>
          </svg>
        </div>
        <div v-if="medium === 'video'" class="vf-timeline">
          <div><strong>{{ timestamp(time) }}</strong><span> / 00:12.000 · 模拟视频</span><div class="vf-spacer" /><button @click="time = Math.max(0, time - 1000)">−1s</button><button @click="time = Math.min(12000, time + 1000)">+1s</button></div>
          <input v-model.number="time" aria-label="视频时间轴" type="range" min="0" max="12000" step="40" />
          <div class="vf-frame-list"><button v-for="frame in [...new Set(notes.filter(n => n.time !== null).map(n => n.time!))].sort((a, b) => a - b)" :key="frame" :class="{ active: time === frame }" @click="time = frame">{{ timestamp(frame) }}</button><span v-if="!notes.some(n => n.time !== null)">添加意见后，这里显示已标注时间点。</span></div>
        </div>
        <div class="vf-canvas-footer"><button :class="{ active: original }" @click="original = true">{{ useEditor ? '原始布局' : '原图' }}</button><button :class="{ active: !original }" @click="original = false">目标示意</button><span>{{ useEditor ? '真实页面与查询数据 · 布局仅浏览器模拟' : imageUrl ? '本地图片，不上传' : '示例数据 · 拖动布局可操作保存按钮' }}</span></div>
      </div>
      <aside class="vf-feedback">
        <div class="vf-feedback-title"><strong>修改意见</strong><span>{{ notes.length }} 条</span></div>
        <div class="vf-notes">
          <div v-if="!notes.length" class="vf-empty"><Square :size="24" /><strong>先指出要改的地方</strong><p>{{ useEditor ? '先浏览分类和物品。' : '在画布拖出一个框。' }}<br />再框选区域，写下修改意见。</p><button @click="tool = 'move'; status = useEditor ? '拖动页面里的按钮或物品卡片，只改变浏览器示意。' : '直接拖动右上角的保存按钮。'">{{ useEditor ? '试试拖动页面元素' : '试试拖动保存按钮' }}</button></div>
          <div v-for="note in notes" :key="note.id" class="vf-note" :class="{ selected: selected === note.id }">
            <button class="vf-note-main" @click="selectNote(note)"><span class="vf-note-id">{{ String(note.id).padStart(2, '0') }}</span><span><strong>{{ note.kind === 'move' ? '布局调整' : note.kind === 'global' ? '全局意见' : '区域批注' }}<small v-if="note.time !== null">{{ timestamp(note.time) }}</small></strong><span>{{ note.text || '待填写修改意见' }}</span></span></button>
            <div class="vf-note-actions"><button :aria-label="`删除意见 ${note.id}`" @click="removeNote(note)"><Trash2 :size="12" /></button><button v-if="submitted" :class="{ active: note.accepted }" @click="snapshot(); note.accepted = !note.accepted; submitted = true"><Check :size="12" />{{ note.accepted ? '已验收' : '验收' }}</button></div>
          </div>
        </div>
        <div class="vf-note-editor">
          <label for="vf-instruction">{{ current ? `意见 ${String(current.id).padStart(2, '0')}` : '全局意见' }}</label>
          <div v-if="current?.box" class="vf-coordinates">X {{ current.box.x }} · Y {{ current.box.y }} · {{ current.box.w }} × {{ current.box.h }} px</div>
          <div v-if="current?.element" class="vf-coordinates" :title="current.element.selector">{{ current.element.tag }} · {{ current.element.text.slice(0, 36) }}</div>
          <textarea id="vf-instruction" v-model="text" placeholder="例如：按钮移到标题旁，间距 16px。" @keydown.ctrl.enter.prevent="saveText" />
          <button class="vf-save-note" :disabled="!text.trim()" @click="saveText">保存意见</button>
        </div>
      </aside>
    </div>
    <footer class="vf-bottom"><span role="status">{{ status }}</span><div><button @click="showData = !showData">{{ showData ? '关闭数据' : '查看反馈' }}</button><button class="vf-primary" :disabled="!notes.length" @click="submit">{{ submitted ? '更新模拟 CLI 草稿' : '添加到模拟 CLI 草稿' }}</button></div></footer>
    <div v-if="showData" class="vf-data"><header><strong>结构化反馈 · 浏览器模拟</strong><button aria-label="关闭反馈数据" @click="showData = false"><X :size="14" /></button></header><pre>{{ JSON.stringify(payload, null, 2) }}</pre><p>原图打包与真实 AI 等待接口尚未接入。</p></div>
  </section>
</template>

<style scoped>
.vf { position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; min-width: 0; overflow: hidden; background: var(--color-bg-primary); color: var(--color-text-primary); font-family: var(--font-ui); font-weight: var(--font-ui-weight); container-type: inline-size; }
.vf.expanded { position: fixed; inset: 76px 12px 12px 56px; z-index: 35; border: 1px solid var(--color-border); }
.vf button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; gap: 5px; min-height: 28px; padding: 4px 8px; color: var(--color-text-secondary); border: 1px solid transparent; border-radius: 3px; background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.vf button:hover { background: var(--color-bg-hover); color: var(--color-text-primary); }
.vf button.active { color: var(--color-accent-blue); background: var(--surface-accent-blue-soft); border-color: var(--surface-accent-blue-border); }
.vf button:disabled { opacity: .4; cursor: default; }
.vf button:focus-visible, .vf textarea:focus-visible, .vf input:focus-visible { outline: 1px solid var(--color-accent-blue); outline-offset: 1px; }
.vf strong { font-weight: var(--sh-weight-emphasis); }
.vf-title, .vf-source, .vf-tools { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.vf-title { background: var(--color-bg-secondary); font-size: 13px; }
.vf-badge { color: var(--color-accent-yellow); font-size: 11px; border-left: 1px solid var(--color-border); padding-left: 8px; white-space: nowrap; }
.vf-spacer { flex: 1; }
.vf-source, .vf-tools { overflow-x: auto; white-space: nowrap; }
.vf-source-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; flex: 1; font-size: 11px; color: var(--color-text-muted); }
.vf-content { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 260px; }
.vf-canvas-column { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.vf-canvas-head { display: flex; justify-content: space-between; padding: 10px 14px; color: var(--color-text-secondary); font-size: 11px; }
.vf-canvas { min-height: 130px; flex: 1; display: flex; align-items: center; justify-content: center; padding: 18px; background: var(--color-bg-secondary); overflow: hidden; }
.vf-canvas.real-editor { padding: 0; align-items: stretch; }
.vf-canvas svg { width: 100%; height: 100%; touch-action: none; user-select: none; }
.tool-rectangle svg, .tool-point svg { cursor: crosshair; }
.tool-move svg { cursor: move; }
.vf-scene text { font-family: var(--font-ui); font-weight: var(--font-ui-weight); }
.scene-bg { fill: var(--color-bg-primary); }
.scene-card { fill: var(--color-bg-secondary); stroke: var(--color-border); }
.scene-control { fill: var(--color-bg-tertiary); stroke: var(--color-border); }
.scene-line { fill: var(--color-border); }
.scene-heading { fill: var(--color-text-primary); font-size: 30px; font-weight: var(--sh-weight-heading) !important; }
.scene-subheading { fill: var(--color-text-primary); font-size: 20px; font-weight: var(--sh-weight-emphasis) !important; }
.scene-copy { fill: var(--color-text-primary); font-size: 17px; }
.scene-muted { fill: var(--color-text-secondary); font-size: 15px; }
.scene-primary { fill: var(--surface-accent-blue-strong); stroke: var(--color-accent-blue); }
.scene-primary-text { fill: var(--color-text-primary); font-size: 18px; }
.original-box { fill: none; stroke: var(--color-text-muted); stroke-dasharray: 6 5; }
.selection-outline, .selected-box, .note-box, .accepted-box { fill: var(--surface-accent-blue-soft); stroke: var(--color-accent-blue); stroke-width: 2; vector-effect: non-scaling-stroke; }
.selection-outline { fill: none; stroke-dasharray: 5 3; }
.note-box { stroke-dasharray: 5 3; }
.accepted-box { stroke: var(--color-accent-green); fill: var(--surface-success-soft); }
.note-label { fill: var(--color-accent-blue); }
.note-number { fill: var(--color-bg-primary); font-family: var(--font-mono); font-size: 16px; font-weight: var(--sh-weight-strong); }
.annotation { cursor: pointer; }
.vf-canvas-footer { display: flex; align-items: center; gap: 5px; padding: 7px 10px; border-top: 1px solid var(--color-border); }
.vf-canvas-footer > span { margin-left: auto; font-size: 10px; color: var(--color-text-muted); }
.vf-feedback { border-left: 1px solid var(--color-border); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.vf-feedback-title { padding: 12px; display: flex; justify-content: space-between; font-size: 12px; border-bottom: 1px solid var(--color-border); }
.vf-feedback-title > span { color: var(--color-text-secondary); }
.vf-notes { flex: 1; min-height: 80px; overflow-y: auto; }
.vf-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 26px 18px; font-size: 12px; color: var(--color-text-secondary); }
.vf-empty svg { color: var(--color-accent-blue); }
.vf-empty p { margin: 0; line-height: 1.8; }
.vf-empty button { border-color: var(--color-border); }
.vf-note { padding: 9px 8px; border-bottom: 1px solid var(--color-border); border-left: 2px solid transparent; }
.vf-note.selected { border-left-color: var(--color-accent-blue); background: var(--surface-accent-blue-soft); }
.vf-note-main { width: 100%; align-items: flex-start !important; text-align: left; }
.vf-note-id { background: var(--surface-accent-blue-soft); color: var(--color-accent-blue); padding: 3px; font-family: var(--font-mono); }
.vf-note-main > span:last-child { flex: 1; min-width: 0; }
.vf-note-main strong { display: flex; align-items: center; gap: 7px; color: var(--color-text-primary); font-size: 12px; }
.vf-note-main small { color: var(--color-text-secondary); font-size: 10px; font-family: var(--font-mono); }
.vf-note-main strong + span { display: block; line-height: 1.6; padding-top: 5px; overflow-wrap: anywhere; }
.vf-note-actions { display: flex; justify-content: flex-end; }
.vf-note-editor { padding: 12px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--color-border); }
.vf-note-editor label { font-size: 12px; }
.vf-coordinates { font-size: 10px; color: var(--color-text-secondary); font-family: var(--font-mono); }
.vf-note-editor textarea { resize: vertical; width: 100%; min-height: 85px; max-height: 160px; padding: 8px; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-primary); background: var(--color-input-bg); font-family: var(--font-ui); font-size: 12px; line-height: 1.7; }
.vf-save-note { border-color: var(--color-border) !important; align-self: flex-end; }
.vf-bottom { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border-top: 1px solid var(--color-border); flex-wrap: wrap; background: var(--color-bg-secondary); }
.vf-bottom > span { flex: 1; min-width: 160px; color: var(--color-text-secondary); font-size: 11px; line-height: 1.6; }
.vf-bottom > div { display: flex; gap: 6px; }
.vf-primary { background: var(--surface-accent-blue-soft) !important; color: var(--color-accent-blue) !important; border-color: var(--surface-accent-blue-border) !important; }
.vf-timeline { padding: 8px 12px; border-top: 1px solid var(--color-border); font-size: 11px; }
.vf-timeline > div { display: flex; align-items: center; gap: 5px; }
.vf-timeline > input { width: 100%; accent-color: var(--color-accent-blue); }
.vf-timeline span { color: var(--color-text-secondary); }
.vf-frame-list { overflow-x: auto; white-space: nowrap; min-height: 29px; }
.vf-data { position: absolute; inset: 44px 10px 10px; z-index: 8; background: var(--color-bg-primary); border: 1px solid var(--color-border); display: flex; flex-direction: column; }
.vf-data header { display: flex; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--color-border); font-size: 12px; }
.vf-data pre { overflow: auto; flex: 1; padding: 12px; margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; }
.vf-data p { padding: 10px 12px; margin: 0; color: var(--color-text-secondary); font-size: 11px; border-top: 1px solid var(--color-border); }
@container (max-width: 740px) {
  .vf-content { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(160px, 1fr) minmax(180px, .65fr); }
  .vf-feedback { border-left: 0; border-top: 1px solid var(--color-border); display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, .85fr); grid-template-rows: 35px minmax(0, 1fr); }
  .vf-feedback-title { grid-column: 1 / -1; padding: 8px 12px; }
  .vf-note-editor { border-top: 0; border-left: 1px solid var(--color-border); overflow: auto; }
  .vf-empty { padding: 12px; gap: 6px; }
  .vf-empty > svg { display: none; }
  .vf-canvas-footer > span { display: none; }
  .vf-title button > span { display: none; }
  .vf-canvas { padding: 10px; }
}
@container (max-width: 410px) {
  .vf-feedback { grid-template-columns: minmax(0, 1fr); grid-template-rows: 35px minmax(60px, 1fr) auto; }
  .vf-note-editor { border-left: 0; border-top: 1px solid var(--color-border); padding: 8px; }
  .vf-note-editor textarea { min-height: 55px; }
  .vf-badge { font-size: 10px; }
  .vf-source-name { display: none; }
}
</style>
