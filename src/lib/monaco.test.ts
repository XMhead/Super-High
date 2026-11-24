import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  register: vi.fn(),
  openUrl: vi.fn(),
  showError: vi.fn(),
}))
vi.mock('./monacoWorkers', () => ({ initializeMonacoWorkers: mocks.initialize }))
vi.mock('monaco-editor/esm/vs/editor/editor.main.js', () => ({ editor: { registerLinkOpener: mocks.register } }))
vi.mock('./tauri', () => ({ backend: { openUrl: mocks.openUrl } }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => ({ showErrorMessage: mocks.showError }) }))

describe('Monaco system browser links', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.openUrl.mockResolvedValue(undefined) })

  it('shares one system opener between concurrent source and diff editor loads', async () => {
    const { loadMonaco, getMonaco } = await import('./monaco')
    const [source, diff] = await Promise.all([loadMonaco(), loadMonaco()])
    expect(source).toBe(diff)
    expect(getMonaco()).toBe(source)
    await loadMonaco()
    expect(mocks.register).toHaveBeenCalledTimes(1)
    const opener = mocks.register.mock.calls[0][0]
    const url = 'https://media.forgecdn.net/attachments/1181/636/royal-palace.png'
    expect(await opener.open({ toString: () => url })).toBe(true)
    expect(mocks.openUrl).toHaveBeenCalledWith(url)
    expect(await opener.open({ toString: () => 'command:editor.action' })).toBe(false)
    expect(mocks.openUrl).toHaveBeenCalledTimes(1)
  })

  it('reports a browser error and consumes the link without falling back to a silent popup', async () => {
    const { loadMonaco } = await import('./monaco')
    await loadMonaco()
    mocks.openUrl.mockRejectedValueOnce(new Error('system browser unavailable'))
    const opener = mocks.register.mock.calls[0][0]
    expect(await opener.open({ toString: () => 'https://example.com/' })).toBe(true)
    expect(mocks.showError).toHaveBeenCalledWith('打开网页失败：system browser unavailable')
  })
})
