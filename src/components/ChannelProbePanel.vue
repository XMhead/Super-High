<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
  Pencil,
  Play,
  Plus,
  RadioTower,
  Trash2,
  X,
  XCircle,
  Zap,
} from 'lucide-vue-next'

import ClaudeIcon from './icons/ClaudeIcon.vue'
import CodexIcon from './icons/CodexIcon.vue'
import { backend } from '@/lib/tauri'
import { useWorkspaceStore } from '@/stores/workspace'
import type {
  ChannelApiFormat,
  ChannelConfig,
  ChannelProbeResult,
  ChannelProviderKind,
  EndpointLatencyResult,
  FetchedModel,
} from '@/types'

type ChannelFilter = 'all' | ChannelProviderKind

const store = useWorkspaceStore()

const DEFAULT_WEBSITE_URL = 'https://claudenb.com'
const DEFAULT_CLAUDE_URL = 'https://claudenb.com'
const DEFAULT_CODEX_URL = 'https://claudenb.com/v1'
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'
const DEFAULT_CODEX_MODEL = 'gpt-5.5'

/** 每种渠道类型的原生默认 API 格式（Claude → Messages，Codex → Responses）。 */
const DEFAULT_API_FORMAT: Record<ChannelProviderKind, ChannelApiFormat> = {
  claude: 'anthropic',
  codex: 'openai_responses',
}

/** API 格式选择列表：明确标注原生/兼容、路径、请求体与鉴权差异（对齐 cc-switch 的 apiFormat）。 */
const API_FORMAT_OPTIONS: Array<{ id: ChannelApiFormat; label: string; hint: string; endpoint: string }> = [
  {
    id: 'anthropic',
    label: 'Anthropic Messages（Claude Code 原生）',
    endpoint: '/v1/messages',
    hint: '路径 /v1/messages · 请求体 messages[] · 鉴权 x-api-key · 响应 content[0].text',
  },
  {
    id: 'openai_responses',
    label: 'OpenAI Responses（Codex 原生）',
    endpoint: '/v1/responses',
    hint: '路径 /v1/responses · 请求体 input · 鉴权 Bearer · 响应 output[0].content[0].text',
  },
  {
    id: 'openai_chat',
    label: 'OpenAI Chat Completions（兼容格式）',
    endpoint: '/v1/chat/completions',
    hint: '路径 /v1/chat/completions · 请求体 messages[] · 鉴权 Bearer · 响应 choices[0].message.content',
  },
]

const PROVIDER_LABELS: Record<ChannelProviderKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
}

const filter = ref<ChannelFilter>('all')
const formOpen = ref(false)
const editingId = ref<string | null>(null)
const formName = ref('')
const formProvider = ref<ChannelProviderKind>('claude')
const formWebsiteUrl = ref(DEFAULT_WEBSITE_URL)
const formBaseUrl = ref(DEFAULT_CLAUDE_URL)
const formApiKey = ref('')
const formModel = ref(DEFAULT_CLAUDE_MODEL)
const formApiFormat = ref<ChannelApiFormat>(DEFAULT_API_FORMAT.claude)
const formError = ref('')
const formModels = ref<FetchedModel[]>([])
const formModelsExpanded = ref(false)
const formFetchingModels = ref(false)
const formModelsError = ref('')
const testingId = ref<string | null>(null)
const testingLatencyId = ref<string | null>(null)
const fetchingModelsId = ref<string | null>(null)
const revealedKeys = ref<Record<string, boolean>>({})
const latencyResults = ref<Record<string, EndpointLatencyResult[]>>({})
const modelResults = ref<Record<string, FetchedModel[]>>({})
const modelsExpanded = ref<Record<string, boolean>>({})
const modelErrors = ref<Record<string, string>>({})
const probeResults = ref<Record<string, ChannelProbeResult>>({})

const channels = computed(() => store.settings.channels ?? [])
const filteredChannels = computed(() => (
  filter.value === 'all' ? channels.value : channels.value.filter((channel) => channel.provider === filter.value)
))
const counts = computed(() => ({
  all: channels.value.length,
  claude: channels.value.filter((channel) => channel.provider === 'claude').length,
  codex: channels.value.filter((channel) => channel.provider === 'codex').length,
}))

const filters: Array<{ id: ChannelFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
]

function providerLabel(provider: ChannelProviderKind): string {
  return PROVIDER_LABELS[provider]
}

function defaultUrl(provider: ChannelProviderKind): string {
  return provider === 'claude' ? DEFAULT_CLAUDE_URL : DEFAULT_CODEX_URL
}

function defaultModel(provider: ChannelProviderKind): string {
  return provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL
}

function defaultApiFormat(provider: ChannelProviderKind): ChannelApiFormat {
  return DEFAULT_API_FORMAT[provider]
}

function apiFormatOf(channel: ChannelConfig): ChannelApiFormat {
  return channel.apiFormat ?? DEFAULT_API_FORMAT[channel.provider]
}

function apiFormatLabel(format: ChannelApiFormat): string {
  return API_FORMAT_OPTIONS.find((option) => option.id === format)?.label ?? format
}

function apiFormatHint(format: ChannelApiFormat): string {
  return API_FORMAT_OPTIONS.find((option) => option.id === format)?.hint ?? ''
}

function websiteUrlOf(channel: ChannelConfig): string {
  return channel.websiteUrl?.trim() || channel.baseUrl
}

function buildEndpoint(channel: ChannelConfig): string {
  const base = channel.baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  const format = apiFormatOf(channel)
  if (format === 'anthropic') {
    if (base.endsWith('/v1/messages')) return base
    if (base.endsWith('/v1')) return `${base}/messages`
    return `${base}/v1/messages`
  }
  if (format === 'openai_responses') {
    if (base.endsWith('/v1/responses') || base.endsWith('/responses')) return base
    if (base.endsWith('/v1')) return `${base}/responses`
    return `${base}/v1/responses`
  }
  if (base.endsWith('/chat/completions')) return base
  if (base.endsWith('/v1')) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function maskedKey(channel: ChannelConfig): string {
  const key = channel.apiKey.trim()
  if (!key) return '未设置 API Key'
  if (revealedKeys.value[channel.id]) return key
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`
}

function openNewForm(provider: ChannelProviderKind = 'claude') {
  editingId.value = null
  formProvider.value = provider
  formWebsiteUrl.value = DEFAULT_WEBSITE_URL
  formBaseUrl.value = defaultUrl(provider)
  formModel.value = defaultModel(provider)
  formApiFormat.value = defaultApiFormat(provider)
  formApiKey.value = ''
  formName.value = provider === 'claude' ? 'Claude Code' : 'Codex CLI'
  formError.value = ''
  formOpen.value = true
}

function onProviderChange() {
  const provider = formProvider.value
  const otherProvider = provider === 'claude' ? 'codex' : 'claude'
  if (!formWebsiteUrl.value.trim() || formWebsiteUrl.value.trim() === DEFAULT_WEBSITE_URL) {
    formWebsiteUrl.value = DEFAULT_WEBSITE_URL
  }
  if (!formBaseUrl.value.trim() || formBaseUrl.value.trim() === defaultUrl(otherProvider)) {
    formBaseUrl.value = defaultUrl(provider)
  }
  if (!formModel.value.trim() || formModel.value.trim() === defaultModel(otherProvider)) {
    formModel.value = defaultModel(provider)
  }
  if (!formApiFormat.value || formApiFormat.value === defaultApiFormat(otherProvider)) {
    formApiFormat.value = defaultApiFormat(provider)
  }
  if (!formName.value.trim() || formName.value.trim() === 'Claude Code' || formName.value.trim() === 'Codex CLI') {
    formName.value = provider === 'claude' ? 'Claude Code' : 'Codex CLI'
  }
}

function openEditForm(channel: ChannelConfig) {
  editingId.value = channel.id
  formProvider.value = channel.provider
  formWebsiteUrl.value = channel.websiteUrl || DEFAULT_WEBSITE_URL
  formBaseUrl.value = channel.baseUrl
  formModel.value = channel.model
  formApiFormat.value = apiFormatOf(channel)
  formApiKey.value = channel.apiKey
  formName.value = channel.name
  formError.value = ''
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
  editingId.value = null
  formError.value = ''
  formModels.value = []
  formModelsExpanded.value = false
  formModelsError.value = ''
}

function buildDraftChannel(): ChannelConfig {
  return {
    id: editingId.value ?? 'draft',
    name: formName.value.trim() || 'draft',
    provider: formProvider.value,
    websiteUrl: formWebsiteUrl.value.trim(),
    baseUrl: formBaseUrl.value.trim(),
    apiKey: formApiKey.value.trim(),
    model: formModel.value.trim(),
  }
}

async function fetchFormModels() {
  if (formFetchingModels.value) return
  const baseUrl = formBaseUrl.value.trim()
  const apiKey = formApiKey.value.trim()
  if (!baseUrl) {
    formModelsError.value = '请先填写接口地址'
    formModelsExpanded.value = true
    return
  }
  if (!apiKey) {
    formModelsError.value = '请先填写 API Key'
    formModelsExpanded.value = true
    return
  }
  formFetchingModels.value = true
  formModelsError.value = ''
  try {
    const models = await backend.fetchChannelModels(buildDraftChannel())
    formModels.value = models
    formModelsExpanded.value = true
  } catch (error) {
    formModelsError.value = error instanceof Error ? error.message : String(error)
    formModelsExpanded.value = true
  } finally {
    formFetchingModels.value = false
  }
}

function openFormModels() {
  if (formFetchingModels.value) return
  if (!formModels.value.length) {
    void fetchFormModels()
    return
  }
  formModelsExpanded.value = true
}

function toggleFormModels() {
  if (formFetchingModels.value) return
  if (!formModels.value.length) {
    void fetchFormModels()
    return
  }
  formModelsExpanded.value = !formModelsExpanded.value
}

function selectFormModel(modelId: string) {
  formModel.value = modelId
  formModelsExpanded.value = false
}

// 表单配置变化后，之前获取的模型列表已不匹配，清空等待重新获取。
watch([formProvider, formWebsiteUrl, formBaseUrl, formApiKey, formApiFormat], () => {
  formModels.value = []
  formModelsExpanded.value = false
  formModelsError.value = ''
})

async function submitForm() {
  const name = formName.value.trim()
  const websiteUrl = formWebsiteUrl.value.trim()
  const baseUrl = formBaseUrl.value.trim()
  if (!name) {
    formError.value = '渠道名称不能为空'
    return
  }
  if (!websiteUrl) {
    formError.value = '官网链接不能为空'
    return
  }
  if (!baseUrl) {
    formError.value = '接口地址不能为空'
    return
  }
  const channel: ChannelConfig = {
    id: editingId.value ?? crypto.randomUUID(),
    name,
    provider: formProvider.value,
    websiteUrl,
    baseUrl,
    apiKey: formApiKey.value.trim(),
    model: formModel.value.trim(),
    apiFormat: formApiFormat.value,
  }
  await store.saveChannel(channel)
  closeForm()
}

async function removeChannel(channel: ChannelConfig) {
  if (!window.confirm(`确定删除渠道「${channel.name}」吗？`)) return
  await store.deleteChannel(channel.id)
  delete probeResults.value[channel.id]
  delete latencyResults.value[channel.id]
  delete modelResults.value[channel.id]
  delete modelErrors.value[channel.id]
  delete modelsExpanded.value[channel.id]
  delete revealedKeys.value[channel.id]
}

async function runProbe(channel: ChannelConfig) {
  testingId.value = channel.id
  delete probeResults.value[channel.id]
  try {
    const result = await backend.probeChannel(channel)
    probeResults.value[channel.id] = result
  } catch (error) {
    probeResults.value[channel.id] = {
      ok: false,
      latencyMs: 0,
      endpoint: channel.baseUrl,
      reply: '',
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    }
  } finally {
    testingId.value = null
  }
}

async function runLatencyTest(channel: ChannelConfig) {
  testingLatencyId.value = channel.id
  delete latencyResults.value[channel.id]
  try {
    const results = await backend.probeWebsiteLatency(channel)
    latencyResults.value[channel.id] = results
  } catch (error) {
    latencyResults.value[channel.id] = [{
      url: websiteUrlOf(channel),
      label: '官网链接',
      latencyMs: null,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    }]
  } finally {
    testingLatencyId.value = null
  }
}

async function fetchModels(channel: ChannelConfig) {
  fetchingModelsId.value = channel.id
  delete modelResults.value[channel.id]
  delete modelErrors.value[channel.id]
  try {
    const models = await backend.fetchChannelModels(channel)
    modelResults.value[channel.id] = models
    modelsExpanded.value = { ...modelsExpanded.value, [channel.id]: true }
  } catch (error) {
    modelErrors.value[channel.id] = error instanceof Error ? error.message : String(error)
  } finally {
    fetchingModelsId.value = null
  }
}

async function toggleModels(channel: ChannelConfig) {
  if (!modelResults.value[channel.id]?.length) {
    await fetchModels(channel)
    return
  }
  modelsExpanded.value = { ...modelsExpanded.value, [channel.id]: !modelsExpanded.value[channel.id] }
}

async function selectModel(channel: ChannelConfig, modelId: string) {
  if (channel.model === modelId) return
  await store.saveChannel({ ...channel, model: modelId })
}

function latencyLabel(ms: number): string {
  return `${ms} ms`
}

function latencyClass(latency: number): string {
  if (latency < 300) return 'fast'
  if (latency < 600) return 'mid'
  return 'slow'
}

async function addDefaultChannel(provider: ChannelProviderKind) {
  const channel: ChannelConfig = {
    id: crypto.randomUUID(),
    name: provider === 'claude' ? 'Claude Code' : 'Codex CLI',
    provider,
    websiteUrl: DEFAULT_WEBSITE_URL,
    baseUrl: defaultUrl(provider),
    apiKey: '',
    model: defaultModel(provider),
    apiFormat: defaultApiFormat(provider),
  }
  await store.saveChannel(channel)
}
</script>

<template>
  <section class="channel-panel" aria-label="渠道检测">
    <header class="channel-panel-header">
      <h2>渠道检测</h2>
      <button class="primary-button" type="button" @click="openNewForm(filter === 'all' ? 'claude' : filter)">
        <Plus :size="14" />
        新建渠道
      </button>
    </header>

    <div class="channel-panel-body">
      <div class="channel-filter-row">
        <button
          v-for="item in filters"
          :key="item.id"
          type="button"
          class="filter-pill"
          :class="{ active: filter === item.id }"
          @click="filter = item.id"
        >
          {{ item.label }}<span class="channel-filter-count">{{ counts[item.id] }}</span>
        </button>
      </div>

      <div v-if="formOpen" class="channel-form-card">
        <div class="channel-form-title">
          <strong>{{ editingId ? '编辑渠道' : '新建渠道' }}</strong>
          <button type="button" class="icon-button" title="关闭" @click="closeForm"><X :size="14" /></button>
        </div>
        <div class="channel-form-grid">
          <label>
            渠道名称
            <input v-model="formName" placeholder="例如：Claude 主渠道" />
          </label>
          <label>
            类型
            <select v-model="formProvider" @change="onProviderChange">
              <option :value="'claude'">Claude Code</option>
              <option :value="'codex'">Codex CLI</option>
            </select>
          </label>
          <label class="channel-form-wide">
            官网链接（必填）
            <input v-model="formWebsiteUrl" placeholder="https://claudenb.com" />
            <small>用于纯网络延迟检测；默认 {{ DEFAULT_WEBSITE_URL }}</small>
          </label>
          <label class="channel-form-wide">
            接口地址（必填）
            <input v-model="formBaseUrl" placeholder="https://claudenb.com 或 https://claudenb.com/v1" />
            <small>接口地址会按所选 API 格式自动补全：Messages → /v1/messages、Responses → /v1/responses、Chat → /v1/chat/completions</small>
          </label>
          <label class="channel-form-wide">
            API 格式
            <select v-model="formApiFormat" data-testid="form-api-format">
              <option v-for="option in API_FORMAT_OPTIONS" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
            <small>{{ apiFormatHint(formApiFormat) }}</small>
          </label>
          <label>
            API Key
            <input v-model="formApiKey" type="password" placeholder="sk-..." autocomplete="off" />
          </label>
          <label>
            模型（可留空使用默认）
            <div class="channel-form-model">
              <input
                v-model="formModel"
                placeholder="Claude 默认 claude-opus-5 / Codex 默认 gpt-5.5"
                autocomplete="off"
                @click="openFormModels"
              />
              <button
                type="button"
                class="channel-form-model-toggle"
                title="获取并下拉选择模型"
                :disabled="formFetchingModels"
                @click="toggleFormModels"
              >
                <Loader2 v-if="formFetchingModels" :size="13" class="channel-spin" />
                <ChevronDown v-else :size="13" class="channel-chevron" :class="{ open: formModelsExpanded }" />
              </button>
              <div v-if="formModelsExpanded" class="channel-form-model-dropdown" data-testid="form-model-dropdown">
                <template v-if="formModels.length">
                  <button
                    v-for="model in formModels"
                    :key="model.id"
                    type="button"
                    class="channel-form-model-option"
                    :class="{ selected: formModel.trim() === model.id }"
                    :title="model.ownedBy ?? model.id"
                    @click="selectFormModel(model.id)"
                  >
                    {{ model.id }}
                  </button>
                </template>
                <div v-else-if="formFetchingModels" class="channel-form-model-empty">正在获取模型列表...</div>
                <div v-else-if="formModelsError" class="channel-form-model-error">{{ formModelsError }}</div>
                <div v-else class="channel-form-model-empty">点击右侧箭头获取模型列表</div>
              </div>
            </div>
          </label>
        </div>
        <div v-if="formError" class="channel-form-error">{{ formError }}</div>
        <div class="channel-form-actions">
          <button class="primary-button" type="button" @click="submitForm">保存</button>
          <button class="ghost-button" type="button" @click="closeForm">取消</button>
        </div>
      </div>

      <div v-if="channels.length" class="channel-list">
        <div v-for="channel in filteredChannels" :key="channel.id" class="channel-card" :data-testid="`channel-card-${channel.id}`">
          <div class="channel-card-top">
            <div class="channel-card-title">
              <span class="channel-provider-badge" :class="channel.provider">
                <ClaudeIcon v-if="channel.provider === 'claude'" :size="14" />
                <CodexIcon v-else :size="14" />
                <span>{{ providerLabel(channel.provider) }}</span>
              </span>
              <strong :title="channel.name">{{ channel.name }}</strong>
            </div>
            <div class="channel-card-actions">
              <button type="button" class="ghost-button small" title="编辑" @click="openEditForm(channel)">
                <Pencil :size="13" />
                编辑
              </button>
              <button type="button" class="ghost-button small channel-danger" title="删除" @click="removeChannel(channel)">
                <Trash2 :size="13" />
                删除
              </button>
            </div>
          </div>
          <div class="channel-card-meta">
            <span class="channel-meta-row" :title="websiteUrlOf(channel)"><Globe :size="13" />官网：{{ websiteUrlOf(channel) }}</span>
            <span class="channel-meta-row" :title="apiFormatHint(apiFormatOf(channel))"><List :size="13" />格式：{{ apiFormatLabel(apiFormatOf(channel)) }}</span>
            <span class="channel-meta-row" :title="buildEndpoint(channel)"><Link2 :size="13" />接口：{{ buildEndpoint(channel) }}</span>
            <span class="channel-meta-row">
              <KeyRound :size="13" />
              <span class="channel-key">{{ maskedKey(channel) }}</span>
              <button
                v-if="channel.apiKey"
                type="button"
                class="channel-key-toggle"
                :title="revealedKeys[channel.id] ? '隐藏 Key' : '显示 Key'"
                @click="revealedKeys = { ...revealedKeys, [channel.id]: !revealedKeys[channel.id] }"
              >
                <EyeOff v-if="revealedKeys[channel.id]" :size="12" />
                <Eye v-else :size="12" />
              </button>
            </span>
            <span
              class="channel-meta-row channel-model-row"
              title="点击展开选择模型"
              @click="toggleModels(channel)"
            >
              <Cpu :size="13" />
              <span class="channel-model-value">{{ channel.model.trim() || (channel.provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL) }}</span>
              <ChevronDown v-if="modelResults[channel.id]?.length" :size="12" class="channel-chevron" :class="{ open: modelsExpanded[channel.id] }" />
            </span>
          </div>
          <div class="channel-card-test">
            <button
              type="button"
              class="primary-button small"
              :disabled="testingLatencyId === channel.id"
              :title="'纯网络延迟检测，不发送消息'"
              @click="runLatencyTest(channel)"
            >
              <Loader2 v-if="testingLatencyId === channel.id" :size="13" class="channel-spin" />
              <Zap v-else :size="13" />
              {{ testingLatencyId === channel.id ? '检测中...' : '测延迟' }}
            </button>
            <button
              type="button"
              class="ghost-button small"
              :disabled="fetchingModelsId === channel.id"
              :title="'从接口获取模型列表'"
              @click="fetchModels(channel)"
            >
              <Loader2 v-if="fetchingModelsId === channel.id" :size="13" class="channel-spin" />
              <List v-else :size="13" />
              {{ fetchingModelsId === channel.id ? '获取中...' : '获取模型' }}
            </button>
            <button
              type="button"
              class="ghost-button small"
              :disabled="testingId === channel.id"
              :title="'发送“你是谁”验证接口可用性'"
              @click="runProbe(channel)"
            >
              <Loader2 v-if="testingId === channel.id" :size="13" class="channel-spin" />
              <Mail v-else :size="13" />
              {{ testingId === channel.id ? '测试中...' : '连通测试' }}
            </button>
          </div>

          <div v-if="latencyResults[channel.id]" class="channel-latency-result" data-testid="channel-latency-result">
            <template v-for="item in latencyResults[channel.id]" :key="item.url">
              <span class="channel-latency-row">
                <strong>{{ item.label }}</strong>
                <template v-if="item.latencyMs !== null">
                  <span class="channel-latency-value" :class="latencyClass(item.latencyMs)">{{ latencyLabel(item.latencyMs) }}</span>
                  <span v-if="item.status" class="channel-latency-status">HTTP {{ item.status }}</span>
                </template>
                <span v-else class="channel-latency-error" :title="item.error ?? ''">{{ item.error ?? '不可达' }}</span>
              </span>
            </template>
          </div>

          <div v-if="modelResults[channel.id]" class="channel-models-result" data-testid="channel-models-result">
            <button type="button" class="channel-models-header" @click="toggleModels(channel)">
              <strong>模型列表（{{ modelResults[channel.id].length }} 个）</strong>
              <ChevronDown :size="14" class="channel-chevron" :class="{ open: modelsExpanded[channel.id] }" />
            </button>
            <div v-if="modelsExpanded[channel.id]" class="channel-models-list">
              <button
                v-for="model in modelResults[channel.id]"
                :key="model.id"
                type="button"
                class="channel-model-chip"
                :class="{ selected: (channel.model.trim() || defaultModel(channel.provider)) === model.id }"
                :title="model.ownedBy ?? model.id"
                @click="selectModel(channel, model.id)"
              >
                {{ model.id }}
              </button>
              <div v-if="!modelResults[channel.id].length" class="channel-models-empty">接口没有返回任何模型</div>
            </div>
          </div>
          <div v-else-if="modelErrors[channel.id]" class="channel-test-result fail" data-testid="channel-models-error">
            <XCircle :size="14" />
            <div class="channel-test-text">
              <strong>获取模型失败</strong>
              <span :title="modelErrors[channel.id]">{{ modelErrors[channel.id] }}</span>
            </div>
          </div>

          <div v-if="probeResults[channel.id]" class="channel-test-result" :class="{ ok: probeResults[channel.id].ok, fail: !probeResults[channel.id].ok }">
            <template v-if="probeResults[channel.id].ok">
              <CheckCircle2 :size="14" />
              <div class="channel-test-text">
                <strong>可用 · {{ latencyLabel(probeResults[channel.id].latencyMs) }}</strong>
                <span v-if="probeResults[channel.id].reply" :title="probeResults[channel.id].reply">回复：{{ probeResults[channel.id].reply }}</span>
              </div>
            </template>
            <template v-else>
              <XCircle :size="14" />
              <div class="channel-test-text">
                <strong>不可用 · {{ latencyLabel(probeResults[channel.id].latencyMs) }}</strong>
                <span :title="probeResults[channel.id].error">原因：{{ probeResults[channel.id].error }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div v-else class="channel-empty">
        <RadioTower :size="28" />
        <p>还没有渠道。可以快速添加默认渠道，或手动新建。</p>
        <div class="channel-empty-actions">
          <button class="primary-button" type="button" @click="addDefaultChannel('claude')">添加 Claude Code 默认渠道</button>
          <button class="ghost-button" type="button" @click="addDefaultChannel('codex')">添加 Codex CLI 默认渠道</button>
        </div>
      </div>
    </div>
  </section>
</template>
