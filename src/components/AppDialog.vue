<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { appDialogState, resolveAppDialog } from '@/lib/appDialog'

const input = ref('')
const inputElement = ref<HTMLInputElement | null>(null)

watch(() => appDialogState.request, async (request) => {
  input.value = request?.defaultValue ?? ''
  if (request?.kind === 'prompt') {
    await nextTick()
    inputElement.value?.focus()
    inputElement.value?.select()
  }
}, { immediate: true })

function close() {
  resolveAppDialog(null)
}

function confirm() {
  const request = appDialogState.request
  if (!request) return
  resolveAppDialog(request.kind === 'prompt' ? input.value : true)
}

function onKeydown(event: KeyboardEvent) {
  if (!appDialogState.request) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    confirm()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="appDialogState.request" class="app-dialog-backdrop" @mousedown.self="close">
      <section class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
        <header class="app-dialog-titlebar">
          <strong id="app-dialog-title">{{ appDialogState.request.title }}</strong>
          <button type="button" class="icon-button" title="关闭" aria-label="关闭" @click="close"><X :size="15" /></button>
        </header>
        <div class="app-dialog-body">
          <p class="app-dialog-message">{{ appDialogState.request.message }}</p>
          <input
            v-if="appDialogState.request.kind === 'prompt'"
            ref="inputElement"
            v-model="input"
            class="app-dialog-input"
            type="text"
            :placeholder="appDialogState.request.placeholder"
          />
        </div>
        <footer class="app-dialog-actions">
          <button type="button" class="app-dialog-button" @click="close">取消</button>
          <button type="button" class="app-dialog-button primary" @click="confirm">{{ appDialogState.request.confirmLabel ?? '确认' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.app-dialog-backdrop { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgb(0 0 0 / 42%); }
.app-dialog { width: min(440px, calc(100vw - 32px)); border: 1px solid var(--color-border-strong, var(--color-border)); border-radius: 6px; background: var(--color-bg-elevated, var(--color-bg-primary)); color: var(--color-text-primary); box-shadow: 0 12px 36px rgb(0 0 0 / 30%); }
.app-dialog-titlebar { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--color-border); }
.app-dialog-body { padding: 16px 14px 6px; }
.app-dialog-message { margin: 0; white-space: pre-wrap; line-height: 1.5; }
.app-dialog-input { width: 100%; box-sizing: border-box; margin-top: 12px; padding: 7px 8px; border: 1px solid var(--color-border); border-radius: 3px; color: inherit; background: var(--color-bg-primary); font: inherit; }
.app-dialog-input:focus { border-color: var(--color-accent-blue); outline: 0; }
.app-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 14px; }
.app-dialog-button { min-width: 72px; padding: 6px 12px; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-primary); background: var(--color-bg-secondary); cursor: pointer; }
.app-dialog-button.primary { border-color: var(--color-accent-blue); color: var(--color-text-on-accent, #fff); background: var(--color-accent-blue); }
</style>
