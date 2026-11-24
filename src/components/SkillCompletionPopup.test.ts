import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SkillCompletionPopup from './SkillCompletionPopup.vue'
import type { SkillCompletionItem } from '@/types'

const candidates: SkillCompletionItem[] = [
  { name: 'agents-updater', description: '维护 Agent 资源。合并重复规则', scope: 'project', path: 'D:/demo/.codex/skills/agents-updater/SKILL.md' },
  { name: 'agent-review', description: '代码审查', scope: 'global', path: 'C:/skills/agent-review/SKILL.md' },
]

describe('SkillCompletionPopup', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('selects on pointer movement without scrolling the list under a resting cursor', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const selectedIndex = ref(0)
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      render: () => h(SkillCompletionPopup, {
        candidates,
        selectedIndex: selectedIndex.value,
        onSelect: (index: number) => { selectedIndex.value = index },
      }),
    })
    app.mount(root)
    await nextTick()
    scrollIntoView.mockClear()

    const items = root.querySelectorAll('.skill-completion-item')
    items[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await nextTick()
    expect(selectedIndex.value).toBe(0)

    items[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await nextTick()
    expect(selectedIndex.value).toBe(1)
    expect(scrollIntoView).not.toHaveBeenCalled()

    selectedIndex.value = 0
    await nextTick()
    expect(scrollIntoView).toHaveBeenCalledOnce()

    expect(root.querySelector('.skill-completion-detail-description')?.textContent).toBe('维护 Agent 资源。')
    expect(root.querySelector('.skill-completion-detail-points')?.textContent).toContain('合并重复规则')
    expect(Array.from(root.querySelectorAll('.skill-completion-group .skill-kind-tag')).map((tag) => tag.className))
      .toEqual(['skill-kind-tag kind-project', 'skill-kind-tag kind-global'])
    app.unmount()
  })
})
