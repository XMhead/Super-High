import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/WelcomeScreen.vue', () => ({ default: {} }))
vi.mock('@/components/WorkspaceShell.vue', () => ({ default: {} }))
vi.mock('@/lib/tauri', () => ({ backend: {}, isTauri: () => false }))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))

import { shouldBlockReloadShortcut } from '@/App.vue'

function keyboardEvent(
  key: string,
  init: KeyboardEventInit = {},
  target?: Element,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  if (target) Object.defineProperty(event, 'composedPath', { value: () => [target] })
  return event
}

describe('reload shortcut protection', () => {
  it('blocks browser reload shortcuts in ordinary UI', () => {
    expect(shouldBlockReloadShortcut(keyboardEvent('r', { ctrlKey: true }))).toBe(true)
    expect(shouldBlockReloadShortcut(keyboardEvent('R', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(shouldBlockReloadShortcut(keyboardEvent('F5'))).toBe(true)
  })

  it('keeps raw Ctrl+R and F5 available inside xterm', () => {
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const input = document.createElement('textarea')
    terminal.appendChild(input)
    document.body.appendChild(terminal)

    expect(shouldBlockReloadShortcut(keyboardEvent('r', { ctrlKey: true }, input))).toBe(false)
    expect(shouldBlockReloadShortcut(keyboardEvent('F5', {}, input))).toBe(false)
    expect(shouldBlockReloadShortcut(keyboardEvent('R', { ctrlKey: true, shiftKey: true }, input))).toBe(true)

    terminal.remove()
  })
})
