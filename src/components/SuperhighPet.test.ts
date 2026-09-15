import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceStore } from '@/stores/workspace'
import SuperhighPet from './SuperhighPet.vue'

const mocks = vi.hoisted(() => ({
  queryCodexBalance: vi.fn(),
  queryCodexOfficialUsage: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    queryCodexBalance: mocks.queryCodexBalance,
    queryCodexOfficialUsage: mocks.queryCodexOfficialUsage,
    saveSettings: mocks.saveSettings,
  },
  isTauri: vi.fn(() => true),
}))

vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn() }))

let app: App<Element> | null = null

const balanceResult = {
  ok: true,
  providerName: 'Tibo',
  baseUrl: 'https://example.test/v1',
  balance: 26.28,
  currency: 'CNY',
  queriedAt: 1,
  error: null,
}

const officialResult = {
  ok: true,
  planType: 'pro',
  primaryWindow: {
    usedPercent: 25,
    limitWindowSeconds: 18_000,
    resetAfterSeconds: 900,
    resetAt: null,
  },
  secondaryWindow: {
    usedPercent: 60,
    limitWindowSeconds: 604_800,
    resetAfterSeconds: null,
    resetAt: 1_888_888_888,
  },
  limitReached: false,
  resetCreditsAvailable: 2,
  fetchedAt: 2,
  httpStatus: null,
  error: null,
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await nextTick()
}

async function mountPet() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(SuperhighPet)
  app.use(pinia)
  app.mount(root)
  await settle()
  return root
}

async function expandPet(root: HTMLElement) {
  root.querySelector<HTMLElement>('.superhigh-pet')!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
  }))
  await settle()
}

describe('SuperhighPet Codex usage', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    vi.useFakeTimers()
    mocks.queryCodexBalance.mockReset().mockResolvedValue(balanceResult)
    mocks.queryCodexOfficialUsage.mockReset().mockResolvedValue(officialResult)
    mocks.saveSettings.mockReset().mockImplementation(async (settings) => settings)
  })

  afterEach(() => {
    app?.unmount()
    app = null
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('shows official limits without requesting or displaying provider balance', async () => {
    const root = await mountPet()
    await expandPet(root)

    const text = root.textContent || ''
    expect(text).toContain('Codex 官方额度')
    expect(text).toContain('75% 可用')
    expect(text).toContain('周额度')
    expect(text).toContain('可用重置次数: 2')
    expect(text).not.toContain('渠道余额')
    expect(mocks.queryCodexBalance).not.toHaveBeenCalled()
  })

  it('polls only official usage every five minutes', async () => {
    await mountPet()
    expect(mocks.queryCodexBalance).not.toHaveBeenCalled()
    expect(mocks.queryCodexOfficialUsage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(299_999)
    await settle()
    expect(mocks.queryCodexOfficialUsage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await settle()

    expect(mocks.queryCodexBalance).not.toHaveBeenCalled()
    expect(mocks.queryCodexOfficialUsage).toHaveBeenCalledTimes(2)
  })

  it('keeps the last official usage visible after a refresh failure', async () => {
    mocks.queryCodexOfficialUsage
      .mockResolvedValueOnce(officialResult)
      .mockResolvedValue({
        ...officialResult,
        ok: false,
        primaryWindow: null,
        secondaryWindow: null,
        fetchedAt: null,
        httpStatus: 429,
        error: 'Codex 官方额度查询过于频繁，稍后自动重试',
      })
    const root = await mountPet()

    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    await expandPet(root)

    const text = root.textContent || ''
    expect(text).toContain('75% 可用')
    expect(text).toContain('显示上次结果')
    expect(text).toContain('稍后自动重试')
  })

  it('controls the YAML key value panel from the butler switch', async () => {
    const root = await mountPet()
    await expandPet(root)
    const store = useWorkspaceStore()
    const label = Array.from(root.querySelectorAll('label'))
      .find((item) => item.textContent?.includes('YAML 键值显示'))
    const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')

    expect(input?.checked).toBe(false)
    if (!input) throw new Error('找不到 YAML 键值显示开关')
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(store.settings.yamlKeyValuePanelEnabled).toBe(true)
    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ yamlKeyValuePanelEnabled: true }))
  })
})
