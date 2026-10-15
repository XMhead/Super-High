import type { SkillCompletionItem, SkillScopeOrder } from '@/types'

export interface SkillInvocationState {
  name: string
  description: string
  path: string
}

/** 菜单里的三类条目，各自对应一个固定的标签颜色。 */
export type SkillKind = 'command' | 'project' | 'global'

export const SKILL_KIND_LABELS: Record<SkillKind, string> = {
  command: 'SuperHigh',
  project: '项目',
  global: '全局',
}

/** 指令名称颜色数量，与主题里的 `--skill-name-<n>` 变量一一对应。 */
export const SKILL_NAME_COLOR_COUNT = 6

export function skillKind(skill: Pick<SkillCompletionItem, 'scope' | 'path'>): SkillKind {
  return skill.path.startsWith('superhigh:') ? 'command' : skill.scope
}

/** 按名称稳定取色，同一指令每次打开颜色一致。 */
export function skillNameColorIndex(name: string): number {
  let hash = 0
  for (const char of name.toLocaleLowerCase()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % SKILL_NAME_COLOR_COUNT
}

/** 把 frontmatter 描述拆成一句摘要和后续要点，便于列表单行展示与详情分条阅读。 */
export function summarizeSkillDescription(description: string): { summary: string, details: string[] } {
  const text = description.replace(/\s+/g, ' ').trim()
  const sentences = text
    .split(/(?<=[。！？；;])\s*|(?<=[.!?])\s+(?=\S)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  return { summary: sentences[0] ?? '', details: sentences.slice(1) }
}

/** 只在输入开头的斜杠命令上打开 Skills 菜单。 */
export function skillQueryFromDraft(draft: string, cursorOffset = draft.length): string | null {
  if (cursorOffset !== draft.length) return null
  const match = draft.match(/^\/([^\s/]*)$/)
  return match ? match[1] : null
}

/** SuperHigh 指令始终置顶，全局 Skill 按设置排在项目 Skill 之前或之后，组内前缀匹配优先。 */
export function matchSkillCandidates(skills: SkillCompletionItem[], query: string, order: SkillScopeOrder): SkillCompletionItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  const kindRank: Record<SkillKind, number> = { command: 0, project: order === 'globalFirst' ? 2 : 1, global: order === 'globalFirst' ? 1 : 2 }
  return skills
    .filter((skill) => !normalized || skill.name.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const rankDelta = kindRank[skillKind(left)] - kindRank[skillKind(right)]
      if (rankDelta) return rankDelta
      const leftPrefix = left.name.toLocaleLowerCase().startsWith(normalized)
      const rightPrefix = right.name.toLocaleLowerCase().startsWith(normalized)
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

export function skillInvocationFromCandidate(skill: SkillCompletionItem): SkillInvocationState {
  return { name: skill.name, description: skill.description, path: skill.path }
}

/** 追加一个已选 Skill；同一文件只保留一次。 */
export function addSkillInvocation(skills: SkillInvocationState[], skill: SkillInvocationState): SkillInvocationState[] {
  const key = skill.path || skill.name
  return skills.some((item) => (item.path || item.name) === key) ? skills : [...skills, skill]
}

export function formatSkillMessage(skills: SkillInvocationState[] | SkillInvocationState | null, draft: string): string {
  const body = draft.trim()
  const list = Array.isArray(skills) ? skills : skills ? [skills] : []
  if (!list.length) return body
  const lines = [`使用${list.map((skill) => skill.name).join('、')}`]
  let withPath = 0
  for (const skill of list) {
    const path = skill.path.trim().replace(/\\/g, '/')
    if (!path) continue
    withPath += 1
    if (list.length > 1) lines.push(`[${skill.name}]`)
    lines.push(`Skill 文件：${path}`, `Skill 目录：${path.slice(0, path.lastIndexOf('/'))}`)
  }
  if (withPath === 1 && list.length === 1) lines.push('请先读取该 Skill 文件，并以 Skill 目录解析其中的相对路径。')
  else if (withPath) lines.push('请先读取以上全部 Skill 文件，并以各自的 Skill 目录解析其中的相对路径。')
  const instruction = lines.join('\n')
  return body ? `${instruction}\n\n${body}` : instruction
}
