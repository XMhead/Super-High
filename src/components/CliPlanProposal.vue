<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { PlanProposal } from '@/types'
import { renderMarkdown } from '@/lib/markdown'
const props = defineProps<{ sessionId: string }>()
const store = useWorkspaceStore()
// ---- Plan 表单 ----
const planDecisionIndex = ref(0)
const pendingPlan = computed(() => {
  const plans = store.cliPlans?.[props.sessionId] ?? []
  // 只取第一个未解决（未 resolved）的 Plan，一次显示一个
  return plans.find((item) => !item.resolvedAt) ?? null
})
const planCurrentDecision = computed(() => {
  if (!pendingPlan.value) return null
  return pendingPlan.value.decisions[planDecisionIndex.value] ?? null
})
const planAllDecided = computed(() => {
  if (!pendingPlan.value) return false
  return pendingPlan.value.decisions.every((item) => item.choice !== 'pending')
})
const planTotal = computed(() => pendingPlan.value?.decisions.length ?? 0)
const planHeaderTitle = computed(() => {
  if (!planCurrentDecision.value) return '决策'
  const current = planDecisionIndex.value + 1
  return planTotal.value > 1 ? `决策${current} / 决策${planTotal.value}` : `决策${current}`
})
const planChoiceOptions = [
  { value: 'yes', label: '是' },
  { value: 'no', label: '否' },
  { value: 'skip', label: '跳过' },
] as const

function planChoiceText(choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>): string {
  const decision = planCurrentDecision.value
  if (!decision) return ''
  if (choice === 'yes') return decision.yesText || '采纳这个决策'
  if (choice === 'no') return decision.noText || '不采纳这个决策'
  return '暂不处理这个决策'
}

function planChoiceNote(choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>): string {
  return planCurrentDecision.value?.choiceNotes?.[choice] ?? ''
}

function planRecommendedChoiceLabel(choice?: PlanProposal['decisions'][number]['recommendedChoice'] | null): string {
  if (choice === 'yes') return '推荐选：是'
  if (choice === 'no') return '推荐选：否'
  if (choice === 'skip') return '推荐选：跳过'
  return '推荐选：未明确'
}

function planRecommendationDiagram(decision: PlanProposal['decisions'][number]): string {
  const recommended = decision.recommendedChoice
  const rows = [
    ['是', recommended === 'yes' ? '推荐' : '可选', compactPlanText(decision.yesText || '采纳')],
    ['否', recommended === 'no' ? '推荐' : '可选', compactPlanText(decision.noText || '不采纳')],
    ['跳过', recommended === 'skip' ? '推荐' : '可选', '暂不处理'],
  ]
  const width = Math.max(...rows.map((row) => row[2].length), 8)
  const line = `+------+--------+${'-'.repeat(width + 2)}+`
  return [
    line,
    `| 选项 | 状态   | ${'含义'.padEnd(width)} |`,
    line,
    ...rows.map(([choice, state, text]) => `| ${choice.padEnd(4)} | ${state.padEnd(6)} | ${text.padEnd(width)} |`),
    line,
  ].join('\n')
}

function compactPlanText(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 28 ? `${text.slice(0, 27)}...` : text
}

function setPlanChoice(choice: PlanProposal['decisions'][number]['choice']) {
  const plan = pendingPlan.value
  if (!plan || !props.sessionId) return
  store.setPlanDecisionChoice(props.sessionId, plan.id, plan.decisions[planDecisionIndex.value].key, choice)
}
function setPlanChoiceNote(choice: Exclude<PlanProposal['decisions'][number]['choice'], 'pending'>, event: Event) {
  const plan = pendingPlan.value
  const decision = planCurrentDecision.value
  if (!plan || !decision || !props.sessionId) return
  const value = (event.target as HTMLTextAreaElement).value
  store.setPlanDecisionChoiceNote(props.sessionId, plan.id, decision.key, choice, value)
}
function planNextDecision() {
  if (planDecisionIndex.value + 1 < planTotal.value) planDecisionIndex.value += 1
}
function planPrevDecision() {
  if (planDecisionIndex.value > 0) planDecisionIndex.value -= 1
}
function submitPlan() {
  if (!pendingPlan.value || !props.sessionId) return
  void store.submitPlanProposal(props.sessionId, pendingPlan.value.id)
  planDecisionIndex.value = 0
}
watch(() => pendingPlan.value?.id, () => { planDecisionIndex.value = 0 })

</script>

<template>
        <!-- Plan 表单：CLI Agent 输出 Plan 标记块后在此内联渲染 -->
        <div v-if="pendingPlan" class="plan-form">
          <div class="plan-form-header">
            <span class="plan-form-title">{{ planHeaderTitle }}</span>
            <div class="plan-header-actions">
              <button v-if="planTotal > 1" class="ghost-button" :disabled="planDecisionIndex === 0" @click="planPrevDecision">上一个</button>
              <button v-if="planTotal > 1" class="ghost-button" :disabled="planDecisionIndex + 1 >= planTotal" @click="planNextDecision">下一个</button>
              <button
                class="primary-button"
                :disabled="!planAllDecided"
                title="所有决策处理完毕后直接写入 CLI 会话，不经过输入框"
                @click="submitPlan"
              >发送回执</button>
            </div>
          </div>
          <div v-if="planCurrentDecision" class="plan-decision">
            <div class="plan-decision-main">
              <div class="plan-decision-question markdown-body" v-html="renderMarkdown(planCurrentDecision.question, { escapeRawHtml: true })" />
              <div class="plan-recommendation-line">
                <span class="plan-recommendation-choice">
                  {{ planRecommendedChoiceLabel(planCurrentDecision.recommendedChoice) }}
                </span>
                <span v-if="planCurrentDecision.recommendation" class="plan-recommendation">
                  {{ planCurrentDecision.recommendation }}
                </span>
              </div>
              <div class="plan-decision-choices">
                <div
                  v-for="option in planChoiceOptions"
                  :key="option.value"
                  class="plan-choice-row"
                  :class="{
                    active: planCurrentDecision.choice === option.value,
                    recommended: planCurrentDecision.recommendedChoice === option.value,
                    [option.value]: true,
                  }"
                >
                  <button
                    class="plan-choice"
                    :class="option.value"
                    @click="setPlanChoice(option.value)"
                  >{{ option.label }}</button>
                  <div class="plan-choice-text">{{ planChoiceText(option.value) }}</div>
                  <textarea
                    class="plan-choice-note"
                    rows="1"
                    :value="planChoiceNote(option.value)"
                    :placeholder="`${option.label} 的补充`"
                    @focus="setPlanChoice(option.value)"
                    @input="setPlanChoiceNote(option.value, $event)"
                  />
                </div>
              </div>
              <div v-if="planCurrentDecision.choice !== 'pending'" class="plan-choice-result">
                {{ planCurrentDecision.choice === 'yes' ? '已选：是' : planCurrentDecision.choice === 'no' ? '已选：否' : '已选：跳过' }}
                <span
                  v-if="planCurrentDecision.choiceNotes?.[planCurrentDecision.choice]"
                  class="plan-recommendation"
                > — {{ planCurrentDecision.choiceNotes[planCurrentDecision.choice] }}</span>
              </div>
            </div>
            <div class="plan-ascii-panel">
              <pre>{{ planRecommendationDiagram(planCurrentDecision) }}</pre>
            </div>
          </div>
        </div>

</template>

<style scoped>
.plan-decision-question :deep(p) { margin: 0; }
</style>
