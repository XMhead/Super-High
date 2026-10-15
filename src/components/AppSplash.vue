<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

// 启动入场：图标与字标播放一次，最短停留到动画完成，数据就绪后淡出。
const props = defineProps<{ ready: boolean; skip?: boolean }>()
const emit = defineEmits<{ done: [] }>()

const MIN_VISIBLE_MS = 1050
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
      <svg class="app-splash-mark" viewBox="0 0 1024 1024">
        <defs>
          <linearGradient id="sp-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D1E26" /><stop offset="1" stop-color="#0B0C10" /></linearGradient>
          <linearGradient id="sp-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22" /><stop offset=".5" stop-color="#fff" stop-opacity=".04" /><stop offset="1" stop-color="#fff" stop-opacity=".08" /></linearGradient>
          <linearGradient id="sp-f1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE2CC" /><stop offset="1" stop-color="#FF8A5C" /></linearGradient>
          <linearGradient id="sp-f2" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB3D9" /><stop offset="1" stop-color="#C45CF0" /></linearGradient>
          <linearGradient id="sp-f3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F0603E" /><stop offset="1" stop-color="#8A3FE0" /></linearGradient>
          <linearGradient id="sp-f4" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6E52FF" /><stop offset="1" stop-color="#2B1F86" /></linearGradient>
          <radialGradient id="sp-glow"><stop offset="0" stop-color="#FF6E5A" stop-opacity=".6" /><stop offset=".6" stop-color="#9A4DFF" stop-opacity=".25" /><stop offset="1" stop-color="#7A4DFF" stop-opacity="0" /></radialGradient>
          <radialGradient id="sp-spark"><stop offset="0" stop-color="#fff" /><stop offset=".25" stop-color="#fff" stop-opacity=".7" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></radialGradient>
          <filter id="sp-blur" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><feGaussianBlur stdDeviation="70" /></filter>
        </defs>
        <g class="app-splash-tile">
          <path fill="url(#sp-tile)" d="M952.0 512.0L951.9 622.2L951.7 657.4L951.2 683.0L950.6 703.7L949.8 721.5L948.9 737.2L947.7 751.3L946.4 764.2L944.9 776.1L943.3 787.1L941.4 797.4L939.4 807.0L937.2 816.1L934.7 824.7L932.2 832.8L929.4 840.5L926.4 847.9L923.2 854.8L919.8 861.4L916.2 867.7L912.4 873.8L908.4 879.5L904.2 884.9L899.7 890.1L895.0 895.0L890.1 899.7L884.9 904.2L879.5 908.4L873.8 912.4L867.7 916.2L861.4 919.8L854.8 923.2L847.9 926.4L840.5 929.4L832.8 932.2L824.7 934.7L816.1 937.2L807.0 939.4L797.4 941.4L787.1 943.3L776.1 944.9L764.2 946.4L751.3 947.7L737.2 948.9L721.5 949.8L703.7 950.6L683.0 951.2L657.4 951.7L622.2 951.9L512.0 952.0L401.8 951.9L366.6 951.7L341.0 951.2L320.3 950.6L302.5 949.8L286.8 948.9L272.7 947.7L259.8 946.4L247.9 944.9L236.9 943.3L226.6 941.4L217.0 939.4L207.9 937.2L199.3 934.7L191.2 932.2L183.5 929.4L176.1 926.4L169.2 923.2L162.6 919.8L156.3 916.2L150.2 912.4L144.5 908.4L139.1 904.2L133.9 899.7L129.0 895.0L124.3 890.1L119.8 884.9L115.6 879.5L111.6 873.8L107.8 867.7L104.2 861.4L100.8 854.8L97.6 847.9L94.6 840.5L91.8 832.8L89.3 824.7L86.8 816.1L84.6 807.0L82.6 797.4L80.7 787.1L79.1 776.1L77.6 764.2L76.3 751.3L75.1 737.2L74.2 721.5L73.4 703.7L72.8 683.0L72.3 657.4L72.1 622.2L72.0 512.0L72.1 401.8L72.3 366.6L72.8 341.0L73.4 320.3L74.2 302.5L75.1 286.8L76.3 272.7L77.6 259.8L79.1 247.9L80.7 236.9L82.6 226.6L84.6 217.0L86.8 207.9L89.3 199.3L91.8 191.2L94.6 183.5L97.6 176.1L100.8 169.2L104.2 162.6L107.8 156.3L111.6 150.2L115.6 144.5L119.8 139.1L124.3 133.9L129.0 129.0L133.9 124.3L139.1 119.8L144.5 115.6L150.2 111.6L156.3 107.8L162.6 104.2L169.2 100.8L176.1 97.6L183.5 94.6L191.2 91.8L199.3 89.3L207.9 86.8L217.0 84.6L226.6 82.6L236.9 80.7L247.9 79.1L259.8 77.6L272.7 76.3L286.8 75.1L302.5 74.2L320.3 73.4L341.0 72.8L366.6 72.3L401.8 72.1L512.0 72.0L622.2 72.1L657.4 72.3L683.0 72.8L703.7 73.4L721.5 74.2L737.2 75.1L751.3 76.3L764.2 77.6L776.1 79.1L787.1 80.7L797.4 82.6L807.0 84.6L816.1 86.8L824.7 89.3L832.8 91.8L840.5 94.6L847.9 97.6L854.8 100.8L861.4 104.2L867.7 107.8L873.8 111.6L879.5 115.6L884.9 119.8L890.1 124.3L895.0 129.0L899.7 133.9L904.2 139.1L908.4 144.5L912.4 150.2L916.2 156.3L919.8 162.6L923.2 169.2L926.4 176.1L929.4 183.5L932.2 191.2L934.7 199.3L937.2 207.9L939.4 217.0L941.4 226.6L943.3 236.9L944.9 247.9L946.4 259.8L947.7 272.7L948.9 286.8L949.8 302.5L950.6 320.3L951.2 341.0L951.7 366.6L951.9 401.8Z" />
          <path fill="none" stroke="url(#sp-rim)" stroke-width="5" d="M952.0 512.0L951.9 622.2L951.7 657.4L951.2 683.0L950.6 703.7L949.8 721.5L948.9 737.2L947.7 751.3L946.4 764.2L944.9 776.1L943.3 787.1L941.4 797.4L939.4 807.0L937.2 816.1L934.7 824.7L932.2 832.8L929.4 840.5L926.4 847.9L923.2 854.8L919.8 861.4L916.2 867.7L912.4 873.8L908.4 879.5L904.2 884.9L899.7 890.1L895.0 895.0L890.1 899.7L884.9 904.2L879.5 908.4L873.8 912.4L867.7 916.2L861.4 919.8L854.8 923.2L847.9 926.4L840.5 929.4L832.8 932.2L824.7 934.7L816.1 937.2L807.0 939.4L797.4 941.4L787.1 943.3L776.1 944.9L764.2 946.4L751.3 947.7L737.2 948.9L721.5 949.8L703.7 950.6L683.0 951.2L657.4 951.7L622.2 951.9L512.0 952.0L401.8 951.9L366.6 951.7L341.0 951.2L320.3 950.6L302.5 949.8L286.8 948.9L272.7 947.7L259.8 946.4L247.9 944.9L236.9 943.3L226.6 941.4L217.0 939.4L207.9 937.2L199.3 934.7L191.2 932.2L183.5 929.4L176.1 926.4L169.2 923.2L162.6 919.8L156.3 916.2L150.2 912.4L144.5 908.4L139.1 904.2L133.9 899.7L129.0 895.0L124.3 890.1L119.8 884.9L115.6 879.5L111.6 873.8L107.8 867.7L104.2 861.4L100.8 854.8L97.6 847.9L94.6 840.5L91.8 832.8L89.3 824.7L86.8 816.1L84.6 807.0L82.6 797.4L80.7 787.1L79.1 776.1L77.6 764.2L76.3 751.3L75.1 737.2L74.2 721.5L73.4 703.7L72.8 683.0L72.3 657.4L72.1 622.2L72.0 512.0L72.1 401.8L72.3 366.6L72.8 341.0L73.4 320.3L74.2 302.5L75.1 286.8L76.3 272.7L77.6 259.8L79.1 247.9L80.7 236.9L82.6 226.6L84.6 217.0L86.8 207.9L89.3 199.3L91.8 191.2L94.6 183.5L97.6 176.1L100.8 169.2L104.2 162.6L107.8 156.3L111.6 150.2L115.6 144.5L119.8 139.1L124.3 133.9L129.0 129.0L133.9 124.3L139.1 119.8L144.5 115.6L150.2 111.6L156.3 107.8L162.6 104.2L169.2 100.8L176.1 97.6L183.5 94.6L191.2 91.8L199.3 89.3L207.9 86.8L217.0 84.6L226.6 82.6L236.9 80.7L247.9 79.1L259.8 77.6L272.7 76.3L286.8 75.1L302.5 74.2L320.3 73.4L341.0 72.8L366.6 72.3L401.8 72.1L512.0 72.0L622.2 72.1L657.4 72.3L683.0 72.8L703.7 73.4L721.5 74.2L737.2 75.1L751.3 76.3L764.2 77.6L776.1 79.1L787.1 80.7L797.4 82.6L807.0 84.6L816.1 86.8L824.7 89.3L832.8 91.8L840.5 94.6L847.9 97.6L854.8 100.8L861.4 104.2L867.7 107.8L873.8 111.6L879.5 115.6L884.9 119.8L890.1 124.3L895.0 129.0L899.7 133.9L904.2 139.1L908.4 144.5L912.4 150.2L916.2 156.3L919.8 162.6L923.2 169.2L926.4 176.1L929.4 183.5L932.2 191.2L934.7 199.3L937.2 207.9L939.4 217.0L941.4 226.6L943.3 236.9L944.9 247.9L946.4 259.8L947.7 272.7L948.9 286.8L949.8 302.5L950.6 320.3L951.2 341.0L951.7 366.6L951.9 401.8Z" />
        </g>
        <ellipse class="app-splash-glow" cx="512" cy="560" rx="340" ry="320" fill="url(#sp-glow)" filter="url(#sp-blur)" />
        <g class="app-splash-crystal">
          <polygon class="app-splash-facet" style="--i: 0" points="512,250 242,520 470,440" fill="url(#sp-f1)" />
          <polygon class="app-splash-facet" style="--i: 1" points="512,250 782,520 470,440" fill="url(#sp-f2)" />
          <polygon class="app-splash-facet" style="--i: 2" points="242,520 512,790 470,440" fill="url(#sp-f3)" />
          <polygon class="app-splash-facet" style="--i: 3" points="782,520 512,790 470,440" fill="url(#sp-f4)" />
          <g class="app-splash-edges" stroke="#fff" stroke-width="4" stroke-linecap="round">
            <line x1="512" y1="250" x2="470" y2="440" stroke-opacity=".75" />
            <line x1="242" y1="520" x2="470" y2="440" stroke-opacity=".45" />
            <line x1="782" y1="520" x2="470" y2="440" stroke-opacity=".25" />
            <line x1="512" y1="790" x2="470" y2="440" stroke-opacity=".12" />
          </g>
        </g>
        <circle class="app-splash-spark" cx="470" cy="440" r="60" fill="url(#sp-spark)" />
      </svg>
      <span class="app-splash-name">Super High</span>
    </div>
  </div>
</template>
