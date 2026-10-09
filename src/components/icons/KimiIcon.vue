<script setup lang="ts">
// Kimi Code has no matching cc-switch asset; use a neutral local placeholder.
defineProps<{ size?: number }>()
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Kimi"
  >
    <circle cx="12" cy="12" r="10" fill="#38A5FF" />
    <path d="M8 6v12M9 12l6-6M10 12l6 6" fill="none" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
  </svg>
</template>
