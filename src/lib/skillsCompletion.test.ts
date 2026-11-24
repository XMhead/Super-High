import { describe, expect, it } from 'vitest'

import { addSkillInvocation, formatSkillMessage, matchSkillCandidates, skillQueryFromDraft, summarizeSkillDescription } from './skillsCompletion'

const skills = [
  { name: 'Agent Browser', description: 'browser', scope: 'global' as const, path: 'global/Agent Browser/SKILL.md' },
  { name: 'agents-updater', description: 'update', scope: 'project' as const, path: 'project/agents-updater/SKILL.md' },
  { name: 'agent-review', description: 'review', scope: 'global' as const, path: 'global/agent-review/SKILL.md' },
]

describe('skillsCompletion', () => {
  it('only opens for a slash query at the beginning of the draft', () => {
    expect(skillQueryFromDraft('/')).toBe('')
    expect(skillQueryFromDraft('/agent')).toBe('agent')
    expect(skillQueryFromDraft('请用 /agent')).toBeNull()
    expect(skillQueryFromDraft('/agent 后续说明')).toBeNull()
    expect(skillQueryFromDraft('/agent', 3)).toBeNull()
  })

  it('prioritizes prefix matches and keeps the list case-insensitive', () => {
    expect(matchSkillCandidates(skills, 'agent', 'globalFirst').map((item) => item.name)).toEqual([
      'Agent Browser',
      'agent-review',
      'agents-updater',
    ])
  })

  it('places global skills above or below project skills and keeps SuperHigh commands on top', () => {
    const withCommand = [...skills, { name: 'prompt', description: '提示词', scope: 'project' as const, path: 'superhigh:prompt' }]
    expect(matchSkillCandidates(withCommand, '', 'globalLast').map((item) => item.name)).toEqual([
      'prompt',
      'agents-updater',
      'Agent Browser',
      'agent-review',
    ])
    expect(matchSkillCandidates(withCommand, '', 'globalFirst').map((item) => item.name)).toEqual([
      'prompt',
      'Agent Browser',
      'agent-review',
      'agents-updater',
    ])
  })

  it('splits a skill description into a summary line and detail points', () => {
    expect(summarizeSkillDescription('同步全局 skills 链接。修复缺失链接；配置链接目标')).toEqual({
      summary: '同步全局 skills 链接。',
      details: ['修复缺失链接；', '配置链接目标'],
    })
    expect(summarizeSkillDescription('Use when tests fail. Re-run them.').summary).toBe('Use when tests fail.')
  })

  it('injects the selected global or project skill file and directory', () => {
    for (const skill of skills) {
      const message = formatSkillMessage(skill, '继续执行')
      expect(message).toContain(`Skill 文件：${skill.path}`)
      expect(message).toContain(`Skill 目录：${skill.path.slice(0, skill.path.lastIndexOf('/'))}`)
      expect(message).toMatch(/\n\n继续执行$/)
    }
    expect(formatSkillMessage({ name: 'global', description: '', path: 'C:\\Users\\Demo User\\skills\\global\\SKILL.md' }, '')).toContain('Skill 目录：C:/Users/Demo User/skills/global')
  })

  it('formats the selected skill for the CLI while preserving the body', () => {
    expect(formatSkillMessage({ name: 'agents-updater', description: '', path: '' }, '检查配置')).toBe(
      '使用agents-updater\n\n检查配置',
    )
    expect(formatSkillMessage({ name: 'agents-updater', description: '', path: '' }, '')).toBe('使用agents-updater')
    expect(formatSkillMessage(null, '  普通消息  ')).toBe('普通消息')
  })

  it('combines several selected skills into one invocation without duplicates', () => {
    const first = { name: 'a', description: '', path: 'D:/skills/a/SKILL.md' }
    const second = { name: 'b', description: '', path: 'D:/skills/b/SKILL.md' }
    const selected = addSkillInvocation(addSkillInvocation(addSkillInvocation([], first), second), first)
    expect(selected).toEqual([first, second])
    expect(formatSkillMessage(selected, '开始')).toBe([
      '使用a、b',
      '[a]',
      'Skill 文件：D:/skills/a/SKILL.md',
      'Skill 目录：D:/skills/a',
      '[b]',
      'Skill 文件：D:/skills/b/SKILL.md',
      'Skill 目录：D:/skills/b',
      '请先读取以上全部 Skill 文件，并以各自的 Skill 目录解析其中的相对路径。',
      '',
      '开始',
    ].join('\n'))
  })
})
