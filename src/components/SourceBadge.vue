<script setup lang="ts">
import { SKILL_KIND_LABELS, type SkillKind } from '@/lib/skillsCompletion'
defineProps<{ kind: SkillKind }>()
</script>

<template>
  <span class="skill-kind-tag" :class="`kind-${kind}`">{{ SKILL_KIND_LABELS[kind] }}</span>
</template>

<style scoped>
.skill-kind-tag { display: inline-flex; flex: none; align-items: center; height: 18px; padding: 0 6px; box-sizing: border-box; border: 1px solid transparent; border-radius: 3px; font-family: var(--font-ui); font-size: 11px; font-weight: var(--sh-weight-strong); line-height: 1; white-space: nowrap; }
.kind-global { color: var(--skill-kind-global); background: var(--skill-kind-global-soft); border-color: var(--skill-kind-global-border); }
.kind-project { color: var(--skill-kind-project); background: var(--skill-kind-project-soft); border-color: var(--skill-kind-project-border); }
.kind-command { color: var(--skill-kind-command); background: var(--skill-kind-command-soft); border-color: var(--skill-kind-command-border); }
</style>
