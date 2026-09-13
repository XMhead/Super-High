<script setup lang="ts">
import { computed } from 'vue'
import { TerminalSquare } from 'lucide-vue-next'
import ClaudeIcon from './ClaudeIcon.vue'
import CodexIcon from './CodexIcon.vue'
import GeminiIcon from './GeminiIcon.vue'
import GrokIcon from './GrokIcon.vue'
import KimiIcon from './KimiIcon.vue'
import OpenCodeIcon from './OpenCodeIcon.vue'

const props = withDefaults(defineProps<{ provider: string; size?: number }>(), { size: 16 })
const icons = { claude: ClaudeIcon, codex: CodexIcon, gemini: GeminiIcon, grok: GrokIcon, kimi: KimiIcon, opencode: OpenCodeIcon }
const icon = computed(() => icons[props.provider as keyof typeof icons] ?? TerminalSquare)
</script>

<template><component :is="icon" :size="size" aria-hidden="true" /></template>
