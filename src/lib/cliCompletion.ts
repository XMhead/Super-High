export interface PlanRequest {
  connection: number
  requestId: string | number
  threadId: string
  questions: Array<{ id: string; header: string; question: string; isSecret?: boolean; options: Array<{ label: string; description: string }> }>
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
}

export function parseCompletionNotice(raw: string): CompletionNotice {
  const notice: CompletionNotice = { title: '', provider: '', workspace: '', conversationId: '', task: '', answer: '' }
  try {
    const value = JSON.parse(raw)
    const fields = Array.isArray(value) ? { title: value[0], provider: value[1] } : value
    for (const key of ['title', 'provider', 'workspace', 'conversationId', 'task', 'answer', 'sessionId'] as const) {
      if (typeof fields?.[key] === 'string') notice[key] = fields[key]
    }
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

export type NoticeLinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; lineNumber?: number }

// 把通知回答里的链接解析为网页或本地文件；CLI 常写 /D:/a.txt、file:///、相对路径及 :行号 / #L行号。
export function noticeLinkTarget(href: string, workspace: string): NoticeLinkTarget | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', url: raw }
  let value = raw.replace(/^file:\/\//i, '')
  try { value = decodeURIComponent(value) } catch { /* 保留原文 */ }
  let lineNumber: number | undefined
  const suffix = value.match(/(?:#L(\d+)(?:C\d+)?(?:-L?\d+)?|:(\d+)(?::\d+)?)$/i)
  if (suffix) {
    lineNumber = Number(suffix[1] ?? suffix[2]) || undefined
    value = value.slice(0, -suffix[0].length)
  }
  value = value.replace(/\\/g, '/').replace(/^\/+(?=[A-Za-z]:\/)/, '')
  // 盘符只有一个字母；其他 scheme（mailto:、vscode:// 等）不在通知内处理。
  if (!value || /^[a-z][a-z\d+.-]+:/i.test(value)) return null
  if (!/^[A-Za-z]:\//.test(value) && !value.startsWith('/')) {
    const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!root) return null
    value = `${root}/${value.replace(/^\.\//, '')}`
  }
  return { kind: 'file', path: value, lineNumber }
}

export function conversationColor(id: string): string {
  const colors = ['blue', 'green', 'yellow', 'red', 'purple']
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(id)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return `var(--color-accent-${colors[Number(hash % BigInt(colors.length))]})`
}
