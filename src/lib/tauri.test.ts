import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}))

import { backend } from './tauri'

describe('tauri backend bridge', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
  })

  it('queries live terminal session ids from the backend manager', async () => {
    mocks.invoke.mockResolvedValueOnce(['session-live'])

    await expect(backend.listLiveTerminalSessionIds()).resolves.toEqual(['session-live'])
    expect(mocks.invoke).toHaveBeenCalledWith('list_live_terminal_session_ids_command', undefined)
  })

  it('opens web links through the registered system browser command', async () => {
    mocks.invoke.mockResolvedValueOnce(undefined)

    await backend.openUrl('https://example.com/docs')

    expect(mocks.invoke).toHaveBeenCalledWith('open_url_command', {
      url: 'https://example.com/docs',
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
