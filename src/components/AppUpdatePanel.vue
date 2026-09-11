<script setup lang="ts">
import { onMounted } from 'vue'
import { Download, RefreshCw } from 'lucide-vue-next'
import { isTauri } from '@/lib/tauri'
import { useAppUpdateStore } from '@/stores/appUpdate'

const update = useAppUpdateStore()
defineProps<{ simulated?: boolean }>()
onMounted(() => { void update.refresh() })
</script>

<template>
  <section class="settings-content-section" aria-label="应用">
    <div class="settings-section-heading">
      <div>
        <div class="section-title">应用</div>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-option-row"><span class="settings-subtitle">当前版本</span><span class="settings-value">{{ update.status?.currentVersion ?? '—' }}</span></div>
      <label class="update-preference">
        <input type="checkbox" :checked="update.automatic" :disabled="(!isTauri() && !simulated)" @change="update.setAutomatic(($event.target as HTMLInputElement).checked)" />
        <span>自动检查并下载更新</span>
      </label>
      <p class="settings-path">启动后及每隔 4 小时检查一次。下载完成后由你选择安装时间。</p>
      <p role="status">{{ update.statusText }}</p>
      <div class="update-actions">
        <button class="ghost-button small" :disabled="(!isTauri() && !simulated) || update.busy || update.installing || update.status?.phase === 'ready'" @click="update.check()">
          <RefreshCw :size="13" /><span>检查更新</span>
        </button>
        <button v-if="update.status?.phase === 'available' || (update.status?.phase === 'error' && update.status.version)" class="ghost-button small" :disabled="update.busy" @click="update.download()">
          <Download :size="13" /><span>下载更新</span>
        </button>
        <button v-if="update.status?.phase === 'ready'" class="ghost-button small" :disabled="update.busy || update.installing" @click="update.install()">安装并重启</button>
      </div>
      <p v-if="update.errorText" class="update-error" role="alert">{{ update.errorText }}</p>
      <p v-if="update.status?.blockingSessions.length" class="settings-path">内部会话仍在运行：{{ update.status.blockingSessions.map(session => session.title).join('、') }}。请结束会话后再安装。</p>
      <p class="settings-path">安装前需保存文件并结束内部终端会话；更新包会校验签名。</p>
    </div>
    <div v-if="update.status?.notes" class="settings-block">
      <div class="settings-subtitle">更新说明</div>
      <p class="update-notes">{{ update.status.notes }}</p>
    </div>
  </section>
</template>

<style scoped>
.update-preference, .update-actions { display: flex; align-items: center; gap: 8px; }
.update-preference { font-size: 13px; }
.settings-block p { margin: 0; font-size: 12px; line-height: 1.6; }
.update-actions { overflow-x: auto; white-space: nowrap; }
.update-actions > button { flex-shrink: 0; }
.update-preference input { accent-color: var(--color-accent-blue); }
.update-notes { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-text-secondary); }
.update-error { color: var(--color-accent-red); overflow-wrap: anywhere; }
</style>
