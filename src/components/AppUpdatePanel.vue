<script setup lang="ts">
import { onMounted } from 'vue'
import { Download, RefreshCw } from 'lucide-vue-next'
import { isTauri } from '@/lib/tauri'
import { useAppUpdateStore } from '@/stores/appUpdate'
import { releaseHistory } from '@/lib/releaseNotes'
import { renderMarkdown } from '@/lib/markdown'

const update = useAppUpdateStore()
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
      <div class="settings-option-row"><span class="settings-subtitle">当前版本</span><span class="settings-value">{{ update.status?.currentVersion ?? update.currentRelease.version }}</span></div>
      <label class="update-preference">
        <input type="checkbox" :checked="update.automatic" :disabled="!isTauri()" @change="update.setAutomatic(($event.target as HTMLInputElement).checked)" />
        <span>自动检查并下载更新</span>
      </label>
      <p class="settings-path">启动后及每隔 4 小时检查一次。下载完成后由你选择安装时间。</p>
      <p role="status">{{ update.statusText }}</p>
      <div class="update-actions">
        <button class="ghost-button small" :disabled="!isTauri() || update.busy || update.installing || update.status?.phase === 'ready'" @click="update.check()">
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
    <div v-if="update.status?.version && update.status.notes" class="settings-block">
      <div class="settings-subtitle">待更新版本 {{ update.status.version }} · 更新日志</div>
      <div class="update-notes markdown-body" v-html="renderMarkdown(update.status.notes)" />
    </div>
    <div v-if="update.currentRelease.notes" class="settings-block">
      <div class="settings-subtitle">当前版本 {{ update.currentRelease.version }} · 更新日志</div>
      <div class="update-notes markdown-body" v-html="renderMarkdown(update.currentRelease.notes)" />
    </div>
    <div class="settings-block release-history" aria-label="历史更新日志">
      <div class="settings-subtitle">历史更新日志</div>
      <details v-for="release in releaseHistory.filter(item => item.version !== update.currentRelease.version)" :key="release.version" class="release-history-entry">
        <summary>{{ release.version }}<span>{{ release.date }}</span></summary>
        <div class="update-notes markdown-body" v-html="renderMarkdown(release.notes)" />
      </details>
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
.update-notes { overflow-wrap: anywhere; color: var(--color-text-secondary); font-size: 12px; }
.update-error { color: var(--color-accent-red); overflow-wrap: anywhere; }
.release-history-entry { border-top: 1px solid var(--color-border); }
.release-history { gap: 0; }
.release-history > .settings-subtitle { padding-bottom: 10px; }
.release-history-entry summary { padding: 10px 0; cursor: pointer; font-size: 12px; }
.release-history-entry summary span { float: right; margin-left: 12px; color: var(--color-text-secondary); }
.release-history-entry .update-notes { padding-bottom: 12px; }
</style>
