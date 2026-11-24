import { reactive } from 'vue'
import type { PlanRequest } from './cliCompletion'

export interface CliQuestionDraft {
  choices: Record<string, string>
  notes: Record<string, string>
  multi: Record<string, string[]>
}
export const emptyQuestionDraft = (): CliQuestionDraft => ({ choices: {}, notes: {}, multi: {} })
export const questionRequestKey = (request: PlanRequest) => JSON.stringify([request.connection, request.requestId])

// Memory only: changing chat/work mode must not discard an unfinished answer.
// Successful snapshots and replies remove obsolete drafts, including secrets.
const sessions = new Map<string, ReturnType<typeof createSessionQuestions>>()
function createSessionQuestions() {
  return reactive({ requests: [] as PlanRequest[], drafts: {} as Record<string, CliQuestionDraft>, submitting: '', error: '', pollError: '', confirmed: false, revision: 0 })
}
export function sessionQuestions(id: string) {
  let state = sessions.get(id)
  if (!state) { state = createSessionQuestions(); sessions.set(id, state) }
  return state
}
