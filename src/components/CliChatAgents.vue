<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight, LoaderCircle, Users } from 'lucide-vue-next'
import type { CliChatAgent } from '@/lib/tauri'
import { cleanCliChatText } from '@/lib/cliChatText'
import { conversationColor, formatWorkDuration } from '@/lib/cliCompletion'
import { renderMarkdown } from '@/lib/markdown'

const props = defineProps<{ agents: CliChatAgent[]; now: number }>()
const emit = defineEmits<{ 'answer-click': [event: MouseEvent] }>()
const expanded = ref<Record<string, boolean>>({})
const labels: Record<CliChatAgent['status'], string> = {
  unknown: '状态未知', running: '工作中', idle: '等待任务', completed: '已完成', failed: '失败', interrupted: '已中断', closed: '已关闭',
}
const agents = computed(() => props.agents.map(agent => ({
  ...agent, name: cleanCliChatText(agent.name), task: cleanCliChatText(agent.task),
  steps: agent.steps.map(step => ({ ...step, detail: cleanCliChatText(step.detail), output: cleanCliChatText(step.output) })),
})))
function elapsed(agent: CliChatAgent) {
  if (agent.startedAt === null) return ''
  const end = agent.completedAt ?? (agent.status === 'running' ? props.now : null)
  return end === null ? '' : formatWorkDuration(Math.max(0, end - agent.startedAt))
}
function parentName(agent: CliChatAgent) { return agents.value.find(parent => parent.id === agent.parentId)?.name }
</script>

<template>
  <div v-if="agents.length" class="chat-agents" aria-label="子 Agent 工作">
    <section v-for="agent in agents" :key="agent.id" class="chat-agent" :style="{ '--agent-accent': conversationColor(agent.id) }">
      <button class="chat-agent-toggle" type="button" :aria-expanded="!!expanded[agent.id]" @click="expanded[agent.id] = !expanded[agent.id]">
        <component :is="expanded[agent.id] ? ChevronDown : ChevronRight" :size="13" />
        <Users :size="13" />
        <span class="chat-agent-name" :title="agent.name">{{ agent.name }}</span>
        <span class="chat-agent-status" :class="{ 'chat-agent-error': agent.status === 'failed' }">
          <LoaderCircle v-if="agent.status === 'running'" :size="12" class="chat-agent-spin" />{{ labels[agent.status] }}
        </span>
        <span v-if="elapsed(agent)" class="chat-agent-time">{{ elapsed(agent) }}</span>
      </button>
      <div v-if="!expanded[agent.id] && agent.steps.length" class="chat-agent-latest">{{ agent.steps.at(-1)?.title || '说明' }} · {{ agent.steps.at(-1)?.detail }}</div>
      <div v-if="expanded[agent.id]" class="chat-agent-body">
        <div v-if="agent.model || agent.role || parentName(agent)" class="chat-agent-meta">
          <span v-if="parentName(agent)">由 {{ parentName(agent) }} 委派</span><span v-if="agent.role">{{ agent.role }}</span><span v-if="agent.model">{{ agent.model }}</span>
        </div>
        <p v-if="agent.task" class="chat-agent-task">{{ agent.task }}</p>
        <p v-else-if="agent.taskEncrypted" class="chat-agent-meta">任务内容由 Codex 加密</p>
        <ol class="chat-agent-steps">
          <li v-for="step in agent.steps" :key="step.id" class="chat-agent-step">
            <div class="chat-agent-step-title" :class="{ 'chat-agent-error': step.status === 'failed' }">
              <LoaderCircle v-if="step.status === 'running'" :size="12" class="chat-agent-spin" />
              {{ step.title || (step.kind === 'think' ? '思考摘要' : '说明') }}<span v-if="step.status === 'failed'"> · 失败</span>
            </div>
            <div v-if="step.kind !== 'tool'" class="markdown-body" @click="emit('answer-click', $event)" v-html="renderMarkdown(step.detail)" />
            <pre v-else-if="step.detail" class="chat-agent-command">{{ step.detail }}</pre>
            <details v-if="step.output" class="chat-agent-output" :open="step.status === 'running'">
              <summary>输出</summary><pre>{{ step.output }}</pre>
            </details>
            <p v-if="step.truncated" class="chat-agent-meta">内容已截取，完整记录保存在 Codex 会话中。</p>
          </li>
        </ol>
        <p v-if="!agent.steps.length" class="chat-agent-meta">{{ agent.status === 'running' ? '等待工作事件' : '暂无工作记录' }}</p>
        <p v-if="agent.error" class="chat-agent-error">{{ cleanCliChatText(agent.error) }}</p>
        <p v-if="agent.historyError" class="chat-agent-meta">{{ agent.historyError }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chat-agents { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.chat-agent { min-width: 0; border: 1px solid var(--color-border); border-left: 2px solid var(--agent-accent); border-radius: 4px; background: var(--color-bg-secondary); }
.chat-agent-toggle { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 7px 8px; border: 0; border-radius: 3px; background: transparent; color: var(--color-text-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.chat-agent-toggle:hover { background: var(--color-bg-hover); }
.chat-agent-toggle > svg { flex: 0 0 auto; }
.chat-agent-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--sh-weight-emphasis); }
.chat-agent-status { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; color: var(--color-text-secondary); }
.chat-agent-time { flex: 0 0 auto; color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.chat-agent-latest { padding: 0 8px 7px 27px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); font-size: 12px; }
.chat-agent-body { min-width: 0; padding: 0 10px 10px; border-top: 1px solid var(--color-border); font-size: 12px; overflow-wrap: anywhere; }
.chat-agent-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; color: var(--color-text-secondary); }
.chat-agent-task { margin: 8px 0; white-space: pre-wrap; }
.chat-agent-steps { display: flex; flex-direction: column; gap: 10px; margin: 8px 0 0; padding: 0 0 0 10px; border-left: 1px solid var(--color-border); list-style: none; }
.chat-agent-step { min-width: 0; }
.chat-agent-step-title { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; color: var(--color-text-secondary); }
.chat-agent-step :deep(.markdown-body) { font-size: 12px; }
.chat-agent-command, .chat-agent-output pre { max-height: 280px; margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5; }
.chat-agent-output { margin-top: 5px; color: var(--color-text-secondary); }
.chat-agent-output summary { width: fit-content; cursor: pointer; }
.chat-agent-output pre { margin-top: 4px; }
.chat-agent-error { color: var(--color-accent-red); }
.chat-agent-spin { animation: agent-spin 1s linear infinite; }
@keyframes agent-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .chat-agent-spin { animation: none; } }
</style>
