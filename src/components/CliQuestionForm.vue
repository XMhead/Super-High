<script setup lang="ts">
import { computed, reactive, useId } from 'vue'
import type { PlanRequest } from '@/lib/cliCompletion'
import { emptyQuestionDraft, type CliQuestionDraft } from '@/lib/cliQuestions'
import { renderMarkdown } from '@/lib/markdown'

const props = defineProps<{ request: PlanRequest; disabled?: boolean; submitting?: boolean; error?: string; asyncQuestion?: boolean }>()
const emit = defineEmits<{ submit: [answers: Record<string, string[]>]; 'answer-click': [event: MouseEvent] }>()
const draft = defineModel<CliQuestionDraft>('draft', { default: () => reactive(emptyQuestionDraft()) })
const formId = useId()
const selected = (id: string) => draft.value.multi[id]?.length ? draft.value.multi[id]! : draft.value.choices[id] ? [draft.value.choices[id]!] : []
const canSubmit = computed(() => !props.disabled && !props.submitting && props.request.questions.length > 0
  && props.request.questions.every(q => selected(q.id).length || draft.value.notes[q.id]?.trim()))
function toggleMulti(id: string, label: string) {
  const current = draft.value.multi[id] ?? []
  draft.value.multi[id] = current.includes(label) ? current.filter(item => item !== label) : [...current, label]
}
function submit() {
  if (canSubmit.value) emit('submit', Object.fromEntries(props.request.questions.map(q => [q.id,
    [...selected(q.id), draft.value.notes[q.id]?.trim()].filter((v): v is string => !!v)])))
}
</script>

<template>
  <form class="cli-question-form notice-plan" @submit.prevent="submit" @keydown.stop>
    <div class="notice-questions">
      <fieldset v-for="question in request.questions" :key="question.id" :disabled="disabled || submitting">
        <legend>{{ question.header || (asyncQuestion || request.asyncQuestion ? '待答问题' : 'Plan 问题') }}</legend>
        <div class="markdown-body" @click="emit('answer-click', $event)" v-html="renderMarkdown(question.question, { escapeRawHtml: true })" />
        <label v-for="option in question.options" :key="option.label" class="notice-option" :class="{ selected: selected(question.id).includes(option.label) }">
          <input v-if="question.multiSelect" type="checkbox" :value="option.label" :checked="draft.multi[question.id]?.includes(option.label)" @change="toggleMulti(question.id, option.label)">
          <input v-else v-model="draft.choices[question.id]" type="radio" :name="`${formId}:${question.id}`" :value="option.label">
          <span><strong>{{ option.label }}</strong><span v-if="option.description">{{ option.description }}</span></span>
        </label>
        <label v-if="question.options.length && !question.multiSelect" class="notice-option" :class="{ selected: draft.choices[question.id] === '' }">
          <input v-model="draft.choices[question.id]" type="radio" :name="`${formId}:${question.id}`" value="">
          <span>其他回答</span>
        </label>
        <label class="notice-notes">{{ question.options.length ? '补充说明或其他回答' : '回答' }}
          <input v-if="question.isSecret" v-model="draft.notes[question.id]" type="password" autocomplete="off">
          <textarea v-else v-model="draft.notes[question.id]" rows="2" />
        </label>
      </fieldset>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <button class="notice-submit" type="submit" :disabled="!canSubmit">{{ submitting ? '正在回复…' : asyncQuestion || request.asyncQuestion ? '发送回答' : '回复此 Plan' }}</button>
  </form>
</template>

<style scoped>
.cli-question-form { display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; overflow: hidden; font-family: var(--font-ui); font-size: 13px; color: var(--color-text-primary); }
.notice-questions { min-height: 0; overflow: auto; }
.notice-submit, [role="alert"] { flex-shrink: 0; }
fieldset { min-width: 0; margin: 0 0 8px; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; }
legend { font-weight: var(--sh-weight-emphasis); padding: 0 4px; }
.markdown-body { font-size: inherit; overflow-wrap: anywhere; }
.notice-option { display: flex; gap: 6px; padding: 6px; margin-top: 4px; border: 1px solid var(--color-border); border-radius: 3px; cursor: pointer; }
.notice-option.selected { border-color: var(--chat-accent, var(--notice-accent, var(--color-border))); background: var(--color-bg-hover); }
.notice-option > span { min-width: 0; overflow-wrap: anywhere; }
.notice-option strong { display: block; font-size: inherit; font-weight: var(--sh-weight-emphasis); line-height: 1.5; }
.notice-option span span { display: block; color: var(--color-text-secondary); font-size: 12px; }
.notice-notes { display: grid; gap: 4px; margin-top: 8px; color: var(--color-text-secondary); }
textarea, input[type="password"] { box-sizing: border-box; width: 100%; padding: 6px; font: inherit; color: var(--color-text-primary); background: var(--color-bg-primary); border: 1px solid var(--color-border); border-radius: 3px; resize: vertical; }
.notice-submit { align-self: flex-start; padding: 6px 10px; border: 1px solid var(--color-border); border-radius: 3px; background: var(--color-bg-primary); color: var(--color-text-primary); font: inherit; cursor: pointer; }
.notice-submit:disabled { opacity: .5; cursor: default; }
[role="alert"] { margin: 0; color: var(--color-text-secondary); }
</style>
