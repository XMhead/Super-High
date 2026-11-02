<script setup lang="ts">
import blockbenchIcon from '@/assets/blockbench.png'

withDefaults(defineProps<{ size?: number | string; strokeWidth?: number | string }>(), { size: 24 })
</script>

<template>
  <img :src="blockbenchIcon" :width="size" :height="size" alt="" draggable="false" />
</template>
