import { createApp, h, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CliScheduledMessagePanel from './CliScheduledMessagePanel.vue'
import type { SkillCompletionItem } from '@/types'

const store = vi.hoisted(() => ({
  settings: { skillScopeOrder: 'globalFirst' },
  scheduledTerminalMessages: {},
  scheduleTerminalMessage: vi.fn((_sessionId: string, _text: string, _minutes: number, _id?: string) => true),
  sendScheduledTerminalMessage: vi.fn(),
  openTerminalFileLink: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const skills: SkillCompletionItem[] = [
  { name: 'agent-updater', description: '维护技能', path: 'C:/skills/agent-updater/SKILL.md', scope: 'global' },
  { name: 'inspect', description: '检查配置', path: 'D:/commands.md', scope: 'project', commandId: 'inspect', content: '检查当前配置' },
  { name: 'status', description: '查看状态', path: 'cli:/status', scope: 'project' },
]
let app: ReturnType<typeof createApp>
let root: HTMLDivElement
let props: { sessionId: string; draft: string; skills: SkillCompletionItem[] }
const load = vi.fn()

beforeEach(async () => {
  vi.clearAllMocks()
  root = document.createElement('div')
  document.body.append(root)
  props = reactive({ sessionId: 's1', draft: '主输入草稿', skills })
  app = createApp({ render: () => h(CliScheduledMessagePanel, { ...props, onLoadSkills: load }) })
  app.mount(root)
  await nextTick()
})
afterEach(() => { app.unmount(); root.remove() })

async function input(text: string) {
  const target = root.querySelector('textarea')!
  target.value = text
  target.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  return target
}

it('completes a Skill with Enter, preserves its path in the scheduled text, and leaves the main draft intact', async () => {
  const target = await input('/agent-updater')
  expect(root.querySelector('[role="option"]')?.textContent).toContain('/agent-updater')
  expect(load).toHaveBeenCalled()
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await nextTick()
  expect(root.querySelector('.skill-invocation-chip')?.textContent).toContain('/agent-updater')
  expect(store.scheduleTerminalMessage).not.toHaveBeenCalled()
  expect(store.sendScheduledTerminalMessage).not.toHaveBeenCalled()
  await input('学习本次对话')
  ;(root.querySelector('[data-testid="terminal-scheduled-add"]') as HTMLButtonElement).click()
  expect(store.scheduleTerminalMessage).toHaveBeenCalledWith('s1', expect.stringContaining('Skill 文件：C:/skills/agent-updater/SKILL.md'), 1, undefined)
  expect(store.scheduleTerminalMessage.mock.calls[0][1]).toContain('学习本次对话')
  expect(props.draft).toBe('主输入草稿')
})

it('supports pointer selection of registered commands and stages CLI commands without executing them', async () => {
  await input('/inspect')
  root.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
  await nextTick()
  expect(root.querySelector('textarea')!.value).toBe('检查当前配置')
  const target = await input('/status')
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await nextTick()
  expect(root.querySelector('.skill-completion-popup')).toBeNull()
  expect(root.querySelector('textarea')!.value).toBe('/status')
  expect(store.sendScheduledTerminalMessage).not.toHaveBeenCalled()
  ;(root.querySelector('[data-testid="terminal-scheduled-add"]') as HTMLButtonElement).click()
  expect(store.scheduleTerminalMessage).toHaveBeenCalledWith('s1', '/status', 1, undefined)
})

it('dismisses completion with Escape and clears selected Skills when switching sessions', async () => {
  let target = await input('/agent')
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await nextTick()
  expect(root.querySelector('.skill-completion-popup')).toBeNull()
  target = await input('/agent')
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await nextTick()
  props.sessionId = 's2'
  await nextTick()
  expect(root.querySelector('.skill-invocation-chip')).toBeNull()
  expect(root.querySelector('textarea')!.value).toBe('')
  expect((root.querySelector('[data-testid="terminal-scheduled-add"]') as HTMLButtonElement).disabled).toBe(true)
})
