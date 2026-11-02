<script setup lang="ts">
import { ref, watch } from 'vue'
import { escapeCode, highlightCode } from '@/lib/codeHighlight'

const props = defineProps<{ content: string; language: string }>()
const html = ref('')
watch(() => [props.content, props.language], async (_, __, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  html.value = escapeCode(props.content)
  try {
    const highlighted = await highlightCode(props.content, props.language)
    if (current) html.value = highlighted
  } catch {
    // Keep the original text readable if a language module cannot be loaded.
  }
}, { immediate: true })
</script>

<template>
  <pre class="mobile-code"><code v-html="html" /></pre>
</template>
