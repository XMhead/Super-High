import { createApp, defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ChannelProbePanel from './ChannelProbePanel.vue'
import type { CcProfileInfo, CcProviderInfo, ChannelConfig } from '@/types'

const mocks = vi.hoisted(() => ({
  probeChannel: vi.fn(),
  probeWebsiteLatency: vi.fn(),
  fetchChannelModels: vi.fn(),
  listDshProviders: vi.fn(),
  listDshProfiles: vi.fn(),
  listCcProviders: vi.fn(),
  listCcProfiles: vi.fn(),
  getDshProviderApiKey: vi.fn(),
  getDshDefaultModel: vi.fn(),
  addDshProvider: vi.fn(),
  updateDshProvider: vi.fn(),
  deleteDshProvider: vi.fn(),
  setDshDefaultModel: vi.fn(),
  deleteDshProfile: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    probeChannel: mocks.probeChannel,
    probeWebsiteLatency: mocks.probeWebsiteLatency,
    fetchChannelModels: mocks.fetchChannelModels,
    listDshProviders: mocks.listDshProviders,
    listDshProfiles: mocks.listDshProfiles,
    listCcProviders: mocks.listCcProviders,
    listCcProfiles: mocks.listCcProfiles,
    getDshProviderApiKey: mocks.getDshProviderApiKey,
    getDshDefaultModel: mocks.getDshDefaultModel,
    addDshProvider: mocks.addDshProvider,
    updateDshProvider: mocks.updateDshProvider,
    deleteDshProvider: mocks.deleteDshProvider,
    setDshDefaultModel: mocks.setDshDefaultModel,
    deleteDshProfile: mocks.deleteDshProfile,
  },
  isTauri: mocks.isTauri,
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
  onProjectServiceStatus: vi.fn(),
}))

function claudeProvider(overrides: Partial<CcProviderInfo> = {}): CcProviderInfo {
  return {
    app: 'claude',
    id: 'kiro-1',
    name: 'kiro',
    websiteUrl: 'https://api.aizzz.xyz',
    baseUrl: 'https://api.aizzz.xyz',
    apiKey: 'sk-kiro-key-1234567890',
    apiFormat: 'anthropic',
    apiKeyAuth: 'x-api-key',
    model: 'claude-opus-5[1M]',
    models: [],
    category: 'custom',
    isCurrent: true,
    ...overrides,
  }
}

function codexProvider(overrides: Partial<CcProviderInfo> = {}): CcProviderInfo {
  return {
    app: 'codex',
    id: '001-1',
    name: '0.01',
    websiteUrl: 'https://api.aizzz.xyz',
    baseUrl: 'https://api.aizzz.xyz/v1',
    apiKey: 'sk-codex-key-12345',
    apiFormat: 'openai_responses',
    apiKeyAuth: 'bearer',
    model: 'gpt-5.6-sol',
    models: [],
    category: 'custom',
    isCurrent: true,
    ...overrides,
  }
}

function geminiProvider(overrides: Partial<CcProviderInfo> = {}): CcProviderInfo {
  return {
    app: 'gemini',
    id: 'g1',
    name: 'Gemini转发',
    websiteUrl: 'https://api.miaocg.cn',
    baseUrl: 'https://api.miaocg.cn',
    apiKey: 'sk-gem-key-1',
    apiFormat: 'gemini_native',
    apiKeyAuth: 'x-goog-api-key',
    model: 'gemini-3.5-flash',
    models: [],
    category: 'custom',
    isCurrent: false,
    ...overrides,
  }
}

function grokProvider(overrides: Partial<CcProviderInfo> = {}): CcProviderInfo {
  return {
    app: 'grokbuild',
    id: 'gr1',
    name: 'grok',
    websiteUrl: 'https://api.aizzz.xyz',
    baseUrl: 'https://api.aizzz.xyz/v1',
    apiKey: 'sk-grok-key-1',
    apiFormat: 'openai_responses',
    apiKeyAuth: 'bearer',
    model: 'grok-4.6',
    models: [],
    category: 'custom',
    isCurrent: true,
    ...overrides,
  }
}

function opencodeProvider(overrides: Partial<CcProviderInfo> = {}): CcProviderInfo {
  return {
    app: 'opencode',
    id: 'oc1',
    name: 'OpenCode Go',
    websiteUrl: 'https://opencode.ai/go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'sk-oc-key-1',
    apiFormat: 'openai_chat',
    apiKeyAuth: 'bearer',
    model: '',
    models: [
      { id: 'glm-5.3', name: 'glm-5.3' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
    category: 'third_party',
    isCurrent: false,
    ...overrides,
  }
}

const DEFAULT_PROFILES: CcProfileInfo[] = [
  {
    id: 'proj-a',
    name: '项目A',
    claudeProvider: 'kiro-1',
    codexProvider: '001-1',
  },
]

function mountPanel() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(ChannelProbePanel) }))
  app.mount(root)
  return { app, root }
}

async function flush() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function clickByText(root: HTMLElement, text: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(text),
  )
  expect(button, `button containing "${text}"`).toBeDefined()
  button!.click()
}

function clickGroupByText(root: HTMLElement, text: string) {
  const group = [...root.querySelectorAll<HTMLElement>('.group-pill-wrap')].find((item) =>
    item.textContent?.includes(text),
  )
  expect(group, `group chip containing "${text}"`).toBeDefined()
  group!.click()
}

function inputByPlaceholder(root: HTMLElement, placeholder: string) {
  const input = [...root.querySelectorAll<HTMLInputElement>('input')].find(
    (item) => item.placeholder === placeholder,
  )
  expect(input, `input with placeholder "${placeholder}"`).toBeDefined()
  return input!
}

describe('ChannelProbePanel', () => {
  beforeEach(() => {
    mocks.probeChannel.mockReset()
    mocks.probeWebsiteLatency.mockReset()
    mocks.fetchChannelModels.mockReset()
    mocks.listDshProviders.mockReset()
    mocks.listDshProfiles.mockReset()
    mocks.listCcProviders.mockReset()
    mocks.listCcProfiles.mockReset()
    mocks.getDshProviderApiKey.mockReset()
    mocks.getDshDefaultModel.mockReset()
    mocks.addDshProvider.mockReset()
    mocks.updateDshProvider.mockReset()
    mocks.deleteDshProvider.mockReset()
    mocks.setDshDefaultModel.mockReset()
    mocks.deleteDshProfile.mockReset()
    mocks.isTauri.mockReturnValue(true)

    mocks.listCcProviders.mockResolvedValue([
      claudeProvider(),
      codexProvider(),
      geminiProvider(),
      grokProvider(),
      opencodeProvider(),
    ])
    mocks.listCcProfiles.mockResolvedValue({
      profiles: DEFAULT_PROFILES,
      currentClaude: 'proj-a',
      currentCodex: null,
    })
    mocks.listDshProfiles.mockResolvedValue([
      {
        id: 'dsh-tui',
        name: 'dsh-tui',
        provider: 'grok',
        model: 'grok-4.6',
        modelSource: 'profile-patch',
      },
      {
        id: 'headless',
        name: 'headless',
        provider: 'grok',
        model: 'grok-4.6',
        modelSource: 'settings-default',
      },
    ])
    mocks.deleteDshProfile.mockResolvedValue([
      {
        id: 'dsh-tui',
        name: 'dsh-tui',
        provider: 'grok',
        model: 'grok-4.6',
        modelSource: 'profile-patch',
      },
    ])
    mocks.listDshProviders.mockResolvedValue([
      {
        id: 'grok',
        name: 'Grok',
        baseUrl: 'https://api.aizzz.xyz/v1',
        api: 'openai-responses',
        apiKeyEnv: 'GROK_API_KEY',
        models: [
          { id: 'grok-4.6', name: 'Grok 4.6' },
          { id: 'grok-4.5', name: 'Grok 4.5' },
        ],
      },
    ])
    // 全局默认 = grok（唯一权威；只有它显示「当前」）。
    mocks.getDshDefaultModel.mockResolvedValue({ provider: 'grok', model: 'grok-4.6' })
    mocks.getDshProviderApiKey.mockResolvedValue('sk-grok-1')

    mocks.addDshProvider.mockResolvedValue([
      {
        id: 'new-provider',
        name: '新供应商',
        baseUrl: 'https://new.example/v1',
        api: 'openai-responses',
        apiKeyEnv: 'NEW_KEY',
        models: [{ id: 'new-1', name: 'New 1' }],
      },
    ])
    mocks.updateDshProvider.mockResolvedValue([])
    mocks.deleteDshProvider.mockResolvedValue([])

    mocks.probeChannel.mockResolvedValue({
      ok: true,
      latencyMs: 123,
      endpoint: 'https://api.aizzz.xyz/v1/messages',
      reply: '我是 Claude。',
      error: '',
      status: 200,
    })
    mocks.probeWebsiteLatency.mockResolvedValue([
      { url: 'https://api.aizzz.xyz', label: '官网链接', latencyMs: 88, status: 200, error: null },
      { url: 'https://api.aizzz.xyz', label: '接口地址', latencyMs: 95, status: 200, error: null },
    ])
    mocks.fetchChannelModels.mockResolvedValue([
      { id: 'claude-opus-5', ownedBy: 'anthropic' },
      { id: 'gpt-5.6-sol', ownedBy: 'openai' },
    ])
  })

  it('loads cc-switch providers, profiles and dsh providers on mount and renders cards', async () => {
    const { app, root } = mountPanel()
    await flush()

    expect(mocks.listCcProviders).toHaveBeenCalledTimes(1)
    expect(mocks.listCcProfiles).toHaveBeenCalledTimes(1)
    expect(mocks.listDshProviders).toHaveBeenCalledTimes(1)
    expect(mocks.listDshProfiles).toHaveBeenCalledTimes(1)
    expect(mocks.getDshDefaultModel).toHaveBeenCalledTimes(1)

    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-gemini-g1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-grokbuild-gr1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-opencode-oc1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-dsh-grok"]')).not.toBeNull()
    app.unmount()
  })

  it('renders brand icons for every channel kind', async () => {
    const { app, root } = mountPanel()
    await flush()

    expect(root.querySelector('[aria-label="Claude"]')).not.toBeNull()
    expect(root.querySelector('[aria-label="DSH"]')).not.toBeNull()
    expect(root.querySelector('[aria-label="Grok"]')).not.toBeNull()
    expect(root.querySelector('[aria-label="Gemini"]')).not.toBeNull()
    expect(root.querySelector('[aria-label="OpenCode"]')).not.toBeNull()
    app.unmount()
  })

  it('renders group chips from cc-switch project groups only', async () => {
    const { app, root } = mountPanel()
    await flush()

    const pills = [...root.querySelectorAll<HTMLButtonElement>('.group-pill')].map((item) =>
      item.textContent?.trim(),
    )
    expect(pills.some((pill) => pill?.includes('项目A'))).toBe(true)
    expect(pills.some((pill) => pill?.includes('dsh-tui'))).toBe(false)
    app.unmount()
  })

  it('lists dsh groups and can delete unused ones', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { app, root } = mountPanel()
    await flush()

    const row = root.querySelector('[data-testid="dsh-group-row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('dsh-tui')
    expect(row.textContent).toContain('启动')
    expect(row.textContent).toContain('headless')

    const chips = [...row.querySelectorAll<HTMLElement>('.dsh-group-chip')]
    const startup = chips.find((chip) => chip.textContent?.includes('dsh-tui'))
    const unused = chips.find((chip) => chip.textContent?.includes('headless'))
    expect(startup?.querySelector('button')).toBeNull()
    expect(unused?.querySelector('button')).not.toBeNull()

    unused!.querySelector('button')!.click()
    await flush()
    expect(mocks.deleteDshProfile).toHaveBeenCalledWith('headless')
    expect(root.textContent).not.toContain('headless')
    confirm.mockRestore()
    app.unmount()
  })

  it('does not show the empty-group hint when there are no cc-switch groups', async () => {
    mocks.listCcProfiles.mockResolvedValue({
      profiles: [],
      currentClaude: null,
      currentCodex: null,
    })
    const { app, root } = mountPanel()
    await flush()
    expect(root.textContent).not.toContain('未发现分组')
    expect(root.querySelector('[data-testid="dsh-group-row"]')).not.toBeNull()
    app.unmount()
  })

  it('filters by kind', async () => {
    const { app, root } = mountPanel()
    await flush()

    clickByText(root, 'Codex CLI')
    await nextTick()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).toBeNull()
    expect(root.querySelector('[data-testid="channel-card-dsh-grok"]')).toBeNull()

    clickByText(root, 'Gemini')
    await nextTick()
    expect(root.querySelector('[data-testid="channel-card-cc-gemini-g1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).toBeNull()
    app.unmount()
  })

  it('filters by cc-switch project group to its bound providers', async () => {
    const { app, root } = mountPanel()
    await flush()

    clickGroupByText(root, '项目A')
    await nextTick()
    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-dsh-grok"]')).toBeNull()
    app.unmount()
  })

  it('shows provider stats and group badges on cards', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]') as HTMLElement
    expect(card.textContent).toContain('官网：https://api.aizzz.xyz')
    expect(card.textContent).toContain('接口：https://api.aizzz.xyz')
    expect(card.textContent).toContain('分组：项目A')
    // 展示保留配置里的上下文标记，测试请求时后端会剥离 [1M]。
    expect(card.textContent).toContain('claude-opus-5[1M]')
    app.unmount()
  })

  it('runs website latency test and shows results', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]') as HTMLElement
    clickByText(card, '测延迟')
    await flush()

    expect(mocks.probeWebsiteLatency).toHaveBeenCalledTimes(1)
    const channel = mocks.probeWebsiteLatency.mock.calls[0][0] as ChannelConfig
    expect(channel.provider).toBe('claude')
    expect(channel.baseUrl).toBe('https://api.aizzz.xyz')
    expect(channel.model).toBe('claude-opus-5[1M]')

    const result = root.querySelector(
      '[data-testid="channel-latency-result-cc-claude-kiro-1"]',
    ) as HTMLElement
    expect(result).not.toBeNull()
    expect(result.textContent).toContain('官网链接')
    expect(result.textContent).toContain('88 ms')
    app.unmount()
  })

  it('probes cc provider with its configured key and format', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-codex-001-1"]') as HTMLElement
    clickByText(card, '连通测试')
    await flush()

    expect(mocks.probeChannel).toHaveBeenCalledTimes(1)
    const channel = mocks.probeChannel.mock.calls[0][0] as ChannelConfig
    expect(channel.provider).toBe('codex')
    expect(channel.apiKey).toBe('sk-codex-key-12345')
    expect(channel.apiFormat).toBe('openai_responses')
    expect(channel.apiKeyAuth).toBe('bearer')
    expect(channel.model).toBe('gpt-5.6-sol')
    app.unmount()
  })

  it('probes gemini provider with native generateContent format', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-gemini-g1"]') as HTMLElement
    clickByText(card, '连通测试')
    await flush()

    const channel = mocks.probeChannel.mock.calls[0][0] as ChannelConfig
    expect(channel.provider).toBe('gemini')
    expect(channel.apiFormat).toBe('gemini_native')
    expect(channel.apiKeyAuth).toBe('x-goog-api-key')
    expect(channel.model).toBe('gemini-3.5-flash')
    app.unmount()
  })

  it('resolves dsh api key from credentials before probing', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    clickByText(card, '连通测试')
    await flush()

    expect(mocks.getDshProviderApiKey).toHaveBeenCalledWith('grok')
    expect(mocks.probeChannel).toHaveBeenCalledTimes(1)
    const channel = mocks.probeChannel.mock.calls[0][0] as ChannelConfig
    expect(channel.apiKey).toBe('sk-grok-1')
    expect(channel.apiFormat).toBe('openai_responses')
    expect(channel.apiKeyAuth).toBe('bearer')
    app.unmount()
  })

  it('fetches dsh models in real time with the configured key', async () => {
    mocks.fetchChannelModels.mockResolvedValue([
      { id: 'grok-5.0', ownedBy: '实时模型' },
      { id: 'grok-4.6', ownedBy: 'Grok 4.6' },
    ])
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()

    // dsh 供应商有凭据时走实时拉取（cc-switch 的 model-fetch 逻辑），不再只列静态配置。
    expect(mocks.fetchChannelModels).toHaveBeenCalledTimes(1)
    const channel = mocks.fetchChannelModels.mock.calls[0][0] as ChannelConfig
    expect(channel.provider).toBe('dsh')
    expect(channel.apiKey).toBe('sk-grok-1')
    expect(channel.baseUrl).toBe('https://api.aizzz.xyz/v1')

    const result = root.querySelector('[data-testid="channel-models-result-dsh-grok"]') as HTMLElement
    expect(result).not.toBeNull()
    expect(result.textContent).toContain('grok-5.0')
    app.unmount()
  })

  it('offers freshly fetched dsh models in the default model picker', async () => {
    mocks.fetchChannelModels.mockResolvedValue([
      { id: 'gpt-5.6-sol', ownedBy: 'openai' },
      { id: 'grok-4.6', ownedBy: 'Grok 4.6' },
    ])
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()
    clickByText(card, '设为默认')
    await nextTick()

    const modelSelect = root.querySelector(
      '[data-testid="default-editor-model"]',
    ) as HTMLSelectElement
    expect([...modelSelect.options].map((option) => option.value)).toContain('gpt-5.6-sol')
    modelSelect.value = 'gpt-5.6-sol'
    modelSelect.dispatchEvent(new Event('change'))
    await nextTick()
    clickByText(root, '设为全局默认')
    await flush()

    expect(mocks.setDshDefaultModel).toHaveBeenCalledWith('grok', 'gpt-5.6-sol')
    app.unmount()
  })

  it('falls back to static dsh models when the fetch fails', async () => {
    mocks.fetchChannelModels.mockRejectedValue(new Error('HTTP 404'))
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()

    const result = root.querySelector('[data-testid="channel-models-result-dsh-grok"]') as HTMLElement
    expect(result).not.toBeNull()
    expect(result.textContent).toContain('grok-4.6')
    app.unmount()
  })

  it('reports missing key for dsh providers without credentials and static models', async () => {
    mocks.getDshProviderApiKey.mockResolvedValue(null)
    mocks.listDshProviders.mockResolvedValue([
      {
        id: 'opencode-go',
        name: 'opencode-go',
        baseUrl: '',
        api: 'openai-completions',
        apiKeyEnv: 'OPENCODE_GO_API_KEY',
        models: [],
      },
    ])
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-opencode-go"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()

    const error = root.querySelector(
      '[data-testid="channel-models-error-dsh-opencode-go"]',
    ) as HTMLElement
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('config.toml 未配置 API Key')
    app.unmount()
  })

  it('fetches models for cc provider from its endpoint', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()

    expect(mocks.fetchChannelModels).toHaveBeenCalledTimes(1)
    const channel = mocks.fetchChannelModels.mock.calls[0][0] as ChannelConfig
    expect(channel.apiKey).toBe('sk-kiro-key-1234567890')

    const result = root.querySelector(
      '[data-testid="channel-models-result-cc-claude-kiro-1"]',
    ) as HTMLElement
    expect(result.textContent).toContain('claude-opus-5')
    app.unmount()
  })

  it('lists opencode static models when the live fetch fails', async () => {
    mocks.fetchChannelModels.mockRejectedValue(new Error('网关不支持 /v1/models'))
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-opencode-oc1"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()

    const result = root.querySelector(
      '[data-testid="channel-models-result-cc-opencode-oc1"]',
    ) as HTMLElement
    expect(result).not.toBeNull()
    expect(result.textContent).toContain('glm-5.3')
    expect(result.textContent).toContain('deepseek-v4-pro')
    app.unmount()
  })

  it('shows empty state when no providers are configured', async () => {
    mocks.listCcProviders.mockResolvedValue([])
    mocks.listDshProviders.mockResolvedValue([])
    const { app, root } = mountPanel()
    await flush()

    expect(root.textContent).toContain('没有找到任何供应商')
    expect(root.textContent).toContain('cc-switch')
    app.unmount()
  })

  it('adds a dsh provider through the editor form', async () => {
    const { app, root } = mountPanel()
    await flush()

    clickByText(root, '添加 DSH 供应商')
    await nextTick()
    expect(root.querySelector('[data-testid="dsh-editor"]')).not.toBeNull()

    const idInput = inputByPlaceholder(root, '例如：opencode-go')
    idInput.value = 'opencode-go'
    idInput.dispatchEvent(new Event('input'))
    const baseInput = inputByPlaceholder(root, 'https://opencode.ai/zen/go/v1')
    baseInput.value = 'https://opencode.ai/zen/go/v1'
    baseInput.dispatchEvent(new Event('input'))
    await nextTick()

    // 表单校验：没有模型时拒绝保存。
    clickByText(root, '保存')
    await flush()
    expect(mocks.addDshProvider).not.toHaveBeenCalled()

    clickByText(root, '添加模型行')
    await nextTick()
    const modelInputs = [...root.querySelectorAll<HTMLInputElement>('.dsh-editor-model-row input')]
    modelInputs[0].value = 'new-1'
    modelInputs[0].dispatchEvent(new Event('input'))
    await nextTick()

    clickByText(root, '保存')
    await flush()

    expect(mocks.addDshProvider).toHaveBeenCalledTimes(1)
    const input = mocks.addDshProvider.mock.calls[0][0]
    expect(input.id).toBe('opencode-go')
    expect(input.baseUrl).toBe('https://opencode.ai/zen/go/v1')
    expect(input.apiKeyEnv).toBeUndefined()
    expect(input.models).toEqual([{ id: 'new-1', name: undefined, contextWindow: undefined }])
    expect(mocks.getDshDefaultModel).toHaveBeenCalledTimes(2)
    expect(mocks.listDshProfiles).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('clears provider-brand model names when opening the editor', async () => {
    mocks.listDshProviders.mockResolvedValue([
      {
        id: 'opencode-go',
        name: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        api: 'openai-responses',
        apiKeyEnv: 'OPENCODE_GO_API_KEY',
        models: [
          { id: 'deepseek-v4-flash', name: 'opencode' },
          { id: 'glm-5', name: 'opencode' },
        ],
      },
    ])
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-opencode-go"]') as HTMLElement
    clickByText(card, '编辑')
    await nextTick()

    const rows = [...root.querySelectorAll('.dsh-editor-model-row')]
    expect(rows).toHaveLength(2)
    const names = rows.map(
      (row) => row.querySelectorAll<HTMLInputElement>('input')[1]?.value ?? '',
    )
    expect(names).toEqual(['', ''])
    app.unmount()
  })

  it('fills editor model ids from fetch and skips supplier owned_by names', async () => {
    mocks.fetchChannelModels.mockResolvedValue([
      { id: 'deepseek-v4-flash', ownedBy: 'opencode' },
      { id: 'glm-5.3', ownedBy: 'opencode' },
      { id: 'grok-4.6', ownedBy: 'Grok 4.6' },
    ])
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    clickByText(card, '编辑')
    await nextTick()
    clickByText(root, '获取模型列表')
    await flush()

    const rows = [...root.querySelectorAll('.dsh-editor-model-row')]
    expect(rows).toHaveLength(3)
    const values = rows.map((row) => {
      const inputs = row.querySelectorAll<HTMLInputElement>('input')
      return { id: inputs[0]?.value, name: inputs[1]?.value }
    })
    expect(values).toEqual([
      { id: 'deepseek-v4-flash', name: '' },
      { id: 'glm-5.3', name: '' },
      { id: 'grok-4.6', name: 'Grok 4.6' },
    ])
    app.unmount()
  })

  it('selects a model chip and probes with it', async () => {
    mocks.fetchChannelModels.mockResolvedValue([
      { id: 'claude-opus-5', ownedBy: 'anthropic' },
      { id: 'claude-sonnet-5', ownedBy: 'anthropic' },
    ])
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]') as HTMLElement
    clickByText(card, '获取模型')
    await flush()

    const chips = [...card.querySelectorAll<HTMLButtonElement>('.channel-model-chip')]
    const sonnet = chips.find((chip) => chip.textContent?.includes('claude-sonnet-5'))
    expect(sonnet).toBeDefined()
    sonnet!.click()
    await nextTick()
    expect(sonnet!.classList.contains('selected')).toBe(true)

    clickByText(card, '连通测试')
    await flush()
    const channel = mocks.probeChannel.mock.calls[0][0] as ChannelConfig
    expect(channel.model).toBe('claude-sonnet-5')
    app.unmount()
  })

  it('marks only the global default dsh provider as current', async () => {
    // 全局默认 = grok；terra 不在列表里，itai 也不是默认。
    mocks.listDshProviders.mockResolvedValue([
      {
        id: 'grok',
        name: 'Grok',
        baseUrl: 'https://api.aizzz.xyz/v1',
        api: 'openai-responses',
        apiKeyEnv: 'GROK_API_KEY',
        models: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
      },
      {
        id: 'itai',
        name: 'itai',
        baseUrl: 'https://xinapi.itaiapi.com',
        api: 'openai-responses',
        apiKeyEnv: 'itai',
        models: [{ id: 'gpt-5.6-terra', name: 'gpt-5.6-terra' }],
      },
    ])
    const { app, root } = mountPanel()
    await flush()

    const grokCard = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    const itaiCard = root.querySelector('[data-testid="channel-card-dsh-itai"]') as HTMLElement
    expect(grokCard.textContent).toContain('当前')
    expect(itaiCard.textContent).not.toContain('当前')
    app.unmount()
  })

  it('sets the global default model from the provider card', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-grok"]') as HTMLElement
    clickByText(card, '设为默认')
    await nextTick()
    expect(root.querySelector('[data-testid="dsh-default-editor"]')).not.toBeNull()

    // 从卡片进入时预选：供应商 = grok，模型 = 当前全局默认模型 grok-4.6。
    const providerSelect = root.querySelector(
      '[data-testid="default-editor-provider"]',
    ) as HTMLSelectElement
    expect(providerSelect.value).toBe('grok')
    const modelSelect = root.querySelector(
      '[data-testid="default-editor-model"]',
    ) as HTMLSelectElement
    expect(modelSelect.value).toBe('grok-4.6')

    // 换成 grok-4.5 并保存。
    modelSelect.value = 'grok-4.5'
    modelSelect.dispatchEvent(new Event('change'))
    await nextTick()
    clickByText(root, '设为全局默认')
    await flush()

    expect(mocks.setDshDefaultModel).toHaveBeenCalledWith('grok', 'grok-4.5')
    // 保存后重新读取全局默认和 dsh-tui 分组路由。
    expect(mocks.getDshDefaultModel).toHaveBeenCalledTimes(2)
    expect(mocks.listDshProfiles).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('shows the first configured dsh model for non-default providers', async () => {
    mocks.listDshProviders.mockResolvedValue([
      {
        id: 'itai',
        name: 'itai',
        baseUrl: 'https://xinapi.itaiapi.com',
        api: 'openai-responses',
        apiKeyEnv: 'itai',
        models: [{ id: 'gpt-5.6-terra', name: 'gpt-5.6-terra' }],
      },
    ])
    // 全局默认不是 itai。
    mocks.getDshDefaultModel.mockResolvedValue({ provider: 'grok', model: 'grok-4.6' })
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-dsh-itai"]') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('gpt-5.6-terra')
    expect(card.textContent).not.toContain('模型：grok-4.6')
    app.unmount()
  })

  it('refresh button reloads all sources', async () => {
    const { app, root } = mountPanel()
    await flush()
    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).not.toBeNull()

    mocks.listCcProviders.mockResolvedValue([
      claudeProvider({
        id: 'new-1',
        name: '新供应商',
        websiteUrl: 'https://new.example',
        baseUrl: 'https://new.example',
        isCurrent: false,
      }),
    ])
    clickByText(root, '刷新')
    await flush()

    expect(mocks.listCcProviders).toHaveBeenCalledTimes(2)
    expect(root.querySelector('[data-testid="channel-card-cc-claude-new-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).toBeNull()
    app.unmount()
  })
})
