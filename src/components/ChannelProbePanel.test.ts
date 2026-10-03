import { createApp, defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ChannelProbePanel from './ChannelProbePanel.vue'
import type { CcProviderInfo, ChannelConfig } from '@/types'

const mocks = vi.hoisted(() => ({
  probeChannel: vi.fn(),
  probeWebsiteLatency: vi.fn(),
  fetchChannelModels: vi.fn(),
  listCcProviders: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    probeChannel: mocks.probeChannel,
    probeWebsiteLatency: mocks.probeWebsiteLatency,
    fetchChannelModels: mocks.fetchChannelModels,
    listCcProviders: mocks.listCcProviders,
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

describe('ChannelProbePanel', () => {
  beforeEach(() => {
    mocks.probeChannel.mockReset()
    mocks.probeWebsiteLatency.mockReset()
    mocks.fetchChannelModels.mockReset()
    mocks.listCcProviders.mockReset()
    mocks.isTauri.mockReturnValue(true)

    mocks.listCcProviders.mockResolvedValue([
      claudeProvider(),
      codexProvider(),
      geminiProvider(),
      grokProvider(),
      opencodeProvider(),
    ])
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

  it('loads cc-switch providers on mount and renders cards', async () => {
    const { app, root } = mountPanel()
    await flush()

    expect(mocks.listCcProviders).toHaveBeenCalledTimes(1)

    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-gemini-g1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-grokbuild-gr1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-opencode-oc1"]')).not.toBeNull()
    app.unmount()
  })

  it('filters by kind', async () => {
    const { app, root } = mountPanel()
    await flush()

    clickByText(root, 'Codex CLI')
    await nextTick()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]')).toBeNull()

    clickByText(root, 'Gemini')
    await nextTick()
    expect(root.querySelector('[data-testid="channel-card-cc-gemini-g1"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="channel-card-cc-codex-001-1"]')).toBeNull()
    app.unmount()
  })

  it('shows provider details without repeated classification or current badges', async () => {
    const { app, root } = mountPanel()
    await flush()

    const card = root.querySelector('[data-testid="channel-card-cc-claude-kiro-1"]') as HTMLElement
    expect(card.textContent).toContain('官网：https://api.aizzz.xyz')
    expect(card.textContent).toContain('接口：https://api.aizzz.xyz')
    expect(card.textContent).not.toContain('分组：')
    expect(card.querySelector('.channel-current-badge')).toBeNull()
    expect(card.querySelector('.channel-provider-badge')).toBeNull()
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
    const { app, root } = mountPanel()
    await flush()

    expect(root.textContent).toContain('没有找到任何供应商')
    expect(root.textContent).toContain('cc-switch')
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
