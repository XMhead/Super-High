<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SuperhighHtmlPreview from '@/components/SuperhighHtmlPreview.vue'
import type { EditorTab } from '@/types'

type Box = { x: number; y: number; w: number; h: number }
type ElementInfo = { selector: string; tag: string; text: string; scrollX: number; scrollY: number }
type FeedbackMark = { id: number; kind: string; box: Box | null; from?: Box; element?: ElementInfo; accepted: boolean }
const props = defineProps<{ tab: EditorTab; tool: string; original: boolean; notes: FeedbackMark[] }>()
const emit = defineEmits<{
  annotation: [value: { kind: 'point' | 'rectangle' | 'move'; box: Box; from?: Box; element?: ElementInfo }]
  viewport: [value: { width: number; height: number }]
  select: [id: number]
}>()
const host = ref<HTMLElement | null>(null)
const channel = `feedback-${crypto.randomUUID()}`
// This instrumentation is appended only to the in-memory preview tab.
// The source editor, its business handlers and its injected SuperHigh bridge stay intact.
const instrumentation = String.raw`(() => {
  const channel = CHANNEL;
  let state = { tool: 'select', original: false, notes: [] }, gesture = null;
  const transforms = new Map();
  const overlay = document.createElement('div');
  overlay.id = '__visual_feedback_overlay';
  Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483000', pointerEvents: 'none', overflow: 'hidden' });
  document.body.append(overlay);
  const send = (type, value) => parent.postMessage({ channel, type, value }, '*');
  const size = () => send('viewport', { width: innerWidth, height: innerHeight });
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const selector = el => {
    const parts = [];
    while (el && el !== document.documentElement) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let part = el.tagName.toLowerCase();
      const siblings = el.parentElement ? [...el.parentElement.children].filter(n => n.tagName === el.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      parts.unshift(part); el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const info = el => ({ selector: selector(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || '').trim().slice(0, 120), scrollX, scrollY });
  function draw(box, id, accepted = false) {
    if (!box) return;
    const border = document.createElement('div');
    Object.assign(border.style, { position: 'absolute', left: box.x + 'px', top: box.y + 'px', width: Math.max(2, box.w) + 'px', height: Math.max(2, box.h) + 'px', border: '2px solid var(' + (accepted ? '--color-accent-green' : '--color-accent-blue') + ')', background: 'var(--surface-accent-blue-soft)' });
    if (id) {
      const label = document.createElement('button'); label.textContent = String(id).padStart(2, '0');
      Object.assign(label.style, { position:'absolute', top:'0', left:box.w < 80 ? (box.w + 3) + 'px' : '0', pointerEvents:'auto', minHeight:'20px', padding:'1px 4px', borderRadius:'0', border:'0', background:'var(--color-accent-blue)', color:'var(--color-bg-primary)', font:'inherit' });
      label.addEventListener('click', e => { e.stopPropagation(); send('select', id); }); border.append(label);
    }
    overlay.append(border);
  }
  function render() {
    for (const [element, value] of transforms) if (element.isConnected) element.style.transform = value;
    transforms.clear(); overlay.replaceChildren();
    if (state.original) return;
    const bases = new Map();
    for (const n of state.notes) {
      if (n.kind !== 'move' || !n.element?.selector || !n.box) continue;
      const element = document.querySelector(n.element.selector);
      if (!element) continue;
      if (!bases.has(element)) { bases.set(element, rect(element)); transforms.set(element, element.style.transform); }
      const base = bases.get(element);
      element.style.transform = transforms.get(element) + ' translate(' + (n.box.x - base.x) + 'px,' + (n.box.y - base.y) + 'px)';
    }
    for (const n of state.notes) draw(n.box, n.id, n.accepted);
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data.type !== 'state') return;
    state = event.data.value; render(); size();
  });
  const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.tool === 'select' || state.original || overlay.contains(event.target)) return;
    const target = event.target.closest('.card,button,input,.top,.sidebar') || event.target;
    const box = rect(target), element = info(target);
    stop(event);
    if (state.tool === 'point') { send('annotation', { kind: 'point', box: { x: event.clientX, y: event.clientY, w: 0, h: 0 }, element }); return; }
    gesture = { kind: state.tool, x: event.clientX, y: event.clientY, target, from: box, element, transform: target.style.transform, pointerId: event.pointerId, dx: 0, dy: 0 };
    document.documentElement.setPointerCapture(event.pointerId);
  }, true);
  document.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    stop(event); const g = gesture;
    g.dx = Math.max(-g.from.x, Math.min(innerWidth - g.from.x - g.from.w, event.clientX - g.x));
    g.dy = Math.max(-g.from.y, Math.min(innerHeight - g.from.y - g.from.h, event.clientY - g.y));
    if (g.kind === 'move') g.target.style.transform = g.transform + ' translate(' + g.dx + 'px,' + g.dy + 'px)';
    else { overlay.replaceChildren(); draw({ x: Math.min(g.x, event.clientX), y: Math.min(g.y, event.clientY), w: Math.abs(event.clientX - g.x), h: Math.abs(event.clientY - g.y) }); }
  }, true);
  document.addEventListener('pointerup', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    stop(event); const g = gesture; gesture = null;
    if (document.documentElement.hasPointerCapture(event.pointerId)) document.documentElement.releasePointerCapture(event.pointerId);
    if (g.kind === 'move') {
      g.target.style.transform = g.transform;
      if (Math.abs(g.dx) + Math.abs(g.dy) > 2) send('annotation', { kind: 'move', from: g.from, box: { ...g.from, x: Math.round(g.from.x + g.dx), y: Math.round(g.from.y + g.dy) }, element: g.element });
    } else {
      const box = { x: Math.round(Math.min(g.x, event.clientX)), y: Math.round(Math.min(g.y, event.clientY)), w: Math.round(Math.abs(event.clientX - g.x)), h: Math.round(Math.abs(event.clientY - g.y)) };
      if (box.w > 3 && box.h > 3) send('annotation', { kind: 'rectangle', box, element: g.element });
    }
    render();
  }, true);
  document.addEventListener('pointercancel', () => { if (gesture) { gesture.target.style.transform = gesture.transform; gesture = null; render(); } }, true);
  document.addEventListener('click', event => { if (state.tool !== 'select' && !state.original && !overlay.contains(event.target)) stop(event); }, true);
  document.addEventListener('wheel', event => { if (state.tool !== 'select' && !state.original) stop(event); }, { capture: true, passive: false });
  new ResizeObserver(size).observe(document.documentElement);
  send('ready', null); size();
})();`.replace('CHANNEL', JSON.stringify(channel))
const previewTab = computed<EditorTab>(() => ({ ...props.tab, content: props.tab.content.replace(/<\/body>/i, '<script>' + instrumentation + '<' + '/script></body>') }))
function frame() { return host.value?.querySelector('iframe') }
function sendState() { frame()?.contentWindow?.postMessage({ channel, type: 'state', value: { tool: props.tool, original: props.original, notes: JSON.parse(JSON.stringify(props.notes)) } }, '*') }
function onMessage(event: MessageEvent) {
  if (event.source !== frame()?.contentWindow || event.data?.channel !== channel) return
  if (event.data.type === 'ready') sendState()
  else if (event.data.type === 'viewport') emit('viewport', event.data.value)
  else if (event.data.type === 'annotation') emit('annotation', event.data.value)
  else if (event.data.type === 'select') emit('select', event.data.value)
}
watch(() => [props.tool, props.original, props.notes], sendState, { deep: true, flush: 'post' })
onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template><div ref="host" class="project-feedback-canvas"><SuperhighHtmlPreview :tab="previewTab" /></div></template>
<style scoped>
.project-feedback-canvas { flex: 1; min-width: 0; min-height: 0; height: 100%; }
.project-feedback-canvas :deep(.html-preview-shell) { height: 100%; }
.project-feedback-canvas :deep(iframe) { width: 100%; height: 100%; border: 0; }
</style>
