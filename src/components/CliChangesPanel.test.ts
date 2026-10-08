import { createApp, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import CliChangesPanel from './CliChangesPanel.vue'
import type { SessionChanges, SessionFileDiff } from '@/types'

const mocks = vi.hoisted(() => ({
  getSessionChanges: vi.fn(),
  getSessionFileDiff: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    getSessionChanges: mocks.getSessionChanges,
    getSessionFileDiff: mocks.getSessionFileDiff,
  },
  isTauri: () => true,
  onTerminalOutput: vi.fn(async () => () => {}),
  onWorkspaceFilesChanged: vi.fn(async () => () => {}),
}))

vi.mock('@/lib/codeHighlight', () => ({
  highlightCode: vi.fn(async (text: string) => text),
}))

const changes: SessionChanges = {
  available: true,
  mode: 'git',
  root: 'D:\\Demo',
  baseline: 'session',
  capturedAtMs: 1,
  truncated: false,
  files: [
    { path: 'src/a.ts', absolutePath: 'D:\\Demo\\src\\a.ts', status: 'modified', additions: 2, deletions: 1, binary: false, kind: 'source' },
    { path: 'src/a.test.ts', absolutePath: 'D:\\Demo\\src\\a.test.ts', status: 'added', additions: 5, deletions: 0, binary: false, kind: 'test' },
  ],
}

const diff: SessionFileDiff = {
  file: changes.files[0],
  truncated: false,
  tooLarge: false,
  unavailableBase: false,
  rows: [
    { kind: 'context', oldLine: 1, newLine: 1, text: 'one' },
    { kind: 'del', oldLine: 2, text: 'two' },
    { kind: 'add', newLine: 2, text: '2' },
    { kind: 'gap', text: '' },
    { kind: 'add', newLine: 9, text: 'nine' },
  ],
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(onOpen = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(CliChangesPanel, { sessionId: 's1', cwd: 'D:\\Demo', running: true, onOpenFile: onOpen })
  app.mount(host)
  return { host, app, onOpen }
}

describe('CliChangesPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.localStorage.clear()
    mocks.getSessionChanges.mockReset().mockResolvedValue(changes)
    mocks.getSessionFileDiff.mockReset().mockResolvedValue(diff)
  })

  it('summarises session changes only, excluding earlier edits', async () => {
    const { host, app } = mount()
    await flush()
    const bar = host.querySelector('[data-testid="cli-changes-toggle"]')!
    expect(bar.textContent).toContain('2 个文件已更改')
    expect(bar.textContent).toContain('+7')
    expect(bar.textContent).toContain('-1')
    expect(host.querySelectorAll('.cli-changes-chip')).toHaveLength(0)
    app.unmount()
  })

  it('expands into a grouped file list and a diff that jumps to lines', async () => {
    const { host, app, onOpen } = mount()
    await flush()
    ;(host.querySelector('[data-testid="cli-changes-toggle"]') as HTMLButtonElement).click()
    await flush()

    const list = host.querySelector('[data-testid="cli-changes-list"]')!
    expect([...list.querySelectorAll('[data-testid="cli-changes-file"]')].map((row) => row.getAttribute('title'))).toEqual(['src/a.ts'])
    expect(list.textContent).toContain('1 个测试/生成文件')
    expect(list.textContent).not.toContain('会话前')
    expect(mocks.getSessionFileDiff).toHaveBeenCalledWith('s1', 'D:\\Demo', 'src/a.ts')

    const rows = [...host.querySelectorAll('[data-testid="cli-changes-row"]')] as HTMLElement[]
    expect(rows.map((row) => row.querySelector('.cli-diff-line')!.textContent)).toEqual(['1', '2', '2', '9'])
    expect(host.querySelectorAll('.cli-diff-gap')).toHaveLength(1)
    rows[1].click()
    expect(onOpen).toHaveBeenCalledWith('D:\\Demo\\src\\a.ts', 2)

    const groups = [...list.querySelectorAll('.cli-changes-group')] as HTMLButtonElement[]
    groups[0].click()
    await flush()
    expect(list.querySelectorAll('[data-testid="cli-changes-file"]')).toHaveLength(2)
    expect(window.localStorage.getItem('superhigh.cliChanges.expanded')).toBe('1')
    app.unmount()
  })

  it('hides the panel when the session changed nothing', async () => {
    mocks.getSessionChanges.mockResolvedValue({ ...changes, files: [] })
    window.localStorage.setItem('superhigh.cliChanges.expanded', '1')
    const { host, app } = mount()
    await flush()
    expect(host.querySelector('[data-testid="cli-changes-panel"]')).toBeNull()
    expect(mocks.getSessionFileDiff).not.toHaveBeenCalled()
    app.unmount()
  })

  it('shows the unavailable reason instead of counts', async () => {
    mocks.getSessionChanges.mockResolvedValue({ ...changes, available: false, reason: '不是 Git 仓库', files: [] })
    const { host, app } = mount()
    await flush()
    expect(host.querySelector('[data-testid="cli-changes-summary"]')!.textContent).toBe('不是 Git 仓库')
    app.unmount()
  })

  it('hides the overlay when the session has no changed files', async () => {
    mocks.getSessionChanges.mockResolvedValue({ ...changes, files: [] })
    const { host, app } = mount()
    await flush()
    expect(host.querySelector('[data-testid="cli-changes-panel"]')).toBeNull()
    app.unmount()
  })

  it('does not flash the overlay while refreshing an unchanged session', async () => {
    let resolveRefresh!: (value: SessionChanges) => void
    mocks.getSessionChanges.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve }))
    const { host, app } = mount()
    await nextTick()
    expect(host.querySelector('[data-testid="cli-changes-panel"]')).toBeNull()
    resolveRefresh({ ...changes, files: [] })
    await flush()
    expect(host.querySelector('[data-testid="cli-changes-panel"]')).toBeNull()
    app.unmount()
  })
})
