<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import markUrl from '../assets/superhigh-mark.png'

// 启动入场：四道闪电旋入定格并闪光，最短停留到动画完成，数据就绪后淡出。
const props = defineProps<{ ready: boolean; skip?: boolean }>()
const emit = defineEmits<{ done: [] }>()

const MIN_VISIBLE_MS = 1320
const LEAVE_MS = 260

const leaving = ref(false)
let minElapsed = false
let minTimer: number | undefined
let leaveTimer: number | undefined

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function tryLeave() {
  if (leaving.value || !props.ready) return
  if (props.skip) {
    emit('done')
    return
  }
  if (!minElapsed) return
  leaving.value = true
  leaveTimer = window.setTimeout(() => emit('done'), LEAVE_MS)
}

onMounted(() => {
  if (reducedMotion()) minElapsed = true
  else minTimer = window.setTimeout(() => { minElapsed = true; tryLeave() }, MIN_VISIBLE_MS)
  tryLeave()
})

watch(() => [props.ready, props.skip], tryLeave)

onBeforeUnmount(() => {
  window.clearTimeout(minTimer)
  window.clearTimeout(leaveTimer)
})
</script>

<template>
  <div class="app-splash" :class="{ leaving }" aria-hidden="true">
    <div class="app-splash-brand">
      <div class="app-splash-mark">
        <span class="app-splash-glow" />
        <img class="app-splash-bolts" :src="markUrl" alt="" draggable="false" />
      </div>
      <span class="app-splash-name">Super High</span>
    </div>
  </div>
</template>
