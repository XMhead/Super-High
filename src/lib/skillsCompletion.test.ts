import { describe, expect, it } from 'vitest'

import { formatSkillMessage, matchSkillCandidates, skillQueryFromDraft } from './skillsCompletion'

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
    expect(matchSkillCandidates(skills, 'agent').map((item) => item.name)).toEqual([
      'Agent Browser',
      'agent-review',
      'agents-updater',
    ])
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
})
