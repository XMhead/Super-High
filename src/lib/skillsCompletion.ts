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
  return body ? `使用${skill.name}\n\n${body}` : `使用${skill.name}`
}
