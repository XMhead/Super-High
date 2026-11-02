<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import markUrl from '../assets/superhigh-mark.png'
import { buildEffectVars, getTheme, SIGNATURE_THEME_ID } from '@/lib/theme'
import { startVibeSplash, VIBE_SPLASH, type VibeSplashScene } from '@/lib/vibeSplash'

// 启动入场：四道闪电旋入定格并闪光，最短停留到动画完成，数据就绪后淡出。
// SuperHigh Vibe 主题改用专属场景：星流聚能、冲击定格、标题解码，就绪后光圈打开露出工作区。
const props = defineProps<{ ready: boolean; skip?: boolean; vibe?: boolean }>()
const emit = defineEmits<{ done: [] }>()

const MIN_VISIBLE_MS = props.vibe ? VIBE_SPLASH.minVisibleMs : 1320
const LEAVE_MS = 260

const TITLE = 'SUPER HIGH'
const NBSP = String.fromCharCode(0xa0)
const SCRAMBLE_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=<>/'
const TITLE_START_MS = VIBE_SPLASH.impactMs + 150
const TITLE_STAGGER_MS = 55
const TITLE_SCRAMBLE_MS = 260

type LetterState = 'hidden' | 'scramble' | 'locked'

const leaving = ref(false)
const still = ref(false)
const vibeRoot = ref<HTMLElement | null>(null)
const vibeCanvas = ref<HTMLCanvasElement | null>(null)
const letters = ref(TITLE.split('').map(char => ({ char, state: 'hidden' as LetterState, glyph: char })))
const vibeTheme = getTheme(SIGNATURE_THEME_ID)
const vibeVars = {
  ...buildEffectVars(vibeTheme),
  '--fx-text': vibeTheme.colors.text.primary,
  '--focus-y': `${VIBE_SPLASH.focusY * 100}%`,
  '--impact': `${VIBE_SPLASH.impactMs}ms`,
  '--mark-url': `url("${markUrl}")`,
}

let minElapsed = false
let mountedAt = 0
let minTimer: number | undefined
let leaveTimer: number | undefined
let titleTimer: number | undefined
let scene: VibeSplashScene | null = null

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function tickTitle() {
  const elapsed = performance.now() - mountedAt
  let pending = false
  letters.value = letters.value.map((letter, index) => {
    const start = TITLE_START_MS + index * TITLE_STAGGER_MS
    if (letter.char === ' ' || still.value || elapsed >= start + TITLE_SCRAMBLE_MS) return { ...letter, state: 'locked', glyph: letter.char }
    pending = true
    if (elapsed < start) return letter
    return { ...letter, state: 'scramble', glyph: SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)] }
  })
  if (!pending) window.clearInterval(titleTimer)
}

function beginLeave() {
  leaving.value = true
  if (scene) scene.leave(() => emit('done'))
  else leaveTimer = window.setTimeout(() => emit('done'), LEAVE_MS)
}

function tryLeave() {
  if (leaving.value || !props.ready) return
  if (props.skip) {
    emit('done')
    return
  }
  if (!minElapsed) return
  beginLeave()
}

// 冲击定格后，数据已就绪即可点击提前进入。
function leaveEarly() {
  if (leaving.value || !props.ready || performance.now() - mountedAt < VIBE_SPLASH.impactMs) return
  beginLeave()
}

onMounted(() => {
  mountedAt = performance.now()
  still.value = reducedMotion()
  if (props.vibe && !props.skip) {
    if (!still.value && vibeRoot.value && vibeCanvas.value) {
      scene = startVibeSplash(vibeRoot.value, vibeCanvas.value, vibeTheme.effects?.gradient ?? [], vibeTheme.colors.text.primary)
    }
    tickTitle()
    titleTimer = window.setInterval(tickTitle, 45)
  }
  if (still.value) minElapsed = true
  else minTimer = window.setTimeout(() => { minElapsed = true; tryLeave() }, MIN_VISIBLE_MS)
  tryLeave()
})

watch(() => [props.ready, props.skip], tryLeave)

onBeforeUnmount(() => {
  window.clearTimeout(minTimer)
  window.clearTimeout(leaveTimer)
  window.clearInterval(titleTimer)
  scene?.dispose()
})
</script>

<template>
  <div v-if="vibe" ref="vibeRoot" class="vibe-splash" :class="{ leaving, still }" :style="vibeVars" aria-hidden="true" @click="leaveEarly">
    <span class="vibe-splash-aurora" />
    <span class="vibe-splash-grid" />
    <span class="vibe-splash-horizon" />
    <canvas ref="vibeCanvas" class="vibe-splash-canvas" />
    <div class="vibe-splash-stage">
      <div class="vibe-splash-core">
        <span class="vibe-splash-halo" />
        <span class="vibe-splash-ring" />
        <span class="vibe-splash-ring dashed" />
        <span class="vibe-splash-ghost fx-1" />
        <span class="vibe-splash-ghost fx-3" />
        <img class="vibe-splash-mark" :src="markUrl" alt="" draggable="false" />
      </div>
      <!-- 渐变字与解码层分成同排版的两行：background-clip:text 内含动画子元素时 Chromium 会把字形画成色块。 -->
      <div class="vibe-splash-title">
        <span class="vibe-splash-title-fill">
          <span v-for="(letter, index) in letters" :key="index" class="vibe-splash-letter" :class="letter.state">{{ letter.char === ' ' ? NBSP : letter.char }}</span>
        </span>
        <span class="vibe-splash-title-code">
          <span v-for="(letter, index) in letters" :key="index" class="vibe-splash-letter" :class="letter.state">
            <span class="vibe-splash-glyph">{{ letter.char === ' ' ? NBSP : letter.char }}</span>
            <span v-if="letter.state !== 'hidden' && letter.char !== ' '" class="vibe-splash-scramble">{{ letter.glyph }}</span>
          </span>
        </span>
      </div>
      <span class="vibe-splash-beam" :class="{ charged: ready }"><i /></span>
    </div>
    <span class="vibe-splash-flash" />
    <span class="vibe-splash-scan" />
  </div>
  <div v-else class="app-splash" :class="{ leaving }" aria-hidden="true">
    <div class="app-splash-brand">
      <div class="app-splash-mark">
        <span class="app-splash-glow" />
        <img class="app-splash-bolts" :src="markUrl" alt="" draggable="false" />
      </div>
      <span class="app-splash-name">Super High</span>
    </div>
  </div>
</template>
