import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  convertFileSrc: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  convertFileSrc: mocks.convertFileSrc,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}))

import { backend } from './tauri'

describe('tauri backend bridge', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    mocks.convertFileSrc.mockReset()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  })

  it('streams desktop videos through the asset protocol after validating the 10 GB limit', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    mocks.invoke.mockResolvedValueOnce('D:/Media/recording.mp4')
    mocks.convertFileSrc.mockReturnValueOnce('http://asset.localhost/D%3A/Media/recording.mp4')

    await expect(backend.readMediaAsDataUrl('D:/Media/recording.mp4')).resolves.toBe(
      'http://asset.localhost/D%3A/Media/recording.mp4',
    )
    expect(mocks.invoke).toHaveBeenCalledWith('prepare_video_preview_command', {
      path: 'D:/Media/recording.mp4',
    })
    expect(mocks.convertFileSrc).toHaveBeenCalledWith('D:/Media/recording.mp4')
  })

  it('queries live terminal session ids from the backend manager', async () => {
    mocks.invoke.mockResolvedValueOnce(['session-live'])

    await expect(backend.listLiveTerminalSessionIds()).resolves.toEqual(['session-live'])
    expect(mocks.invoke).toHaveBeenCalledWith('list_live_terminal_session_ids_command', undefined)
  })

  it('maps native conversation listing, reading, and resume to their Tauri commands', async () => {
    mocks.invoke.mockResolvedValueOnce([])
    await expect(backend.listWorkspaceCliConversations('D:/One')).resolves.toEqual([])
    expect(mocks.invoke).toHaveBeenLastCalledWith('list_workspace_cli_conversations_command', {
      projectPath: 'D:/One',
    })

    mocks.invoke.mockResolvedValueOnce({ id: 'codex:session-1', messages: [] })
    await backend.readWorkspaceCliConversation('D:/One', 'C:/Users/Example/.codex/sessions/rollout.jsonl')
    expect(mocks.invoke).toHaveBeenLastCalledWith('read_workspace_cli_conversation_command', {
      projectPath: 'D:/One',
      sourcePath: 'C:/Users/Example/.codex/sessions/rollout.jsonl',
    })

    mocks.invoke.mockResolvedValueOnce({ id: 'terminal-1' })
    await backend.resumeCliConversation('workspace-1', 'codex', 'D:/One', 'session-1')
    expect(mocks.invoke).toHaveBeenLastCalledWith('resume_cli_conversation_command', {
      workspaceId: 'workspace-1',
      providerKind: 'codex',
      cwd: 'D:/One',
      nativeSessionId: 'session-1',
    })

    mocks.invoke.mockResolvedValueOnce(undefined)
    await backend.openExternalCliSession('terminal-1')
    expect(mocks.invoke).toHaveBeenLastCalledWith('open_external_cli_session_command', {
      sessionId: 'terminal-1',
    })
  })

  it('queries the active .codex provider balance through the registered command', async () => {
    mocks.invoke.mockResolvedValueOnce({
      ok: true,
      providerName: '0.01',
      baseUrl: 'https://api.example.test/v1',
      balance: 26.28,
      currency: 'USD',
      queriedAt: 1,
      error: null,
    })

    await expect(backend.queryCodexBalance()).resolves.toMatchObject({
      providerName: '0.01',
      balance: 26.28,
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('query_codex_balance_command', undefined)
  })

  it('queries ChatGPT Codex usage through its separate registered command', async () => {
    mocks.invoke.mockResolvedValueOnce({
      ok: true,
      planType: 'pro',
      primaryWindow: { usedPercent: 25, limitWindowSeconds: 18000, resetAfterSeconds: 900, resetAt: 1 },
      secondaryWindow: null,
      limitReached: false,
      resetCreditsAvailable: 1,
      fetchedAt: 2,
      httpStatus: null,
      error: null,
    })

    await expect(backend.queryCodexOfficialUsage()).resolves.toMatchObject({
      planType: 'pro',
      resetCreditsAvailable: 1,
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('query_codex_official_usage_command', undefined)
  })

  it('loads and records CLI history through the registered commands', async () => {
    mocks.invoke.mockResolvedValueOnce({
      messages: [],
      paths: [],
      scannedFiles: 2,
      indexedFiles: 2,
      indexedMessages: 4,
    })

    await expect(backend.loadCliHistory()).resolves.toEqual({
      messages: [],
      paths: [],
      scannedFiles: 2,
      indexedFiles: 2,
      indexedMessages: 4,
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('load_cli_history_command', undefined)

    mocks.invoke.mockResolvedValueOnce({
      messages: [],
      paths: [],
      scannedFiles: 1,
      indexedFiles: 0,
      indexedMessages: 4,
    })
    await backend.refreshCliHistory()
    expect(mocks.invoke).toHaveBeenLastCalledWith('refresh_cli_history_command', undefined)

    mocks.invoke.mockResolvedValueOnce(undefined)
    await backend.recordCliHistoryMessage({
      content: '继续',
      timestamp: '2026-08-23T10:00:00.000Z',
      cwd: 'D:/plugins',
      sessionId: 'session-1',
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('record_cli_history_message_command', {
      content: '继续',
      timestamp: '2026-08-23T10:00:00.000Z',
      cwd: 'D:/plugins',
      sessionId: 'session-1',
    })
  })

  it('opens web links through the registered system browser command', async () => {
    mocks.invoke.mockResolvedValueOnce(undefined)

    await backend.openUrl('https://example.com/docs')

    expect(mocks.invoke).toHaveBeenCalledWith('open_url_command', {
      url: 'https://example.com/docs',
    })
  })

  it('checks whether a terminal path is an existing file through the registered command', async () => {
    mocks.invoke.mockResolvedValueOnce(true)

    await expect(backend.isFile('C:/Users/Example/AppData/Local/Temp/analysis.json')).resolves.toBe(true)

    expect(mocks.invoke).toHaveBeenLastCalledWith('is_file_command', {
      path: 'C:/Users/Example/AppData/Local/Temp/analysis.json',
    })
  })

  it('resolves terminal files and folders through the registered command', async () => {
    const target = { path: 'C:/Users/Example/AppData/Local/Temp/frame-005.png', isFile: true }
    mocks.invoke.mockResolvedValueOnce(target)

    await expect(backend.resolveTerminalPath('~/AppData/Local/Temp/frame-005.png')).resolves.toEqual(target)

    expect(mocks.invoke).toHaveBeenLastCalledWith('resolve_terminal_path_command', {
      path: '~/AppData/Local/Temp/frame-005.png',
    })
  })

  it('maps image editing save and PNG export path commands', async () => {
    mocks.invoke.mockResolvedValueOnce('D:/Media/edited.png')
    await expect(backend.saveImageDataUrl('D:/Media/edited.png', 'data:image/png;base64,AA=='))
      .resolves.toBe('D:/Media/edited.png')
    expect(mocks.invoke).toHaveBeenLastCalledWith('save_image_data_url_command', {
      path: 'D:/Media/edited.png',
      dataUrl: 'data:image/png;base64,AA==',
    })

    mocks.invoke.mockResolvedValueOnce('D:/Media/source-edited.png')
    await expect(backend.pickPngExportPath('D:/Media/source.webp'))
      .resolves.toBe('D:/Media/source-edited.png')
    expect(mocks.invoke).toHaveBeenLastCalledWith('pick_png_export_path_command', {
      sourcePath: 'D:/Media/source.webp',
    })
  })

  it('maps memo operations to the registered Tauri commands', async () => {
    mocks.invoke.mockResolvedValue([])

    await backend.listMemos({
      text: '2026/07',
      createdFrom: '2026-07-10T00:00:00.000Z',
      createdBefore: '2026-07-21T00:00:00.000Z',
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('list_memos_command', {
      query: '2026/07',
      createdFrom: '2026-07-10T00:00:00.000Z',
      createdBefore: '2026-07-21T00:00:00.000Z',
    })

    await backend.createMemo()
    expect(mocks.invoke).toHaveBeenLastCalledWith('create_memo_command', undefined)

    await backend.updateMemo('memo-1', '标题', '正文')
    expect(mocks.invoke).toHaveBeenLastCalledWith('update_memo_command', {
      id: 'memo-1',
      title: '标题',
      content: '正文',
    })

    await backend.deleteMemo('memo-1')
    expect(mocks.invoke).toHaveBeenLastCalledWith('delete_memo_command', { id: 'memo-1' })
  })
})
