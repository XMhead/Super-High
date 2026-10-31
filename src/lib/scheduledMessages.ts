// CLI 输入框定时消息：每个会话最多预存 5 条，延时 1 分钟至 6 小时。
export const SCHEDULED_MESSAGE_MIN_MINUTES = 1
export const SCHEDULED_MESSAGE_MAX_MINUTES = 6 * 60
export const SCHEDULED_MESSAGE_LIMIT = 5

export interface ScheduledTerminalMessage {
  id: string
  sessionId: string
  text: string
  /** 计划发送时间（毫秒时间戳）。 */
  dueAt: number
}

export function scheduledDelayMinutes(hours: number, minutes: number): number | null {
  const total = Math.trunc(Number(hours) || 0) * 60 + Math.trunc(Number(minutes) || 0)
  return total >= SCHEDULED_MESSAGE_MIN_MINUTES && total <= SCHEDULED_MESSAGE_MAX_MINUTES ? total : null
}

export function formatScheduledCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function formatScheduledClock(dueAt: number): string {
  const date = new Date(dueAt)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
