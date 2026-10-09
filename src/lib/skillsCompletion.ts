import type { SkillCompletionItem } from '@/types'

export interface SkillInvocationState {
  name: string
  description: string
  path: string
}

/** 只在输入开头的斜杠命令上打开 Skills 菜单。 */
export function skillQueryFromDraft(draft: string, cursorOffset = draft.length): string | null {
  if (cursorOffset !== draft.length) return null
  const match = draft.match(/^\/([^\s/]*)$/)
  return match ? match[1] : null
}

export function matchSkillCandidates(skills: SkillCompletionItem[], query: string): SkillCompletionItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  return skills
    .filter((skill) => !normalized || skill.name.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftPrefix = left.name.toLocaleLowerCase().startsWith(normalized)
      const rightPrefix = right.name.toLocaleLowerCase().startsWith(normalized)
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

export function skillInvocationFromCandidate(skill: SkillCompletionItem): SkillInvocationState {
  return { name: skill.name, description: skill.description, path: skill.path }
}

export function formatSkillMessage(skill: SkillInvocationState | null, draft: string): string {
  const body = draft.trim()
  if (!skill) return body
  const path = skill.path.trim().replace(/\\/g, '/')
  const directory = path.slice(0, path.lastIndexOf('/'))
  const instruction = path
    ? `使用${skill.name}\nSkill 文件：${path}\nSkill 目录：${directory}\n请先读取该 Skill 文件，并以 Skill 目录解析其中的相对路径。`
    : `使用${skill.name}`
  return body ? `${instruction}\n\n${body}` : instruction
}
