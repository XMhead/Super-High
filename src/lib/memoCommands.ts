import type { MemoCliRequest } from './tauri'

type MemoCommandHandler = (request: MemoCliRequest) => Promise<unknown>
let handler: MemoCommandHandler | null = null

/** Route local actions through the same save queue as the memo CLI. */
export function registerMemoCommandHandler(next: MemoCommandHandler) {
  handler = next
  return () => { if (handler === next) handler = null }
}

export function runMemoCommand(request: MemoCliRequest) {
  if (!handler) return Promise.reject(new Error('备忘录尚未就绪'))
  return handler(request)
}
