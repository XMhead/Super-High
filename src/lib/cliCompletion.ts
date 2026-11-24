export { parseLinkTarget as noticeLinkTarget } from './linkTargets'
export type { LinkTarget as NoticeLinkTarget } from './linkTargets'

export interface PlanRequest {
  connection: number
  requestId: string | number
  threadId: string
  asyncQuestion?: boolean
  questions: Array<{ id: string; header: string; question: string; isSecret?: boolean; multiSelect?: boolean; options: Array<{ label: string; description: string }> }>
}

export interface CompletionNotice {
  title: string
  provider: string
  workspace: string
  conversationId: string
  task: string
  answer: string
  sessionId?: string
  planRequest?: PlanRequest | null
  asyncQuestion?: boolean
  durationMs?: number | null
}

// 与 CLI 原生 “Worked for 1m 12s” 一致的紧凑格式。
export function formatWorkDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const total = Math.max(1, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${minutes}m ${seconds}s`
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function parseCompletionNotice(raw: string): CompletionNotice {
  const notice: CompletionNotice = { title: '', provider: '', workspace: '', conversationId: '', task: '', answer: '' }
  try {
    const value = JSON.parse(raw)
    const fields = Array.isArray(value) ? { title: value[0], provider: value[1] } : value
    for (const key of ['title', 'provider', 'workspace', 'conversationId', 'task', 'answer', 'sessionId'] as const) {
      if (typeof fields?.[key] === 'string') notice[key] = fields[key]
    }
    if (typeof fields?.durationMs === 'number' && Number.isFinite(fields.durationMs)) notice.durationMs = fields.durationMs
    if (fields?.asyncQuestion === true) notice.asyncQuestion = true
    const plan = fields?.planRequest
    if (plan && typeof plan.connection === 'number' && (typeof plan.requestId === 'string' || typeof plan.requestId === 'number')
      && typeof plan.threadId === 'string' && Array.isArray(plan.questions) && plan.questions.length
      && plan.questions.every((q: PlanRequest['questions'][number]) => q && typeof q.id === 'string' && typeof q.question === 'string'
        && Array.isArray(q.options) && q.options.every(o => o && typeof o.label === 'string' && typeof o.description === 'string'))) {
      notice.planRequest = plan
    }
  } catch { /* Keep a generic notice for older or malformed links. */ }
  return notice
}

export const NOTICE_OPEN_FILE_EVENT = 'superhigh:notice-open-file'
export const NOTICE_OPEN_QUESTION_EVENT = 'superhigh:notice-open-question'

export function conversationColor(id: string): string {
  const colors = ['blue', 'green', 'yellow', 'red', 'purple']
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(id)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return `var(--color-accent-${colors[Number(hash % BigInt(colors.length))]})`
}
