<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { SKILL_KIND_LABELS, SKILL_KIND_DESCRIPTIONS, SKILL_CATEGORIES, skillKind, skillStableId, summarizeSkillDescription, type SkillCategory } from '@/lib/skillsCompletion'
import type { CliConversationMessage, SkillCompletionItem } from '@/types'
import SourceBadge from './SourceBadge.vue'
import { memoTitleColor } from '@/lib/theme'

const props = defineProps<{
  candidates: SkillCompletionItem[]
  selectedIndex: number
  category?: SkillCategory
  prompts?: CliConversationMessage[]
  search?: string
  status?: string
}>()

const emit = defineEmits<{
  select: [index: number]
  confirm: [index: number]
  preview: [index: number]
  category: [value: SkillCategory]
  'update:search': [value: string]
  close: []
}>()

interface SkillEntry {
  skill: SkillCompletionItem
  index: number
  summary: string
  nameColor: string
}

const listRef = ref<HTMLUListElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
// 悬停选中不滚动列表：滚动会把相邻项移到静止的指针下，两项交界处会来回切换。
let pointerSelection = false

const entries = computed<SkillEntry[]>(() => props.candidates.map((skill, index) => ({
  skill, index, summary: summarizeSkillDescription(skill.description).summary,
  nameColor: memoTitleColor(skillStableId(skill)),
})))

function onCategoryKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const index = SKILL_CATEGORIES.findIndex((category) => category.id === (props.category ?? 'all'))
  emit('category', SKILL_CATEGORIES[(index + (event.key === 'ArrowRight' ? 1 : -1) + SKILL_CATEGORIES.length) % SKILL_CATEGORIES.length].id)
}

const activeSkill = computed(() => {
  const skill = props.candidates[props.selectedIndex]
  if (!skill) return null
  const kind = skillKind(skill)
  return {
    skill,
    kind,
    label: SKILL_KIND_LABELS[kind],
    nameColor: memoTitleColor(skillStableId(skill)),
    ...summarizeSkillDescription(skill.description),
    location: ['command', 'cli-command'].includes(kind) ? '' : shortSkillLocation(skill.path),
  }
})

function shortSkillLocation(path: string) {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.length > 3 ? `…/${segments.slice(-3).join('/')}` : segments.join('/')
}

onMounted(() => {
  searchRef.value?.focus()
  scrollToSelection(props.selectedIndex)
})

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

// mousemove 只在指针真实移动时触发；列表内容在静止指针下移动不会改选。
function selectByPointer(index: number) {
  if (index === props.selectedIndex) return
  pointerSelection = true
  emit('select', index)
}

function scrollToSelection(index: number) {
  if (pointerSelection) {
    pointerSelection = false
    return
  }
  const item = listRef.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  item?.scrollIntoView?.({ block: 'nearest' })
}

watch(() => props.selectedIndex, scrollToSelection, { flush: 'post' })
watch(() => props.category, () => {
  listRef.value?.closest('.skill-completion-popup')?.querySelector('.skill-completion-categories .active')
    ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}, { flush: 'post' })
</script>

<template>
  <div class="skill-completion-popup" :class="{ 'prompt-history-popup': prompts !== undefined }">
    <div v-if="prompts === undefined" class="skill-completion-categories" role="tablist" aria-label="指令分类" @keydown="onCategoryKeydown">
      <button v-for="item in SKILL_CATEGORIES" :key="item.id" type="button" role="tab" :title="item.id === 'all' ? '全部来源' : SKILL_KIND_DESCRIPTIONS[item.id]" :aria-selected="(category ?? 'all') === item.id" :class="{ active: (category ?? 'all') === item.id }" @mousedown.prevent @click="emit('category', item.id)">{{ item.label }}</button>
    </div>
    <div v-if="prompts !== undefined" class="prompt-history-search-row">
      <input ref="searchRef" :value="search" class="prompt-history-search" placeholder="搜索提示词" aria-label="搜索提示词" @input="emit('update:search', ($event.target as HTMLInputElement).value)" @keydown="onSearchKeydown" />
      <span class="skill-completion-scope">最近 7 天 · 最多 50 条</span>
    </div>
    <ul v-if="prompts !== undefined" ref="listRef" class="skill-completion-list" role="listbox" aria-label="提示词历史">
      <li v-for="(prompt, index) in prompts" :key="prompt.id" :data-index="index" class="skill-completion-item prompt-history-item" :class="{ selected: index === selectedIndex }" role="option" :aria-selected="index === selectedIndex" :title="prompt.content" @mousedown.prevent="emit('confirm', index)" @mousemove="selectByPointer(index)">
        <span class="prompt-history-content">{{ prompt.content }}</span>
        <time class="skill-completion-scope" :datetime="prompt.timestamp">{{ new Date(prompt.timestamp).toLocaleString('zh-CN', { hour12: false }) }}</time>
      </li>
      <li v-if="status || !prompts.length" class="prompt-history-status">{{ status || (search ? '没有匹配的提示词' : '最近 7 天暂无提示词') }}</li>
    </ul>
    <div v-if="prompts === undefined && status && entries.length" class="prompt-history-status">{{ status }}</div>
    <div v-if="prompts === undefined" class="skill-completion-browser">
      <ul ref="listRef" class="skill-completion-list" role="listbox" aria-label="Skills 补全">
          <li
            v-for="entry in entries"
            :key="skillStableId(entry.skill)"
            :data-index="entry.index"
            class="skill-completion-item"
            :class="{ selected: entry.index === selectedIndex }"
            :style="{ '--skill-name-color': entry.nameColor }"
            role="option"
            :aria-selected="entry.index === selectedIndex"
            :title="['command', 'cli-command'].includes(skillKind(entry.skill)) ? entry.skill.description : `${entry.skill.path}\n左键使用，右键预览文件`"
            @mousedown.left.prevent="emit('confirm', entry.index)"
            @mousedown.right.prevent
            @contextmenu.prevent.stop="!['command', 'cli-command'].includes(skillKind(entry.skill)) && emit('preview', entry.index)"
            @mousemove="selectByPointer(entry.index)"
          >
            <span class="skill-completion-name">/{{ entry.skill.name }}</span>
            <span class="skill-completion-summary">{{ entry.summary }}</span>
          </li>
        <li v-if="!entries.length" class="prompt-history-status">{{ status || '此分类没有匹配项' }}</li>
      </ul>
      <aside v-if="activeSkill" class="skill-completion-detail" aria-live="polite">
        <div class="skill-completion-detail-heading">
          <span class="skill-completion-name" :style="{ color: activeSkill.nameColor }">/{{ activeSkill.skill.name }}</span>
          <SourceBadge :kind="activeSkill.kind" />
        </div>
        <div class="skill-completion-detail-body">
          <p class="skill-completion-detail-description">{{ activeSkill.summary }}</p>
          <p v-if="activeSkill.skill.commandId" class="skill-completion-command-content">{{ activeSkill.skill.content }}</p>
          <ul v-if="activeSkill.details.length" class="skill-completion-detail-points">
            <li v-for="(point, pointIndex) in activeSkill.details" :key="pointIndex">{{ point }}</li>
          </ul>
        </div>
        <div class="skill-completion-detail-footer">
          <span v-if="activeSkill.location" class="skill-completion-detail-path" :title="activeSkill.skill.path">{{ activeSkill.location }}</span>
          <span class="skill-completion-detail-hint">Enter / 左键使用{{ activeSkill.location ? ' · 右键预览' : '' }}</span>
        </div>
      </aside>
    </div>
  </div>
</template>
