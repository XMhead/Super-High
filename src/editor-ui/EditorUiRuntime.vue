<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, reactive, ref } from 'vue'
import { compileSuperhighUi } from '@/lib/superhighUi'
import { createUiScope, indexUiFields } from '@/lib/superhighUiFields'
import { SUPERHIGH_UI_CONTEXT, SuperhighUiNode } from '@/components/SuperhighUiNode'
import { editorUiSource } from '@/lib/editorUiSource'

const source = ref('')
const values = reactive<Record<string, unknown>>({})
const data = ref<Record<string, unknown>>({})
const doc = computed(() => compileSuperhighUi(source.value))
const fields = computed(() => indexUiFields(doc.value.root))
const scope = createUiScope(() => fields.value, values, src => data.value[src])
const snapshot = () => Object.fromEntries([...new Set([...fields.value.keys(), ...Object.keys(values)])].map(name => [name, scope.field(name)]))
const send = (type: string, payload: Record<string, unknown> = {}) => window.parent.postMessage(JSON.parse(JSON.stringify({ type: `superhigh-iui:${type}`, ...payload })), '*')
provide(SUPERHIGH_UI_CONTEXT, {
  values,
  setValue: (name, value) => { values[name] = value; send('change', { name, value, values: snapshot() }) },
  emitAction: action => send('action', { action: { ...action, values: action.values ?? snapshot() }, values: snapshot() }),
  beginDrag: () => undefined,
  resolveImage: async src => src,
  resolveMedia: async src => src,
  resolvePlayableMedia: async src => src,
  openResource: async src => { send('open-resource', { src }) },
  imageRevision: () => '',
  dragEnabled: ref(false),
  scope,
})
function receive(event: MessageEvent) {
  if (event.source !== window.parent || event.data?.type !== 'superhigh-iui:update') return
  const payload = event.data
  try {
    if (payload.source !== undefined) {
      source.value = editorUiSource(payload.source)
    }
    if (payload.values) {
      for (const key of Object.keys(values)) delete values[key]
      Object.assign(values, payload.values)
    }
    if (payload.data) data.value = payload.data
    if (payload.theme) {
      let fonts = document.getElementById('editor-iui-fonts')
      if (!fonts) { fonts = document.createElement('style'); fonts.id = 'editor-iui-fonts'; document.head.append(fonts) }
      fonts.textContent = payload.theme.fontFaces ?? ''
      for (const [name, value] of Object.entries(payload.theme.vars ?? {})) document.documentElement.style.setProperty(name, String(value))
      document.documentElement.style.colorScheme = payload.theme.colorScheme
      document.documentElement.toggleAttribute('data-md-heading-colors', false)
      if (payload.theme.markdownHeadingColors) document.documentElement.setAttribute('data-md-heading-colors', 'rgba')
    }
    send('rendered', { diagnostics: doc.value.diagnostics, values: snapshot() })
  } catch (error) { send('error', { message: String(error) }) }
}
let resize: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('message', receive)
  resize = new ResizeObserver(() => send('resize', { height: document.getElementById('app')!.scrollHeight }))
  resize.observe(document.getElementById('app')!)
  send('ready')
})
onBeforeUnmount(() => { resize?.disconnect(); window.removeEventListener('message', receive) })
</script>

<template>
  <main class="shui-root editor-iui">
    <SuperhighUiNode v-if="doc.root" :node="doc.root" />
    <div v-for="(error, index) in doc.diagnostics" :key="index" class="shui-error">{{ error.message }}</div>
  </main>
</template>

<style>
html, body, #app { height: auto; min-height: 0; overflow: visible; }
.editor-iui { padding: 6px; min-width: 0; }
</style>
