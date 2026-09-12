<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { CliConversationMessage, SkillCompletionItem } from '@/types'

const props = defineProps<{
  candidates: SkillCompletionItem[]
  selectedIndex: number
  prompts?: CliConversationMessage[]
  search?: string
  status?: string
}>()

const emit = defineEmits<{
  select: [index: number]
  confirm: [index: number]
  'update:search': [value: string]
  close: []
}>()

const listRef = ref<HTMLUListElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
onMounted(() => searchRef.value?.focus())

function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (props.prompts?.length) emit('confirm', props.selectedIndex)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const count = props.prompts?.length ?? 0
    if (count) emit('select', (props.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
  }
}

watch(() => props.selectedIndex, (index) => {
  const item = listRef.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  item?.scrollIntoView?.({ block: 'nearest' })
})
</script>

<template>
  <div class="skill-completion-popup" :class="{ 'prompt-history-popup': prompts !== undefined }">
    <div v-if="prompts !== undefined" class="prompt-history-search-row">
      <input ref="searchRef" :value="search" class="prompt-history-search" placeholder="搜索提示词" aria-label="搜索提示词" @input="emit('update:search', ($event.target as HTMLInputElement).value)" @keydown="onSearchKeydown" />
      <span class="skill-completion-scope">最近 7 天 · 最多 50 条</span>
    </div>
    <ul ref="listRef" class="skill-completion-list" role="listbox" :aria-label="prompts !== undefined ? '提示词历史' : 'Skills 补全'">
    <template v-if="prompts !== undefined">
      <li v-for="(prompt, index) in prompts" :key="prompt.id" :data-index="index" class="skill-completion-item prompt-history-item" :class="{ selected: index === selectedIndex }" role="option" :aria-selected="index === selectedIndex" :title="prompt.content" @mousedown.prevent="emit('confirm', index)" @mouseenter="emit('select', index)">
        <span class="prompt-history-content">{{ prompt.content }}</span>
        <time class="skill-completion-scope" :datetime="prompt.timestamp">{{ new Date(prompt.timestamp).toLocaleString('zh-CN', { hour12: false }) }}</time>
      </li>
      <li v-if="status || !prompts.length" class="prompt-history-status">{{ status || (search ? '没有匹配的提示词' : '最近 7 天暂无提示词') }}</li>
    </template>
    <template v-else>
    <li
      v-for="(skill, index) in candidates"
      :key="`${skill.scope}:${skill.name}:${skill.path}`"
      :data-index="index"
      class="skill-completion-item"
      :class="{ selected: index === selectedIndex }"
      role="option"
      :aria-selected="index === selectedIndex"
      @mousedown.prevent="emit('confirm', index)"
      @mouseenter="emit('select', index)"
    >
      <span class="skill-completion-name">/{{ skill.name }}</span>
      <span class="skill-completion-scope">{{ skill.path === 'superhigh:prompt' ? '命令' : skill.scope === 'project' ? '项目' : '全局' }}</span>
      <span class="skill-completion-description">{{ skill.description }}</span>
    </li>
    </template>
    </ul>
  </div>
</template>
