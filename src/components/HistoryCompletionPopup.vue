<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  candidates: string[]
  selectedIndex: number
  /** 与 candidates 平行的出现次数（undefined = 不显示） */
  counts?: (number | undefined)[]
  /** 与 candidates 平行的展示文本（undefined = 显示原文） */
  labels?: (string | undefined)[]
}>()

const emit = defineEmits<{
  select: [index: number]
  confirm: [index: number]
}>()

const listRef = ref<HTMLUListElement | null>(null)

watch(() => props.selectedIndex, (index) => {
  const item = listRef.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  item?.scrollIntoView?.({ block: 'nearest' })
})
</script>

<template>
  <ul ref="listRef" class="history-completion-popup" role="listbox" aria-label="历史消息补全">
    <li
      v-for="(candidate, index) in candidates"
      :key="index"
      :data-index="index"
      class="history-completion-item"
      :class="{ selected: index === selectedIndex }"
      role="option"
      :aria-selected="index === selectedIndex"
      @mousedown.prevent="emit('confirm', index)"
      @mouseenter="emit('select', index)"
    >
      <span class="history-completion-caret">{{ index === selectedIndex ? '▸' : ' ' }}</span>
      <span class="history-completion-text" :title="candidate">{{ labels?.[index] ?? candidate }}</span>
      <span v-if="counts?.[index] && counts[index]! > 1" class="history-completion-count">
        ×{{ counts[index] }}
      </span>
    </li>
  </ul>
</template>
