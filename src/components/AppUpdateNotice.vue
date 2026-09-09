<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppUpdateStore } from '@/stores/appUpdate'
import { isTauri } from '@/lib/tauri'

const update = useAppUpdateStore()
const dismissedVersion = ref<string | null>(null)
const installBackdrop = ref<HTMLElement | null>(null)
watch(() => update.installing, async (installing) => {
  if (installing) { await nextTick(); installBackdrop.value?.focus() }
})
let startupTimer: number | undefined
let interval: number | undefined
onMounted(() => {
  if (!isTauri()) return
  void update.refresh()
  const check = () => { if (update.automatic) void update.check(true) }
  startupTimer = window.setTimeout(check, 15_000)
  interval = window.setInterval(check, 4 * 60 * 60 * 1000)
})
onBeforeUnmount(() => {
  window.clearTimeout(startupTimer)
  window.clearInterval(interval)
})
</script>

<template>
  <div v-if="update.installing" ref="installBackdrop" tabindex="-1" class="update-install-backdrop" role="alertdialog" aria-modal="true" aria-label="正在安装更新">
    <div class="update-install-message">正在启动更新安装程序，请稍候…</div>
  </div>
  <aside v-else-if="update.status?.phase === 'ready' && dismissedVersion !== update.status.version" class="update-notice" aria-label="更新已就绪">
    <div class="update-notice-row">
      <span>{{ update.statusText }}</span>
      <button class="ghost-button small" :disabled="update.busy" @click="update.install()">安装并重启</button>
      <button class="ghost-button small" @click="dismissedVersion = update.status.version">稍后</button>
    </div>
    <p v-if="update.errorText" role="alert">{{ update.errorText }}</p>
  </aside>
</template>

<style scoped>
.update-notice { position: fixed; right: 16px; bottom: 40px; z-index: 110; max-width: calc(100vw - 32px); padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--surface-panel-strong); color: var(--color-text-primary); }
.update-notice-row { display: flex; align-items: center; gap: 10px; overflow-x: auto; white-space: nowrap; }
.update-notice-row > * { flex-shrink: 0; }
.update-notice p { max-width: 520px; margin: 8px 0 0; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.update-install-backdrop { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: var(--surface-overlay); outline: none; }
.update-install-message { padding: 20px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--surface-dialog); color: var(--color-text-primary); }
</style>
