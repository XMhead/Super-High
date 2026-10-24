<script setup lang="ts">
// OpenCode 官方图标（取自 cc-switch 的 src/icons/extracted/opencode-logo-light.svg）
defineProps<{ size?: number }>()
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="(size ?? 16) * 1.25"
    viewBox="0 0 240 300"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="OpenCode"
  >
    <path d="M180 240H60V120H180V240Z" fill="#CFCECD" />
    <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E" />
  </svg>
</template>