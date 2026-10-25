<script setup lang="ts">
import javaIcon from '@/assets/java.png'

withDefaults(defineProps<{ size?: number | string; strokeWidth?: number | string }>(), { size: 24 })
</script>

<template>
  <img :src="javaIcon" :width="size" :height="size" alt="" draggable="false" />
</template>
