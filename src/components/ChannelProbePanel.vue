<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Link2,
  List,
  Loader2,
  Mail,
  RadioTower,
  RefreshCw,
  XCircle,
  Zap,
} from 'lucide-vue-next'

import { backend } from '@/lib/tauri'
import type {
  CcProviderInfo,
  ChannelApiFormat,
  ChannelConfig,
  ChannelProbeResult,
  ChannelProviderKind,
  EndpointLatencyResult,
  FetchedModel,
} from '@/types'

const props = defineProps<{ preview?: boolean }>()

type KindFilter = 'all' | ChannelProviderKind

interface PanelProvider {
  key: string
  kind: ChannelProviderKind
  name: string
  websiteUrl: string
  baseUrl: string
  apiKey: string
  apiFormat: ChannelApiFormat
  apiKeyAuth: 'bearer' | 'x-api-key' | 'x-goog-api-key'
  model: string
  /** 配置声明的静态模型候选。 */
  staticModels: FetchedModel[]
}

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'
const DEFAULT_CODEX_MODEL = 'gpt-5.5'
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'
const DEFAULT_GROK_MODEL = 'grok-4.6'
const DEFAULT_OPENCODE_MODEL = 'deepseek-v4-pro'

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'grok', label: 'Grok' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'opencode', label: 'OpenCode' },
]

const API_FORMAT_LABELS: Record<ChannelApiFormat, string> = {
  anthropic: 'Anthropic Messages',
  openai_responses: 'OpenAI Responses',
  openai_chat: 'OpenAI Chat Completions',
  gemini_native: 'Gemini generateContent',
}

const kindFilter = ref<KindFilter>('all')
const ccProviders = ref<CcProviderInfo[]>([])
const loading = ref(false)
const ccError = ref('')

const testingId = ref<string | null>(null)
const testingLatencyId = ref<string | null>(null)
const fetchingModelsId = ref<string | null>(null)
const revealedKeys = ref<Record<string, boolean>>({})
const latencyResults = ref<Record<string, EndpointLatencyResult[]>>({})
const modelResults = ref<Record<string, FetchedModel[]>>({})
const modelsExpanded = ref<Record<string, boolean>>({})
const modelErrors = ref<Record<string, string>>({})
const probeResults = ref<Record<string, ChannelProbeResult>>({})
/** 卡片上手动选中的测试模型（点击模型列表里的模型后生效，连通测试用它）。 */
const selectedModels = ref<Record<string, string>>({})
function toFetched(models: Array<{ id: string; name?: string }>): FetchedModel[] {
  return models.map((model) => ({ id: model.id, ownedBy: model.name || null }))
}

function defaultModel(kind: ChannelProviderKind): string {
  switch (kind) {
    case 'claude':
      return DEFAULT_CLAUDE_MODEL
    case 'codex':
      return DEFAULT_CODEX_MODEL
    case 'grok':
      return DEFAULT_GROK_MODEL
    case 'gemini':
      return DEFAULT_GEMINI_MODEL
    case 'opencode':
      return DEFAULT_OPENCODE_MODEL
  }
}

/** 卡片当前生效的测试模型：手动选中 > 配置模型 > 静态候选第一个 > 类型默认。 */
function modelOf(p: PanelProvider): string {
  const selected = selectedModels.value[p.key]
  if (selected) return selected
  const configured = p.model.trim()
  if (configured) return configured
  const firstStatic = p.staticModels[0]?.id
  if (firstStatic) return firstStatic
  return defaultModel(p.kind)
}

/** 点击模型列表中的模型：选中为当前测试模型（随后连通测试即用该模型）。 */
function selectTestModel(p: PanelProvider, modelId: string) {
  selectedModels.value = { ...selectedModels.value, [p.key]: modelId }
}

/** cc-switch 的应用名 → 面板渠道种类。 */
function ccAppToKind(app: string): ChannelProviderKind {
  switch (app) {
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'gemini':
      return 'gemini'
    case 'grokbuild':
      return 'grok'
    default:
      return 'opencode'
  }
}

/** 组装统一供应商视图。 */
const providers = computed<PanelProvider[]>(() => {
  const result: PanelProvider[] = []

  for (const provider of ccProviders.value) {
    const kind = ccAppToKind(provider.app)
    result.push({
      key: `cc-${provider.app}-${provider.id}`,
      kind,
      name: provider.name,
      websiteUrl: provider.websiteUrl,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
      apiKeyAuth: provider.apiKeyAuth,
      model: provider.model,
      staticModels: toFetched(provider.models),
    })
  }

  return result
})

const filteredProviders = computed(() => kindFilter.value === 'all'
  ? providers.value
  : providers.value.filter((provider) => provider.kind === kindFilter.value))

const counts = computed<Record<KindFilter, number>>(() => ({
  all: providers.value.length,
  claude: providers.value.filter((provider) => provider.kind === 'claude').length,
  codex: providers.value.filter((provider) => provider.kind === 'codex').length,
  grok: providers.value.filter((provider) => provider.kind === 'grok').length,
  gemini: providers.value.filter((provider) => provider.kind === 'gemini').length,
  opencode: providers.value.filter((provider) => provider.kind === 'opencode').length,
}))

async function loadAll() {
  loading.value = true
  ccError.value = ''
  try {
    ccProviders.value = await backend.listCcProviders()
  } catch (error) {
    ccError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!props.preview) void loadAll()
})

function toChannel(p: PanelProvider): ChannelConfig {
  return {
    id: p.key,
    name: p.name,
    provider: p.kind,
    websiteUrl: p.websiteUrl,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: modelOf(p),
    apiFormat: p.apiFormat,
    apiKeyAuth: p.apiKeyAuth,
  }
}

async function runProbe(p: PanelProvider) {
  testingId.value = p.key
  delete probeResults.value[p.key]
  const apiKey = p.apiKey
  try {
    const result = await backend.probeChannel({ ...toChannel(p), apiKey })
    probeResults.value[p.key] = result
  } catch (error) {
    probeResults.value[p.key] = {
      ok: false,
      latencyMs: 0,
      endpoint: p.baseUrl,
      reply: '',
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    }
  } finally {
    testingId.value = null
  }
}

async function runLatencyTest(p: PanelProvider) {
  testingLatencyId.value = p.key
  delete latencyResults.value[p.key]
  try {
    const results = await backend.probeWebsiteLatency(toChannel(p))
    latencyResults.value[p.key] = results
  } catch (error) {
    latencyResults.value[p.key] = [
      {
        url: p.websiteUrl || p.baseUrl,
        label: '官网链接',
        latencyMs: null,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      },
    ]
  } finally {
    testingLatencyId.value = null
  }
}

async function fetchModels(p: PanelProvider) {
  fetchingModelsId.value = p.key
  delete modelResults.value[p.key]
  delete modelErrors.value[p.key]
  try {
    const apiKey = p.apiKey
    if (apiKey) {
      try {
        const models = await backend.fetchChannelModels({ ...toChannel(p), apiKey })
        modelResults.value[p.key] = models
        modelsExpanded.value = { ...modelsExpanded.value, [p.key]: true }
        return
      } catch (error) {
        if (!p.staticModels.length) {
          modelErrors.value[p.key] = error instanceof Error ? error.message : String(error)
          return
        }
      }
    } else {
      if (p.staticModels.length) {
        modelResults.value[p.key] = p.staticModels
        modelsExpanded.value = { ...modelsExpanded.value, [p.key]: true }
        return
      }
      modelErrors.value[p.key] = '未配置 API Key，且没有静态模型列表'
      return
    }
    // OpenCode 等有静态套餐模型配置的供应商：实时拉取失败时列出配置声明。
    if (p.staticModels.length) {
      modelResults.value[p.key] = p.staticModels
      modelsExpanded.value = { ...modelsExpanded.value, [p.key]: true }
      return
    }
  } catch (error) {
    modelErrors.value[p.key] = error instanceof Error ? error.message : String(error)
  } finally {
    fetchingModelsId.value = null
  }
}

function toggleModels(p: PanelProvider) {
  if (!modelResults.value[p.key]?.length) {
    void fetchModels(p)
    return
  }
  modelsExpanded.value = { ...modelsExpanded.value, [p.key]: !modelsExpanded.value[p.key] }
}

function maskedKey(p: PanelProvider): string {
  const key = p.apiKey
  if (!key) return '未配置 API Key'
  if (revealedKeys.value[p.key]) return key
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`
}

function latencyClass(latency: number): string {
  if (latency < 300) return 'fast'
  if (latency < 600) return 'mid'
  return 'slow'
}

function latencyLabel(ms: number): string {
  return `${ms} ms`
}

const hasAnySource = computed(() => ccProviders.value.length > 0)
</script>

<template>
  <section class="channel-panel" aria-label="渠道检测">
    <header class="channel-panel-header">
      <h2>渠道检测</h2>
      <span v-if="loading" class="channel-loading-hint">
        <Loader2 :size="13" class="channel-spin" />
        加载中...
      </span>
      <button class="ghost-button" type="button" title="重新加载 cc-switch 配置" @click="loadAll">
        <RefreshCw :size="14" :class="{ 'channel-spin': loading }" />
        刷新
      </button>
    </header>

    <div class="channel-panel-body">
      <div v-if="ccError" class="channel-source-error">
        读取 cc-switch 配置失败：{{ ccError }}
      </div>

      <div class="channel-filter-row">
        <button
          v-for="item in KIND_FILTERS"
          :key="item.id"
          type="button"
          class="filter-pill"
          :class="{ active: kindFilter === item.id }"
          @click="kindFilter = item.id"
        >
          {{ item.label }}<span class="channel-filter-count">{{ counts[item.id] }}</span>
        </button>
      </div>

      <div v-if="filteredProviders.length" class="channel-list">
        <div
          v-for="provider in filteredProviders"
          :key="provider.key"
          class="channel-card"
          :data-testid="`channel-card-${provider.key}`"
        >
          <div class="channel-card-top">
            <div class="channel-card-title">
              <strong :title="provider.name">{{ provider.name }}</strong>
            </div>
          </div>
          <div class="channel-card-meta">
            <span
              v-if="provider.websiteUrl"
              class="channel-meta-row"
              :title="provider.websiteUrl"
            >
              <Globe :size="13" />官网：{{ provider.websiteUrl }}
            </span>
            <span class="channel-meta-row" :title="provider.apiFormat">
              <List :size="13" />格式：{{ API_FORMAT_LABELS[provider.apiFormat] }}
            </span>
            <span
              class="channel-meta-row"
              :title="provider.baseUrl || '未配置接口地址（无法做连通测试）'"
            >
              <Link2 :size="13" />接口：{{ provider.baseUrl || '未配置' }}
            </span>
            <span class="channel-meta-row">
              <KeyRound :size="13" />
              <span class="channel-key">{{ maskedKey(provider) }}</span>
              <span v-if="provider.apiKey">
                <button
                  type="button"
                  class="channel-key-toggle"
                  :title="revealedKeys[provider.key] ? '隐藏 Key' : '显示 Key'"
                  @click="
                    revealedKeys = {
                      ...revealedKeys,
                      [provider.key]: !revealedKeys[provider.key],
                    }
                  "
                >
                  <EyeOff v-if="revealedKeys[provider.key]" :size="12" />
                  <Eye v-else :size="12" />
                </button>
              </span>
            </span>
            <span class="channel-meta-row" :title="`连通测试使用模型：${modelOf(provider)}`">
              <Cpu :size="13" />模型：{{ modelOf(provider) }}
            </span>
            <span
              class="channel-meta-row channel-model-row"
              title="点击查看模型列表"
              @click="toggleModels(provider)"
            >
              <RadioTower :size="13" />
              <span class="channel-model-value">模型列表</span>
              <ChevronDown
                v-if="modelResults[provider.key]?.length"
                :size="12"
                class="channel-chevron"
                :class="{ open: modelsExpanded[provider.key] }"
              />
            </span>
          </div>

          <div class="channel-card-test">
            <button
              type="button"
              class="primary-button small"
              :disabled="testingLatencyId === provider.key"
              :title="'纯网络延迟检测，不发送消息'"
              @click="runLatencyTest(provider)"
            >
              <Loader2 v-if="testingLatencyId === provider.key" :size="13" class="channel-spin" />
              <Zap v-else :size="13" />
              {{ testingLatencyId === provider.key ? '检测中...' : '测延迟' }}
            </button>
            <button
              type="button"
              class="ghost-button small"
              :disabled="fetchingModelsId === provider.key"
              title="从接口获取模型列表"
              @click="fetchModels(provider)"
            >
              <Loader2 v-if="fetchingModelsId === provider.key" :size="13" class="channel-spin" />
              <List v-else :size="13" />
              {{ fetchingModelsId === provider.key ? '获取中...' : '获取模型' }}
            </button>
            <button
              type="button"
              class="ghost-button small"
              :disabled="testingId === provider.key || !provider.baseUrl"
              :title="
                provider.baseUrl
                  ? '发送 hi 验证接口可用性'
                  : '该供应商未配置接口地址，无法做连通测试'
              "
              @click="runProbe(provider)"
            >
              <Loader2 v-if="testingId === provider.key" :size="13" class="channel-spin" />
              <Mail v-else :size="13" />
              {{ testingId === provider.key ? '测试中...' : '连通测试' }}
            </button>
          </div>

          <div
            v-if="latencyResults[provider.key]"
            class="channel-latency-result"
            :data-testid="`channel-latency-result-${provider.key}`"
          >
            <template v-for="item in latencyResults[provider.key]" :key="item.url">
              <span class="channel-latency-row">
                <strong>{{ item.label }}</strong>
                <template v-if="item.latencyMs !== null">
                  <span class="channel-latency-value" :class="latencyClass(item.latencyMs)">
                    {{ latencyLabel(item.latencyMs) }}
                  </span>
                  <span v-if="item.status" class="channel-latency-status">HTTP {{ item.status }}</span>
                </template>
                <span v-else class="channel-latency-error" :title="item.error ?? ''">
                  {{ item.error ?? '不可达' }}
                </span>
              </span>
            </template>
          </div>

          <div
            v-if="modelResults[provider.key]"
            class="channel-models-result"
            :data-testid="`channel-models-result-${provider.key}`"
          >
            <button type="button" class="channel-models-header" @click="toggleModels(provider)">
              <strong>模型列表（{{ modelResults[provider.key].length }} 个）</strong>
              <ChevronDown
                :size="14"
                class="channel-chevron"
                :class="{ open: modelsExpanded[provider.key] }"
              />
            </button>
            <div v-if="modelsExpanded[provider.key]" class="channel-models-list">
              <button
                v-for="model in modelResults[provider.key]"
                :key="model.id"
                type="button"
                class="channel-model-chip"
                :class="{ selected: modelOf(provider) === model.id }"
                :title="`${model.ownedBy ?? model.id} · 点击选中后用「连通测试」验证`"
                @click="selectTestModel(provider, model.id)"
              >
                {{ model.id }}
              </button>
              <div v-if="!modelResults[provider.key].length" class="channel-models-empty">
                没有可用模型
              </div>
              <small class="channel-models-hint">
                点击模型可选中为测试模型（高亮），再点「连通测试」即用该模型发消息验证。
              </small>
            </div>
          </div>
          <div
            v-else-if="modelErrors[provider.key]"
            class="channel-test-result fail"
            :data-testid="`channel-models-error-${provider.key}`"
          >
            <XCircle :size="14" />
            <div class="channel-test-text">
              <strong>获取模型失败</strong>
              <span :title="modelErrors[provider.key]">{{ modelErrors[provider.key] }}</span>
            </div>
          </div>

          <div
            v-if="probeResults[provider.key]"
            class="channel-test-result"
            :class="{ ok: probeResults[provider.key].ok, fail: !probeResults[provider.key].ok }"
            :data-testid="`channel-probe-result-${provider.key}`"
          >
            <template v-if="probeResults[provider.key].ok">
              <CheckCircle2 :size="14" />
              <div class="channel-test-text">
                <strong>可用 · {{ latencyLabel(probeResults[provider.key].latencyMs) }}</strong>
                <span v-if="probeResults[provider.key].reply" :title="probeResults[provider.key].reply">
                  回复：{{ probeResults[provider.key].reply }}
                </span>
              </div>
            </template>
            <template v-else>
              <XCircle :size="14" />
              <div class="channel-test-text">
                <strong>不可用 · {{ latencyLabel(probeResults[provider.key].latencyMs) }}</strong>
                <span :title="probeResults[provider.key].error">
                  原因：{{ probeResults[provider.key].error }}
                </span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div v-else class="channel-empty">
        <RadioTower :size="28" />
        <template v-if="hasAnySource">
          <p>当前筛选条件下没有供应商。</p>
          <p class="channel-empty-sub">
            试试切换上方的类型筛选；在 cc-switch 中新增供应商后点「刷新」即可看到。
          </p>
        </template>
        <template v-else>
          <p>没有找到任何供应商。</p>
          <p class="channel-empty-sub">
            供应商来自 cc-switch（~/.cc-switch/cc-switch.db）。请先在 cc-switch 中配置供应商，然后点「刷新」。
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.channel-loading-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary, #999);
  font-size: 12px;
}

.channel-source-error {
  background: var(--danger-bg, rgba(239, 68, 68, 0.12));
  border: 1px solid var(--danger, #ef4444);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 12px;
}

.channel-empty-sub {
  font-size: 12px;
  color: var(--text-secondary, #999);
  max-width: 520px;
}

.channel-models-hint {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-secondary, #999);
}
</style>
