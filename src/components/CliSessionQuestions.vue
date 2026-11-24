<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import CliQuestionForm from './CliQuestionForm.vue'
import { backend } from '@/lib/tauri'
import type { PlanRequest } from '@/lib/cliCompletion'
import { emptyQuestionDraft, questionRequestKey, sessionQuestions } from '@/lib/cliQuestions'

const props = withDefaults(defineProps<{ sessionId: string; visible?: boolean }>(), { visible: true })
const emit = defineEmits<{ 'answer-click': [event: MouseEvent]; pending: [value: boolean] }>()
const state = computed(() => sessionQuestions(props.sessionId))
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
async function poll(epoch = generation) {
  const current = state.value
  const sessionId = props.sessionId
  const revision = current.revision
  try {
    if (current.submitting) return
    const requests = await backend.listCliPlanRequests(sessionId)
    if (disposed || epoch !== generation || revision !== current.revision) return
    current.requests = requests
    current.confirmed = true
    current.pollError = ''
    const keys = new Set(requests.map(questionRequestKey))
    for (const key of Object.keys(current.drafts)) if (!keys.has(key) && key !== current.submitting) delete current.drafts[key]
    for (const request of requests) current.drafts[questionRequestKey(request)] ??= emptyQuestionDraft()
    emit('pending', requests.length > 0)
  } catch (error) {
    if (!disposed && epoch === generation) { current.confirmed = false; current.pollError = String(error) }
  } finally {
    if (!disposed && epoch === generation && props.visible) timer = setTimeout(() => { void poll(epoch) }, 1000)
  }
}
watch(() => [props.sessionId, props.visible] as const, () => {
  generation++
  clearTimeout(timer)
  state.value.confirmed = false
  emit('pending', state.value.requests.length > 0)
  if (props.visible) void poll()
}, { immediate: true })
async function submit(request: PlanRequest, answers: Record<string, string[]>) {
  const current = state.value
  const sessionId = props.sessionId
  const key = questionRequestKey(request)
  if (!current.confirmed || current.submitting) return
  current.submitting = key
  current.revision++
  current.error = ''
  try {
    await backend.replyCliPlan(sessionId, request.connection, request.requestId, answers)
    current.requests = current.requests.filter(item => questionRequestKey(item) !== key)
    delete current.drafts[key]
    if (!disposed && sessionId === props.sessionId) {
      // Discard an older in-flight snapshot that could resurrect the answered card.
      generation++
      clearTimeout(timer)
      emit('pending', current.requests.length > 0)
      if (props.visible) void poll()
    }
  } catch (error) { current.error = String(error) }
  finally { current.submitting = ''; current.revision++ }
}
onBeforeUnmount(() => { disposed = true; generation++; clearTimeout(timer) })
</script>

<template>
  <section v-if="state.requests.length || state.pollError" class="cli-session-questions" aria-label="CLI 待答问题">
    <CliQuestionForm v-for="request in state.requests" :key="questionRequestKey(request)" v-model:draft="state.drafts[questionRequestKey(request)]"
      :request="request" :disabled="!state.confirmed || !!state.submitting" :submitting="state.submitting === questionRequestKey(request)"
      @submit="submit(request, $event)" @answer-click="emit('answer-click', $event)" />
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.pollError" role="alert">{{ state.pollError }}</p>
  </section>
</template>

<style scoped>
.cli-session-questions { display: flex; flex-direction: column; gap: 8px; min-width: 0; max-height: 55vh; overflow: auto; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-secondary); }
.cli-session-questions > * { flex-shrink: 0; }
p { margin: 0; color: var(--color-text-secondary); font: inherit; font-size: 12px; overflow-wrap: anywhere; }
</style>
