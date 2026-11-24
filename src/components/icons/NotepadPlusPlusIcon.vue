<script setup lang="ts">
import notepadIcon from '@/assets/notepad-plus-plus.png'

withDefaults(defineProps<{ size?: number | string; strokeWidth?: number | string }>(), { size: 24 })
</script>

<template>
  <img :src="notepadIcon" :width="size" :height="size" alt="" draggable="false" />
</template>
