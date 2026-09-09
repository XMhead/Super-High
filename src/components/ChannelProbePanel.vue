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
  Pencil,
  Plus,
  RadioTower,
  RefreshCw,
  Settings2,
  Trash2,
  X,
  XCircle,
  Zap,
} from 'lucide-vue-next'

import ClaudeIcon from './icons/ClaudeIcon.vue'
import CodexIcon from './icons/CodexIcon.vue'
import DshIcon from './icons/DshIcon.vue'
import GeminiIcon from './icons/GeminiIcon.vue'
import GrokIcon from './icons/GrokIcon.vue'
import OpenCodeIcon from './icons/OpenCodeIcon.vue'
import { backend } from '@/lib/tauri'
import type {
  CcProfileInfo,
  CcProviderInfo,
  ChannelApiFormat,
  ChannelConfig,
  ChannelProbeResult,
  ChannelProviderKind,
  DshDefaultModel,
  DshProfileInfo,
  DshProviderInfo,
  DshProviderInput,
  DshProviderModelInput,
  EndpointLatencyResult,
  FetchedModel,
} from '@/types'

type KindFilter = 'all' | ChannelProviderKind

/** 面板内统一供应商视图：cc-switch 的供应商 + dsh 供应商。 */
interface PanelProvider {
  key: string
  kind: ChannelProviderKind
  /** 源内 id：cc 供应商 id 或 dsh 供应商 id（dsh 用于解析 API Key）。 */
  sourceId: string
  name: string
  websiteUrl: string
  baseUrl: string
  apiKey: string
  apiFormat: ChannelApiFormat
  apiKeyAuth: 'bearer' | 'x-api-key' | 'x-goog-api-key'
  model: string
  isCurrent: boolean
  /** 所属分组名（cc-switch 项目分组 / dsh 分组路由）。 */
  badges: string[]
  /** 配置里声明的静态模型候选（opencode 的 models 键 / dsh 的 models）。 */
  staticModels: FetchedModel[]
}

interface PanelGroup {
  key: string
  name: string
  detail: string
  /** 徽章文案：cc 分组为「当前」（cc-switch 当前项目分组）。 */
  badge: string | null
}

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'
const DEFAULT_CODEX_MODEL = 'gpt-5.5'
const DEFAULT_DSH_MODEL = 'grok-4.6'
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'
const DEFAULT_GROK_MODEL = 'grok-4.6'
const DEFAULT_OPENCODE_MODEL = 'deepseek-v4-pro'

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'dsh', label: 'DSH CLI' },
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

/** dsh 供应商的 API 格式选项（config.toml 的 api 字段）。 */
const DSH_API_OPTIONS = [
  { id: 'openai-responses', label: 'OpenAI Responses（Codex / Grok 原生）' },
  { id: 'openai-completions', label: 'OpenAI Chat Completions（兼容格式）' },
  { id: 'anthropic', label: 'Anthropic Messages（Claude Code 原生）' },
]

const kindFilter = ref<KindFilter>('all')
/** 分组过滤：「全部」或分组 key（cc:<profileId> / dsh:<profileId>）。 */
const groupFilter = ref<string>('all')

const ccProviders = ref<CcProviderInfo[]>([])
const ccProfiles = ref<CcProfileInfo[]>([])
const ccCurrent = ref<{ claude: string | null; codex: string | null }>({ claude: null, codex: null })
const dshProviders = ref<DshProviderInfo[]>([])
/** dsh 分组（~/.dsh/profiles/*），仅用于清理不需要的分组，不参与供应商过滤。 */
const dshProfiles = ref<DshProfileInfo[]>([])
/** dsh 全局默认路由（config.toml 的 active_provider / active_model）。 */
const dshDefault = ref<DshDefaultModel | null>(null)
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
/** dsh 供应商 key 解析结果缓存（不展示明文，只标记有无）。 */
const dshKeyResolved = ref<Record<string, '' | 'ok' | 'missing'>>({})
/** dsh 供应商已解析的测试用 key（仅在本组件内存中，用于连通测试请求）。 */
const dshKeys = ref<Record<string, string>>({})

function isDsh(p: PanelProvider): boolean {
  return p.kind === 'dsh'
}

function dshApiFormat(api: string): ChannelApiFormat {
  const value = api.trim().toLowerCase()
  if (value.includes('anthropic')) return 'anthropic'
  if (value.includes('completion') && !value.includes('response')) return 'openai_chat'
  return 'openai_responses'
}

function dshApiKeyAuth(api: string): 'bearer' | 'x-api-key' {
  const value = api.trim().toLowerCase()
  return value.includes('anthropic') ? 'x-api-key' : 'bearer'
}

function toFetched(models: Array<{ id: string; name?: string }>): FetchedModel[] {
  return models.map((model) => ({ id: model.id, ownedBy: model.name || null }))
}

function defaultModel(kind: ChannelProviderKind): string {
  switch (kind) {
    case 'claude':
      return DEFAULT_CLAUDE_MODEL
    case 'codex':
      return DEFAULT_CODEX_MODEL
    case 'dsh':
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
    const badges: string[] = []
    for (const profile of ccProfiles.value) {
      const bound =
        provider.app === 'claude' ? profile.claudeProvider : profile.codexProvider
      if (bound && bound === provider.id) badges.push(profile.name)
    }
    result.push({
      key: `cc-${provider.app}-${provider.id}`,
      kind,
      sourceId: provider.id,
      name: provider.name,
      websiteUrl: provider.websiteUrl,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
      apiKeyAuth: provider.apiKeyAuth,
      model: provider.model,
      isCurrent: provider.isCurrent,
      badges,
      staticModels: toFetched(provider.models),
    })
  }

  for (const provider of dshProviders.value) {
    // dsh 全局只有一个权威：全局默认供应商+模型（agent-default-model）。
    // 「当前」徽章 = 该供应商是全局默认；模型展示 = 全局默认模型或配置第一个模型。
    const isDefault = dshDefault.value?.provider === provider.id
    result.push({
      key: `dsh-${provider.id}`,
      kind: 'dsh',
      sourceId: provider.id,
      name: provider.name,
      websiteUrl: '',
      baseUrl: provider.baseUrl,
      apiKey: '',
      apiFormat: dshApiFormat(provider.api),
      apiKeyAuth: dshApiKeyAuth(provider.api),
      model: isDefault ? dshDefault.value?.model ?? '' : provider.models[0]?.id ?? '',
      isCurrent: isDefault,
      badges: [],
      staticModels: toFetched(provider.models),
    })
  }
  return result
})

/** 分组 chips：cc-switch 项目分组（dsh 不再区分 profile 分组，全局只有一个权威）。 */
const groups = computed<PanelGroup[]>(() => {
  const result: PanelGroup[] = []
  for (const profile of ccProfiles.value) {
    const name = (id: string | null) => {
      if (!id) return '未绑定'
      return ccProviders.value.find((provider) => provider.id === id)?.name ?? id
    }
    result.push({
      key: `cc:${profile.id}`,
      name: profile.name,
      detail: `Claude：${name(profile.claudeProvider)} · Codex：${name(profile.codexProvider)}`,
      badge:
        profile.id === ccCurrent.value.claude || profile.id === ccCurrent.value.codex
          ? '当前'
          : null,
    })
  }
  return result
})

/** 当前筛选后可见的供应商。 */
const filteredProviders = computed<PanelProvider[]>(() => {
  if (groupFilter.value === 'all') {
    return kindFilter.value === 'all'
      ? providers.value
      : providers.value.filter((provider) => provider.kind === kindFilter.value)
  }
  // 仅 cc-switch 项目分组过滤（dsh 全局一个权威，不参与分组过滤）。
  const profile = ccProfiles.value.find((item) => item.id === groupFilter.value.slice(3))
  if (!profile) return []
  return providers.value.filter((provider) => {
    if (provider.kind === 'dsh') return false
    if (kindFilter.value !== 'all' && provider.kind !== kindFilter.value) return false
    const bound = provider.kind === 'claude' ? profile.claudeProvider : profile.codexProvider
    return !!bound && bound === provider.sourceId
  })
})

const counts = computed<Record<KindFilter, number>>(() => ({
  all: providers.value.length,
  claude: providers.value.filter((provider) => provider.kind === 'claude').length,
  codex: providers.value.filter((provider) => provider.kind === 'codex').length,
  dsh: providers.value.filter((provider) => provider.kind === 'dsh').length,
  grok: providers.value.filter((provider) => provider.kind === 'grok').length,
  gemini: providers.value.filter((provider) => provider.kind === 'gemini').length,
  opencode: providers.value.filter((provider) => provider.kind === 'opencode').length,
}))

async function loadAll() {
  loading.value = true
  ccError.value = ''
  try {
    const [cc, profiles, dshProvidersList, dshProfilesList, dshDefaultModel] = await Promise.all([
      backend.listCcProviders(),
      backend.listCcProfiles(),
      backend.listDshProviders(),
      backend.listDshProfiles(),
      backend.getDshDefaultModel(),
    ])
    ccProviders.value = cc
    ccProfiles.value = profiles.profiles
    ccCurrent.value = { claude: profiles.currentClaude, codex: profiles.currentCodex }
    dshProviders.value = dshProvidersList
    dshProfiles.value = dshProfilesList
    dshDefault.value = dshDefaultModel
    if (
      groupFilter.value !== 'all' &&
      !groups.value.some((group) => group.key === groupFilter.value)
    ) {
      groupFilter.value = 'all'
    }
  } catch (error) {
    ccError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadAll()
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

async function resolveDshKey(p: PanelProvider): Promise<string> {
  if (p.apiKey) return p.apiKey
  if (dshKeys.value[p.key]) return dshKeys.value[p.key]
  try {
    const key = await backend.getDshProviderApiKey(p.sourceId)
    dshKeys.value = { ...dshKeys.value, [p.key]: key ?? '' }
    dshKeyResolved.value = { ...dshKeyResolved.value, [p.key]: key ? 'ok' : 'missing' }
    return key ?? ''
  } catch {
    dshKeyResolved.value = { ...dshKeyResolved.value, [p.key]: 'missing' }
    return ''
  }
}

async function runProbe(p: PanelProvider) {
  testingId.value = p.key
  delete probeResults.value[p.key]
  const apiKey = isDsh(p) ? await resolveDshKey(p) : p.apiKey
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
    // dsh 供应商：有凭据就实时拉取接口（对齐 cc-switch 的 model-fetch 逻辑），
    // 失败或无凭据时回退到配置里声明的静态模型。
    const apiKey = isDsh(p) ? await resolveDshKey(p) : p.apiKey
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
      // dsh 没找到凭据时看配置里有没有静态模型。
      if (p.staticModels.length) {
        modelResults.value[p.key] = p.staticModels
        modelsExpanded.value = { ...modelsExpanded.value, [p.key]: true }
        return
      }
      modelErrors.value[p.key] = 'config.toml 未配置 API Key，且没有静态模型列表'
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
  if (isDsh(p)) {
    const state = dshKeyResolved.value[p.key]
    if (state === 'missing') return 'config.toml 未配置 API Key'
    if (state !== 'ok') return '测试时从 dsh 配置读取'
  }
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

function kindLabel(kind: ChannelProviderKind): string {
  return KIND_FILTERS.find((item) => item.id === kind)?.label ?? kind
}

const hasAnySource = computed(
  () => ccProviders.value.length > 0 || dshProviders.value.length > 0,
)

// ===== dsh 全局默认模型设置（唯一权威；dsh-tui 启动路由由后端自动同步）=====

const defaultEditorOpen = ref(false)
const defaultEditorProvider = ref('')
const defaultEditorModel = ref('')
const defaultEditorSaving = ref(false)
const defaultEditorError = ref('')

/** 从 dsh 供应商卡片进入：固定该供应商，选模型后设为全局默认。 */
function openSetDefaultForProvider(p: PanelProvider) {
  defaultEditorProvider.value = p.sourceId
  defaultEditorModel.value =
    (dshDefault.value?.provider === p.sourceId ? dshDefault.value.model : '') ||
    p.staticModels[0]?.id ||
    ''
  defaultEditorError.value = ''
  defaultEditorOpen.value = true
}

function closeDefaultEditor() {
  defaultEditorOpen.value = false
  defaultEditorError.value = ''
}

function defaultEditorProviderModels(): DshProviderModelInput[] {
  const provider = dshProviders.value.find((item) => item.id === defaultEditorProvider.value)
  if (!provider) return []
  const models = provider.models.map((model) => ({ id: model.id, name: model.name || undefined }))
  const knownIds = new Set(models.map((model) => model.id))
  for (const model of modelResults.value[`dsh-${provider.id}`] ?? []) {
    const id = model.id.trim()
    if (id && !knownIds.has(id)) {
      knownIds.add(id)
      models.push({ id, name: undefined })
    }
  }
  const activeModel = dshDefault.value
  if (activeModel?.provider === provider.id && !knownIds.has(activeModel.model)) {
    models.push({ id: activeModel.model, name: undefined })
  }
  return models
}

/** 设为全局默认：写 config.toml 的 active_provider/active_model；后端同时同步
 * dsh-tui 启动分组路由，重启 dsh 立即生效。 */
async function saveGlobalDefault() {
  if (!defaultEditorProvider.value || !defaultEditorModel.value) {
    defaultEditorError.value = '请选择模型'
    return
  }
  defaultEditorSaving.value = true
  defaultEditorError.value = ''
  try {
    await backend.setDshDefaultModel(defaultEditorProvider.value, defaultEditorModel.value)
    const [defaultModel, profiles] = await Promise.all([
      backend.getDshDefaultModel(),
      backend.listDshProfiles(),
    ])
    dshDefault.value = defaultModel
    dshProfiles.value = profiles
    closeDefaultEditor()
  } catch (error) {
    defaultEditorError.value = error instanceof Error ? error.message : String(error)
  } finally {
    defaultEditorSaving.value = false
  }
}

/** 接口的 owned_by / 已保存的 name 经常是供应商名（opencode、openai），不能当模型显示名。 */
function isProviderBrandName(name: string | undefined, modelId: string, providerHint: string): boolean {
  const value = name?.trim()
  if (!value) return true
  if (value === modelId) return true
  const lower = value.toLowerCase()
  const hints = [providerHint, dshDraft.value.displayName, dshDraft.value.id]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (hints.some((hint) => lower === hint)) return true
  return [
    'opencode',
    'openai',
    'anthropic',
    'google',
    'xai',
    'grok',
    'deepseek',
    'custom',
    'system',
  ].includes(lower)
}

function fetchedModelDisplayName(model: FetchedModel): string | undefined {
  const label = model.ownedBy?.trim()
  if (!label) return undefined
  if (isProviderBrandName(label, model.id, dshDraft.value.displayName || dshDraft.value.id)) {
    return undefined
  }
  return label
}

function cleanedModelName(
  name: string | undefined,
  modelId: string,
  providerHint: string,
): string | undefined {
  if (isProviderBrandName(name, modelId, providerHint)) return undefined
  return name?.trim() || undefined
}

/** 用接口拉到的模型填表：以本次拉取的 id 为准，保留已填的上下文；不把供应商名写入显示名。 */
function mergeFetchedModelsIntoEditor(models: FetchedModel[]) {
  const previous = new Map(
    editorModels.value
      .filter((model) => model.id.trim())
      .map((model) => [model.id.trim(), model]),
  )
  const providerHint = dshDraft.value.displayName || dshDraft.value.id
  editorModels.value = models.map((model) => {
    const existing = previous.get(model.id)
    return {
      id: model.id,
      name:
        cleanedModelName(existing?.name, model.id, providerHint) ?? fetchedModelDisplayName(model),
      contextWindow: existing?.contextWindow,
    }
  })
}

// ===== dsh 供应商管理（新增 / 编辑 / 删除；格式与 dsh 原配置一致）=====

const editorOpen = ref(false)
const editingDshId = ref<string | null>(null)
const editorSaving = ref(false)
const editorFetching = ref(false)
const editorError = ref('')
const editorModels = ref<DshProviderModelInput[]>([])

function emptyDshDraft() {
  return {
    id: '',
    displayName: '',
    api: 'openai-responses',
    baseUrl: '',
    apiKey: '',
  }
}
const dshDraft = ref(emptyDshDraft())

function openAddDshProvider() {
  editingDshId.value = null
  dshDraft.value = emptyDshDraft()
  editorModels.value = []
  editorError.value = ''
  editorOpen.value = true
}

function openEditDshProvider(p: PanelProvider) {
  const provider = dshProviders.value.find((item) => item.id === p.sourceId)
  if (!provider) return
  editingDshId.value = provider.id
  dshDraft.value = {
    id: provider.id,
    displayName: provider.name === provider.id ? '' : provider.name,
    api: provider.api || 'openai-responses',
    baseUrl: provider.baseUrl,
    apiKey: '',
  }
  editorModels.value = provider.models.map((model) => ({
    id: model.id,
    name: cleanedModelName(model.name, model.id, provider.name || provider.id),
  }))
  editorError.value = ''
  editorOpen.value = true
}

function closeEditor() {
  editorOpen.value = false
  editingDshId.value = null
  editorError.value = ''
  editorModels.value = []
}

function addModelRow() {
  editorModels.value = [...editorModels.value, { id: '', name: undefined }]
}

function removeModelRow(index: number) {
  editorModels.value = editorModels.value.filter((_, item) => item !== index)
}

function updateModelRow(index: number, patch: Partial<DshProviderModelInput>) {
  editorModels.value = editorModels.value.map((model, item) =>
    item === index ? { ...model, ...patch } : model,
  )
}

/** 编辑表单里用当前 baseURL / apiKey 实时拉取模型列表，合并进模型表。 */
async function fetchModelsIntoEditor() {
  const baseUrl = dshDraft.value.baseUrl.trim()
  if (!baseUrl) {
    editorError.value = '请先填写接口地址，再获取模型列表'
    return
  }
  editorFetching.value = true
  editorError.value = ''
  try {
    let apiKey = dshDraft.value.apiKey.trim()
    if (!apiKey && editingDshId.value) {
      apiKey = (await backend.getDshProviderApiKey(editingDshId.value)) ?? ''
    }
    if (!apiKey) {
      editorError.value = '未找到 API Key，请先在表单里填写（会写入 ~/.dsh/config.toml）'
      return
    }
    const channel: ChannelConfig = {
      id: 'dsh-editor',
      name: dshDraft.value.displayName || dshDraft.value.id,
      provider: 'dsh',
      websiteUrl: '',
      baseUrl,
      apiKey,
      model: '',
      apiFormat: dshApiFormat(dshDraft.value.api),
      apiKeyAuth: dshApiKeyAuth(dshDraft.value.api),
    }
    const models = await backend.fetchChannelModels(channel)
    if (!models.length) {
      editorError.value = '接口没有返回任何模型'
      return
    }
    mergeFetchedModelsIntoEditor(models)
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : String(error)
  } finally {
    editorFetching.value = false
  }
}

async function saveDshProvider() {
  const id = dshDraft.value.id.trim()
  if (!id) {
    editorError.value = '供应商 id 不能为空'
    return
  }
  if (!dshDraft.value.baseUrl.trim()) {
    editorError.value = '接口地址（baseURL）不能为空'
    return
  }
  if (!editorModels.value.some((model) => model.id.trim())) {
    editorError.value = '至少添加一个模型'
    return
  }
  editorSaving.value = true
  editorError.value = ''
  const input: DshProviderInput = {
    id,
    displayName: dshDraft.value.displayName.trim() || undefined,
    api: dshDraft.value.api,
    baseUrl: dshDraft.value.baseUrl.trim(),
    apiKey: dshDraft.value.apiKey.trim() || undefined,
    models: editorModels.value
      .map((model) => ({
        id: model.id.trim(),
        name: model.name?.trim() || undefined,
        contextWindow: model.contextWindow,
      }))
      .filter((model) => model.id),
  }
  try {
    let providers: DshProviderInfo[]
    if (editingDshId.value) {
      providers = await backend.updateDshProvider(editingDshId.value, input)
    } else {
      providers = await backend.addDshProvider(input)
    }
    const [defaultModel, profiles] = await Promise.all([
      backend.getDshDefaultModel(),
      backend.listDshProfiles(),
    ])
    dshProviders.value = providers
    dshDefault.value = defaultModel
    dshProfiles.value = profiles
    closeEditor()
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : String(error)
  } finally {
    editorSaving.value = false
  }
}

const profileDeleting = ref(false)
const dshGroupError = ref('')

function isProtectedDshProfile(id: string): boolean {
  return id === 'dsh-tui' || id === 'default'
}

async function removeDshProfile(profile: DshProfileInfo) {
  if (isProtectedDshProfile(profile.id)) return
  if (!window.confirm(`确定删除 DSH 分组「${profile.name}」吗？会删掉 ~/.dsh/profiles/${profile.id}。`)) {
    return
  }
  profileDeleting.value = true
  dshGroupError.value = ''
  try {
    dshProfiles.value = await backend.deleteDshProfile(profile.id)
  } catch (error) {
    dshGroupError.value = error instanceof Error ? error.message : String(error)
  } finally {
    profileDeleting.value = false
  }
}

async function removeDshProvider(p: PanelProvider) {
  if (!window.confirm(`确定删除 dsh 供应商「${p.name}」吗？`)) return
  editorSaving.value = true
  editorError.value = ''
  try {
    dshProviders.value = await backend.deleteDshProvider(p.sourceId)
    if (editingDshId.value === p.sourceId) closeEditor()
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : String(error)
  } finally {
    editorSaving.value = false
  }
}
</script>

<template>
  <section class="channel-panel" aria-label="渠道检测">
    <header class="channel-panel-header">
      <h2>渠道检测</h2>
      <span v-if="loading" class="channel-loading-hint">
        <Loader2 :size="13" class="channel-spin" />
        加载中...
      </span>
      <button
        class="ghost-button"
        type="button"
        title="新增 dsh 供应商（写入 ~/.dsh/config.toml）"
        @click="openAddDshProvider"
      >
        <Plus :size="14" />
        添加 DSH 供应商
      </button>
      <button class="ghost-button" type="button" title="重新加载 cc-switch / dsh 配置" @click="loadAll">
        <RefreshCw :size="14" :class="{ 'channel-spin': loading }" />
        刷新
      </button>
    </header>

    <div class="channel-panel-body">
      <div v-if="ccError" class="channel-source-error">
        读取 cc-switch / dsh 配置失败：{{ ccError }}
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

      <div v-if="groups.length" class="channel-group-row">
        <button
          type="button"
          class="filter-pill group-pill"
          :class="{ active: groupFilter === 'all' }"
          @click="groupFilter = 'all'"
        >
          全部供应商
        </button>
        <span
          v-for="group in groups"
          :key="group.key"
          class="filter-pill group-pill group-pill-wrap"
          :class="{ active: groupFilter === group.key }"
          :title="group.detail"
          @click="groupFilter = group.key"
        >
          {{ group.name }}
          <span v-if="group.badge" class="channel-group-current">{{ group.badge }}</span>
        </span>
      </div>

      <div v-if="dshProfiles.length" class="channel-dsh-group-row" data-testid="dsh-group-row">
        <span class="channel-dsh-group-label">DSH 分组</span>
        <span
          v-for="profile in dshProfiles"
          :key="profile.id"
          class="filter-pill dsh-group-chip"
          :title="`${profile.provider} / ${profile.model}`"
        >
          {{ profile.name }}
          <span v-if="profile.id === 'dsh-tui'" class="channel-group-current">启动</span>
          <button
            v-else-if="!isProtectedDshProfile(profile.id)"
            type="button"
            class="group-config-button channel-danger"
            :disabled="profileDeleting"
            :title="`删除分组 ${profile.name}`"
            @click="removeDshProfile(profile)"
          >
            <Trash2 :size="12" />
          </button>
        </span>
      </div>
      <div v-if="dshGroupError" class="channel-form-error">{{ dshGroupError }}</div>

      <!-- dsh 全局默认模型设置 -->
      <div v-if="defaultEditorOpen" class="channel-form-card dsh-group-editor" data-testid="dsh-default-editor">
        <div class="channel-form-title">
          <strong>设置全局默认模型</strong>
          <button type="button" class="icon-button" title="关闭" @click="closeDefaultEditor">
            <X :size="14" />
          </button>
        </div>
        <div class="channel-form-grid">
          <label>
            供应商
            <select v-model="defaultEditorProvider" data-testid="default-editor-provider">
              <option v-for="provider in dshProviders" :key="provider.id" :value="provider.id">
                {{ provider.name }}
              </option>
            </select>
          </label>
          <label>
            默认模型
            <select v-model="defaultEditorModel" data-testid="default-editor-model">
              <option v-for="model in defaultEditorProviderModels()" :key="model.id" :value="model.id">
                {{ model.id }}
              </option>
            </select>
          </label>
        </div>
        <small class="dsh-group-editor-hint">
          保存后写入 config.toml，并同步 dsh-tui 启动配置。
        </small>
        <div v-if="defaultEditorError" class="channel-form-error">{{ defaultEditorError }}</div>
        <div class="channel-form-actions">
          <button class="primary-button" type="button" :disabled="defaultEditorSaving" @click="saveGlobalDefault">
            {{ defaultEditorSaving ? '保存中...' : '设为全局默认' }}
          </button>
          <button class="ghost-button" type="button" @click="closeDefaultEditor">取消</button>
        </div>
      </div>

      <!-- dsh 供应商编辑表单 -->
      <div v-if="editorOpen" class="channel-form-card dsh-editor" data-testid="dsh-editor">
        <div class="channel-form-title">
          <strong>{{ editingDshId ? '编辑 dsh 供应商' : '添加 dsh 供应商' }}</strong>
          <button type="button" class="icon-button" title="关闭" @click="closeEditor">
            <X :size="14" />
          </button>
        </div>
        <div class="channel-form-grid">
          <label>
            ID（provider 键名，唯一）
            <input v-model="dshDraft.id" placeholder="例如：opencode-go" :disabled="!!editingDshId" />
          </label>
          <label>
            显示名
            <input v-model="dshDraft.displayName" placeholder="例如：OpenCode Go" />
          </label>
          <label>
            API 格式
            <select v-model="dshDraft.api">
              <option v-for="option in DSH_API_OPTIONS" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="channel-form-wide">
            接口地址（baseURL）
            <input v-model="dshDraft.baseUrl" placeholder="https://opencode.ai/zen/go/v1" />
          </label>
          <label class="channel-form-wide">
            API Key
            <input
              v-model="dshDraft.apiKey"
              type="password"
              autocomplete="off"
              :placeholder="editingDshId ? '留空表示保留当前 Key' : '写入 ~/.dsh/config.toml'"
            />
          </label>
        </div>
        <small class="dsh-editor-hint">
          URL、Key、模型和当前路由统一保存在 ~/.dsh/config.toml；不会注册 Windows 环境变量。
        </small>
        <div class="dsh-editor-models">
          <div class="dsh-editor-models-head">
            <strong>模型列表</strong>
            <button
              type="button"
              class="ghost-button small"
              :disabled="editorFetching"
              title="用当前接口地址实时拉取模型列表，拉到的模型自动填入下方列表（对齐 cc-switch 的 model-fetch 逻辑）"
              @click="fetchModelsIntoEditor"
            >
              <Loader2 v-if="editorFetching" :size="13" class="channel-spin" />
              <List v-else :size="13" />
              {{ editorFetching ? '拉取中...' : '获取模型列表' }}
            </button>
          </div>
          <div v-if="editorModels.length" class="dsh-editor-model-rows">
            <div
              v-for="(model, index) in editorModels"
              :key="index"
              class="dsh-editor-model-row"
            >
              <input
                :value="model.id"
                placeholder="模型 id（如 glm-5.3）"
                @input="updateModelRow(index, { id: ($event.target as HTMLInputElement).value })"
              />
              <input
                :value="model.name"
                placeholder="显示名（可选）"
                @input="updateModelRow(index, { name: ($event.target as HTMLInputElement).value })"
              />
              <select
                :value="model.contextWindow ?? ''"
                title="上下文窗口（可选）"
                @change="
                  updateModelRow(index, {
                    contextWindow: ($event.target as HTMLSelectElement).value
                      ? Number(($event.target as HTMLSelectElement).value)
                      : undefined,
                  })
                "
              >
                <option value="">上下文（可选）</option>
                <option :value="256000">256K</option>
                <option :value="500000">500K</option>
                <option :value="1000000">1M</option>
              </select>
              <button
                type="button"
                class="icon-button channel-danger"
                title="删除该模型"
                @click="removeModelRow(index)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
          <div class="dsh-editor-model-actions">
            <button type="button" class="ghost-button small" @click="addModelRow">
              <Plus :size="13" />添加模型行
            </button>
          </div>
          <small class="dsh-editor-hint">
            点「获取模型列表」会用当前接口地址拉取模型 id 并填入（可再手动增删）；
            显示名不会写成供应商名。保存时写入 config.toml，并同步 dsh 所需的兼容路由。
          </small>
        </div>
        <div v-if="editorError" class="channel-form-error">{{ editorError }}</div>
        <div class="channel-form-actions">
          <button class="primary-button" type="button" :disabled="editorSaving" @click="saveDshProvider">
            {{ editorSaving ? '保存中...' : '保存' }}
          </button>
          <button class="ghost-button" type="button" @click="closeEditor">取消</button>
          <button
            v-if="editingDshId"
            class="ghost-button channel-danger"
            type="button"
            :disabled="editorSaving"
            @click="removeDshProvider(providers.find((p) => p.sourceId === editingDshId) as PanelProvider)"
          >
            删除供应商
          </button>
        </div>
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
              <span class="channel-provider-badge" :class="provider.kind">
                <ClaudeIcon v-if="provider.kind === 'claude'" :size="14" />
                <CodexIcon v-else-if="provider.kind === 'codex'" :size="14" />
                <DshIcon v-else-if="provider.kind === 'dsh'" :size="14" />
                <GrokIcon v-else-if="provider.kind === 'grok'" :size="14" />
                <GeminiIcon v-else-if="provider.kind === 'gemini'" :size="14" />
                <OpenCodeIcon v-else :size="14" />
                <span>{{ kindLabel(provider.kind) }}</span>
              </span>
              <strong :title="provider.name">{{ provider.name }}</strong>
              <span v-if="provider.isCurrent" class="channel-current-badge">当前</span>
            </div>
            <div v-if="isDsh(provider)" class="channel-card-actions">
              <button
                type="button"
                class="ghost-button small"
                :title="'编辑 dsh 供应商配置（config.toml）'"
                @click="openEditDshProvider(provider)"
              >
                <Pencil :size="13" />
                编辑
              </button>
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
              <span v-if="!isDsh(provider) && provider.apiKey">
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
            <span
              v-if="provider.badges.length"
              class="channel-meta-row channel-badges-row"
              :title="`所属分组：${provider.badges.join('、')}`"
            >
              <RadioTower :size="13" />分组：{{ provider.badges.join('、') }}
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
              :title="
                isDsh(provider)
                  ? '用配置的 API Key 实时拉取模型列表（失败时显示配置声明的模型）'
                  : '从接口获取模型列表'
              "
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
                  ? isDsh(provider)
                    ? '发送 hi 验证该 dsh 供应商可用性（Key 取自 ~/.dsh/config.toml）'
                    : '发送 hi 验证接口可用性'
                  : '该供应商未配置接口地址，无法做连通测试'
              "
              @click="runProbe(provider)"
            >
              <Loader2 v-if="testingId === provider.key" :size="13" class="channel-spin" />
              <Mail v-else :size="13" />
              {{ testingId === provider.key ? '测试中...' : '连通测试' }}
            </button>
            <button
              v-if="isDsh(provider)"
              type="button"
              class="ghost-button small"
              title="把该供应商+模型设为全局默认（唯一权威，DSH 启动自动跟随）"
              @click="openSetDefaultForProvider(provider)"
            >
              <Settings2 :size="13" />
              设为默认
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
            试试切换上方的分组 / 类型筛选；供应商数据由 cc-switch（Claude / Codex / Grok /
            Gemini / OpenCode）与 ~/.dsh（DSH）提供，在对应工具里新增供应商后点「刷新」即可看到。
          </p>
        </template>
        <template v-else>
          <p>没有找到任何供应商。</p>
          <p class="channel-empty-sub">
            Claude / Codex / Grok / Gemini / OpenCode 供应商来自 cc-switch
            （~/.cc-switch/cc-switch.db），DSH 供应商来自 ~/.dsh/config.toml。请先在
            cc-switch 或 dsh 中配置供应商，然后点「刷新」。DSH 供应商也可以直接点右上角
            「添加 DSH 供应商」新建。
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

.channel-group-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.group-pill {
  border: 1px solid var(--border, #333);
}

.channel-group-current {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.85;
}

.channel-dsh-group-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.channel-dsh-group-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.dsh-group-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--color-border);
}

.channel-current-badge {
  margin-left: 6px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--primary, #4f8cff);
  color: #fff;
  white-space: nowrap;
}

.channel-empty-sub {
  font-size: 12px;
  color: var(--text-secondary, #999);
  max-width: 520px;
}

.dsh-editor-models {
  margin-top: 4px;
}

.dsh-editor-models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 13px;
}

.dsh-editor-model-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.dsh-editor-model-row {
  display: grid;
  grid-template-columns: 1.2fr 1fr 0.9fr auto;
  gap: 6px;
  align-items: center;
}

/* 主题配色：与 .channel-form-grid 的输入框一致（编辑器不在该容器内，需自带）。 */
.dsh-editor-model-row input,
.dsh-editor-model-row select {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-input-bg);
  color: var(--color-text-primary);
  font-size: 12px;
  outline: none;
  width: 100%;
}

.dsh-editor-model-row input:focus,
.dsh-editor-model-row select:focus {
  border-color: var(--surface-accent-blue-border);
}

.dsh-editor-model-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.dsh-editor-hint {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.dsh-group-editor-hint {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.group-pill-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.group-config-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  padding: 2px;
  border-radius: 3px;
  cursor: pointer;
}

.group-config-button:hover {
  opacity: 1;
  background: var(--surface-divider-muted, rgba(128, 128, 128, 0.2));
}

.channel-models-hint {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-secondary, #999);
}
</style>
