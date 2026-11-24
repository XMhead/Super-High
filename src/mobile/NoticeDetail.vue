<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { renderMarkdown } from '@/lib/markdown'
import CliProviderIcon from '@/components/icons/CliProviderIcon.vue'
import type { PlanRequest } from '@/lib/cliCompletion'
import { applyTheme, THEMES } from '@/lib/theme'
import { applyFontStyle } from '@/lib/fontStyles'

type Detail = { title: string; provider: string; body: string; plan: boolean; planRequest: PlanRequest | null; themeId?: string; fontStyleId?: string }
type Native = { load(): void; reply(json: string): void; close(): void }
const native = (window as Window & { SuperHighNoticeDetail?: Native }).SuperHighNoticeDetail
const detail = ref<Detail | null>(null)
const selected = ref<Record<string, string[]>>({})
const notes = ref<Record<string, string>>({})
const error = ref('')
const busy = ref(false)
const loading = ref(true)
const complete = computed(() => !!detail.value?.planRequest?.questions.every(q => selected.value[q.id]?.length || notes.value[q.id]?.trim()))

function receive(event: Event) {
  const value = (event as CustomEvent).detail
  if (value?.type === 'detail') {
    detail.value = value.detail
    if (detail.value?.themeId && THEMES[detail.value.themeId]) applyTheme(detail.value.themeId)
    if (detail.value?.fontStyleId) applyFontStyle(detail.value.fontStyleId)
    if (value.draft && detail.value?.planRequest?.questions[0]) notes.value[detail.value.planRequest.questions[0].id] = value.draft
    loading.value = false; error.value = ''
  } else if (value?.type === 'load-error' || value?.type === 'reply-error') {
    loading.value = false; busy.value = false; error.value = String(value.error || '请重试')
  }
}
function choose(id: string, label: string, multi: boolean) {
  const current = selected.value[id] ?? []
  selected.value[id] = multi ? current.includes(label) ? current.filter(value => value !== label) : [...current, label] : [label]
}
function submit() {
  if (!complete.value || !detail.value?.planRequest || !native) return
  const answers = Object.fromEntries(detail.value.planRequest.questions.map(q => [q.id, [...(selected.value[q.id] ?? []), notes.value[q.id]?.trim()].filter(Boolean)]))
  busy.value = true; error.value = ''
  native.reply(JSON.stringify(answers))
}
function load() { loading.value = true; error.value = ''; native?.load() }
onMounted(() => { window.addEventListener('superhigh:notice-detail', receive); load() })
onBeforeUnmount(() => window.removeEventListener('superhigh:notice-detail', receive))
</script>

<template>
  <main class="notice-detail">
    <header><CliProviderIcon v-if="detail" :provider="detail.provider" :size="20" /><strong>{{ detail?.title || '通知详情' }}</strong></header>
    <section class="notice-detail-content">
      <p v-if="loading">正在读取通知…</p>
      <template v-else-if="detail">
        <form v-if="detail.planRequest" id="notice-form" @submit.prevent="submit">
          <fieldset v-for="question in detail.planRequest.questions" :key="question.id" :disabled="busy">
            <legend>{{ question.header || '待答问题' }}</legend>
            <div class="markdown-body" v-html="renderMarkdown(question.question)" />
            <label v-for="option in question.options" :key="option.label" class="notice-choice">
              <input :type="question.multiSelect ? 'checkbox' : 'radio'" :name="question.id" :checked="selected[question.id]?.includes(option.label)" @change="choose(question.id, option.label, !!question.multiSelect)">
              <span><strong>{{ option.label }}</strong><span v-if="option.description">{{ option.description }}</span></span>
            </label>
            <label class="notice-input">{{ question.options.length ? '补充说明或其他回答' : '回答' }}
              <input v-if="question.isSecret" v-model="notes[question.id]" type="password" autocomplete="off">
              <textarea v-else v-model="notes[question.id]" rows="3" />
            </label>
          </fieldset>
        </form>
        <template v-else>
          <p v-if="detail.plan">该问题已回答或已结束。</p>
          <div class="markdown-body" v-html="renderMarkdown(detail.body)" />
        </template>
      </template>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
    <footer>
      <button v-if="detail?.planRequest" type="submit" form="notice-form" :disabled="!complete || busy">{{ busy ? '正在发送…' : '发送回答' }}</button>
      <button v-if="!detail && !loading" type="button" @click="load">重试</button>
      <button type="button" @click="native?.close()">关闭</button>
    </footer>
  </main>
</template>

<style scoped>
.notice-detail { display: flex; flex-direction: column; height: 100dvh; box-sizing: border-box; padding: 12px; background: var(--color-bg-primary); color: var(--color-text-primary); font-family: var(--font-ui); }
header { display: flex; gap: 8px; align-items: center; min-width: 0; padding-bottom: 8px; border-bottom: 1px solid var(--color-border); }
header strong { overflow-wrap: anywhere; }
.notice-detail-content { flex: 1; min-height: 0; overflow: auto; padding: 8px 0; }
fieldset { margin: 0 0 12px; padding: 8px; border: 1px solid var(--color-border); }
legend { padding: 0 4px; }
.notice-choice { display: flex; gap: 6px; padding: 7px; margin: 4px 0; border: 1px solid var(--color-border); }
.notice-choice span span { display: block; color: var(--color-text-secondary); }
.notice-input { display: grid; gap: 4px; margin-top: 8px; }
.notice-input textarea, .notice-input input { box-sizing: border-box; width: 100%; padding: 6px; color: inherit; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font: inherit; }
footer { display: flex; gap: 8px; border-top: 1px solid var(--color-border); padding-top: 8px; }
footer button { flex: 1; padding: 8px; border: 1px solid var(--color-border); background: var(--color-bg-secondary); color: inherit; font: inherit; }
</style>
