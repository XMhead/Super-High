import { SOURCE_SCOPE_LABELS, type SourceScope } from './sourceScopes'

export type AutomationScope = SourceScope
export type AutomationSchedule = { kind: 'once'; at: string } | { kind: 'daily'; time: string }
export type AutomationAction = { kind: 'shutdown' | 'restart' } | { kind: 'command'; command: string }

export interface AutomationTask {
  id: string
  scope: AutomationScope
  title: string
  enabled: boolean
  schedule: AutomationSchedule
  action: AutomationAction
  nextRun?: string | null
  lastRun?: string | null
  lastStatus?: string | null
  lastError?: string | null
}

export const AUTOMATION_SCOPE_LABELS = SOURCE_SCOPE_LABELS

export function automationTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function automationScheduleText(schedule: AutomationSchedule) {
  return schedule.kind === 'daily' ? `每天 ${schedule.time}` : automationTime(schedule.at)
}
