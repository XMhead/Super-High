import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ChannelProbePanel from './ChannelProbePanel.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ChannelConfig } from '@/types'

const mocks = vi.hoisted(() => ({
  probeChannel: vi.fn(),
  probeWebsiteLatency: vi.fn(),
  fetchChannelModels: vi.fn(),
  saveSettings: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    probeChannel: mocks.probeChannel,
    probeWebsiteLatency: mocks.probeWebsiteLatency,
    fetchChannelModels: mocks.fetchChannelModels,
    saveSettings: mocks.saveSettings,
    getSettings: vi.fn(),
  },
  isTauri: mocks.isTauri,
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
  onProjectServiceStatus: vi.fn(),
}))

function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'channel-1',
    name: '主渠道',
    provider: 'claude',
    websiteUrl: 'https://claudenb.com',
    baseUrl: 'https://claudenb.com',
    apiKey: 'sk-test-1234567890',
    model: 'claude-opus-5',
    ...overrides,
  }
}

function mountPanel(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ render: () => h(ChannelProbePanel) }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

describe('ChannelProbePanel', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mocks.probeChannel.mockReset()
    mocks.probeWebsiteLatency.mockReset()
    mocks.fetchChannelModels.mockReset()
    mocks.isTauri.mockReturnValue(true)
    mocks.probeChannel.mockResolvedValue({
      ok: true,
      latencyMs: 123,
      endpoint: 'https://claudenb.com/v1/messages',
      reply: '我是 Claude。',
      error: '',
      status: 200,
    })
    mocks.probeWebsiteLatency.mockResolvedValue([
      { url: 'https://claudenb.com', label: '官网链接', latencyMs: 88, status: 200, error: null },
      { url: 'https://claudenb.com', label: '接口地址', latencyMs: 95, status: 200, error: null },
    ])
    mocks.fetchChannelModels.mockResolvedValue([
      { id: 'claude-opus-5', ownedBy: 'anthropic' },
      { id: 'gpt-5.5', ownedBy: 'openai' },
    ])
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    const store = useWorkspaceStore()
    store.settings.channels = [channel()]
  })

  it('renders channel cards with provider badge, website and endpoint', async () => {
    const { app, root } = mountPanel(pinia)
    await nextTick()

    expect(root.querySelector('[data-testid="channel-card-channel-1"]')).not.toBeNull()
    expect(root.textContent).toContain('主渠道')
    expect(root.textContent).toContain('Claude Code')
    expect(root.querySelector('.channel-provider-badge.claude svg')).not.toBeNull()
    expect(root.textContent).toContain('官网：https://claudenb.com')
    expect(root.textContent).toContain('接口：https://claudenb.com/v1/messages')
    expect(root.textContent).not.toContain('sk-test-1234567890')

    app.unmount()
    root.remove()
  })

  it('shows the API format on channel cards and defaults Codex to native Responses', async () => {
    const store = useWorkspaceStore()
    store.settings.channels = [
      channel({ id: 'claude-1', provider: 'claude', baseUrl: 'https://claudenb.com' }),
      channel({ id: 'codex-1', provider: 'codex', baseUrl: 'https://claudenb.com/v1' }),
    ]
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const claudeCard = root.querySelector('[data-testid="channel-card-claude-1"]')
    expect(claudeCard?.textContent).toContain('格式：Anthropic Messages（Claude Code 原生）')
    expect(claudeCard?.textContent).toContain('接口：https://claudenb.com/v1/messages')

    const codexCard = root.querySelector('[data-testid="channel-card-codex-1"]')
    expect(codexCard?.textContent).toContain('格式：OpenAI Responses（Codex 原生）')
    expect(codexCard?.textContent).toContain('接口：https://claudenb.com/v1/responses')

    app.unmount()
    root.remove()
  })

  it('selects an API format in the form and persists it on save', async () => {
    const store = useWorkspaceStore()
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const newButton = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('新建渠道'))
    newButton?.click()
    await nextTick()

    const formatSelect = root.querySelector('[data-testid="form-api-format"]') as HTMLSelectElement
    expect(formatSelect).not.toBeNull()
    const optionLabels = [...formatSelect.querySelectorAll('option')].map((option) => option.textContent?.trim())
    expect(optionLabels).toEqual([
      'Anthropic Messages（Claude Code 原生）',
      'OpenAI Responses（Codex 原生）',
      'OpenAI Chat Completions（兼容格式）',
    ])
    expect(formatSelect.value).toBe('anthropic')

    // 切换到 Codex 时，API 格式跟随切换为原生 Responses
    const providerSelect = root.querySelector('.channel-form-grid select') as HTMLSelectElement
    providerSelect.value = 'codex'
    providerSelect.dispatchEvent(new Event('change'))
    await nextTick()
    expect(formatSelect.value).toBe('openai_responses')

    // 手动改为兼容的 Chat Completions 并保存
    formatSelect.value = 'openai_chat'
    formatSelect.dispatchEvent(new Event('change'))
    await nextTick()

    const saveButton = [...root.querySelectorAll<HTMLButtonElement>('.channel-form-actions button')].find((button) => button.textContent?.includes('保存'))
    saveButton?.click()
    await nextTick()
    await nextTick()

    expect(store.settings.channels).toHaveLength(2)
    const saved = store.settings.channels[1]
    expect(saved.provider).toBe('codex')
    expect(saved.apiFormat).toBe('openai_chat')
    expect(mocks.saveSettings).toHaveBeenCalled()

    app.unmount()
    root.remove()
  })

  it('probes a channel and shows latency', async () => {
    const store = useWorkspaceStore()
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const testButtons = [...root.querySelectorAll<HTMLButtonElement>('.channel-card-test button')]
    const probeButton = testButtons.find((button) => button.textContent?.includes('连通测试'))
    probeButton?.click()
    await nextTick()
    await nextTick()

    expect(mocks.probeChannel).toHaveBeenCalledWith(store.settings.channels[0])
    expect(root.querySelector('.channel-test-result.ok')).not.toBeNull()
    expect(root.textContent).toContain('123 ms')

    app.unmount()
    root.remove()
  })

  it('runs a pure website latency test without sending a message', async () => {
    const store = useWorkspaceStore()
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const testButtons = [...root.querySelectorAll<HTMLButtonElement>('.channel-card-test button')]
    const latencyButton = testButtons.find((button) => button.textContent?.includes('测延迟'))
    latencyButton?.click()
    await nextTick()
    await nextTick()

    expect(mocks.probeWebsiteLatency).toHaveBeenCalledWith(store.settings.channels[0])
    expect(mocks.probeChannel).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="channel-latency-result"]')).not.toBeNull()
    expect(root.textContent).toContain('官网链接')
    expect(root.textContent).toContain('88 ms')
    expect(root.textContent).toContain('95 ms')

    app.unmount()
    root.remove()
  })

  it('fetches and displays the model list', async () => {
    const store = useWorkspaceStore()
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const testButtons = [...root.querySelectorAll<HTMLButtonElement>('.channel-card-test button')]
    const modelsButton = testButtons.find((button) => button.textContent?.includes('获取模型'))
    modelsButton?.click()
    await nextTick()
    await nextTick()

    expect(mocks.fetchChannelModels).toHaveBeenCalledWith(store.settings.channels[0])
    expect(root.querySelector('[data-testid="channel-models-result"]')).not.toBeNull()
    expect(root.textContent).toContain('模型列表（2 个）')
    expect(root.textContent).toContain('claude-opus-5')

    app.unmount()
    root.remove()
  })

  it('selects a model from the expanded list and persists it', async () => {
    const store = useWorkspaceStore()
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const testButtons = [...root.querySelectorAll<HTMLButtonElement>('.channel-card-test button')]
    const modelsButton = testButtons.find((button) => button.textContent?.includes('获取模型'))
    modelsButton?.click()
    await nextTick()
    await nextTick()

    const chips = [...root.querySelectorAll<HTMLButtonElement>('.channel-model-chip')]
    const gptChip = chips.find((chip) => chip.textContent?.includes('gpt-5.5'))
    expect(gptChip).toBeDefined()
    gptChip?.click()
    await nextTick()
    await nextTick()

    expect(store.settings.channels[0].model).toBe('gpt-5.5')
    expect(mocks.saveSettings).toHaveBeenCalled()
    expect(root.querySelector('.channel-model-chip.selected')?.textContent).toContain('gpt-5.5')

    app.unmount()
    root.remove()
  })

  it('shows a model fetch failure', async () => {
    mocks.fetchChannelModels.mockRejectedValue(new Error('HTTP 401: bad key'))
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const testButtons = [...root.querySelectorAll<HTMLButtonElement>('.channel-card-test button')]
    const modelsButton = testButtons.find((button) => button.textContent?.includes('获取模型'))
    modelsButton?.click()
    await nextTick()
    await nextTick()
    await nextTick()

    expect(root.querySelector('[data-testid="channel-models-error"]')).not.toBeNull()
    expect(root.textContent).toContain('bad key')

    app.unmount()
    root.remove()
  })

  it('fetches and selects models from the edit form dropdown', async () => {
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const editButton = [...root.querySelectorAll<HTMLButtonElement>('.channel-card-actions button')].find((button) => button.textContent?.includes('编辑'))
    editButton?.click()
    await nextTick()

    const toggle = root.querySelector('.channel-form-model-toggle') as HTMLButtonElement
    toggle.click()
    await nextTick()
    await nextTick()

    expect(mocks.fetchChannelModels).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://claudenb.com',
      apiKey: 'sk-test-1234567890',
    }))
    const dropdown = root.querySelector('[data-testid="form-model-dropdown"]')
    expect(dropdown).not.toBeNull()

    const options = [...root.querySelectorAll<HTMLButtonElement>('.channel-form-model-option')]
    expect(options.length).toBe(2)
    const gptOption = options.find((option) => option.textContent?.includes('gpt-5.5'))
    gptOption?.click()
    await nextTick()

    const modelInput = root.querySelector('.channel-form-model input') as HTMLInputElement
    expect(modelInput.value).toBe('gpt-5.5')
    expect(root.querySelector('[data-testid="form-model-dropdown"]')).toBeNull()

    app.unmount()
    root.remove()
  })

  it('quick-adds default channels from the empty state', async () => {
    const store = useWorkspaceStore()
    store.settings.channels = []
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const addClaude = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('添加 Claude Code 默认渠道'))
    expect(addClaude).toBeDefined()
    addClaude?.click()
    await nextTick()
    await nextTick()

    expect(store.settings.channels).toHaveLength(1)
    expect(store.settings.channels[0]).toMatchObject({
      provider: 'claude',
      websiteUrl: 'https://claudenb.com',
      baseUrl: 'https://claudenb.com',
    })

    app.unmount()
    root.remove()
  })

  it('switches form defaults when the provider changes', async () => {
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const newButton = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('新建渠道'))
    newButton?.click()
    await nextTick()

    const select = root.querySelector('.channel-form-grid select') as HTMLSelectElement
    select.value = 'codex'
    select.dispatchEvent(new Event('change'))
    await nextTick()

    const urlInputs = [...root.querySelectorAll('.channel-form-grid input')]
    const baseUrlInput = urlInputs.find((input) => (input as HTMLInputElement).placeholder.includes('/v1'))
    expect((baseUrlInput as HTMLInputElement).value).toBe('https://claudenb.com/v1')

    app.unmount()
    root.remove()
  })

  it('requires both the website link and the API address on save', async () => {
    const store = useWorkspaceStore()
    const { app, root } = mountPanel(pinia)
    await nextTick()

    const newButton = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('新建渠道'))
    newButton?.click()
    await nextTick()

    const inputs = [...root.querySelectorAll('.channel-form-grid input')] as HTMLInputElement[]
    const websiteInput = inputs.find((input) => input.placeholder === 'https://claudenb.com')
    websiteInput!.value = ''
    websiteInput!.dispatchEvent(new Event('input'))

    const saveButton = [...root.querySelectorAll<HTMLButtonElement>('.channel-form-actions button')].find((button) => button.textContent?.includes('保存'))
    saveButton?.click()
    await nextTick()

    expect(root.querySelector('.channel-form-error')).not.toBeNull()
    expect(root.textContent).toContain('官网链接不能为空')
    expect(store.settings.channels).toHaveLength(1)

    app.unmount()
    root.remove()
  })
})
