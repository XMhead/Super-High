export interface PreviewEvent<T> {
  event: string
  id: number
  payload: T
}

export type PreviewUnlistenFn = () => void

type PreviewHandler = (event: PreviewEvent<unknown>) => void

const handlers = new Map<string, Set<PreviewHandler>>()
let sequence = 0

function dispatch(event: string, payload: unknown) {
  const listeners = handlers.get(event)
  if (!listeners) return
  for (const handler of [...listeners]) {
    try {
      handler({ event, id: ++sequence, payload })
    } catch (error) {
      console.error('预览事件处理失败', event, error)
    }
  }
}

/** 浏览器预览里代替 Tauri 事件总线：同页注册的监听都能收到模拟事件。 */
export function emitPreviewEvent(event: string, payload?: unknown) {
  dispatch(event, payload)
}

export async function listen<T>(event: string, handler: (event: PreviewEvent<T>) => void): Promise<PreviewUnlistenFn> {
  const target = handler as PreviewHandler
  const listeners = handlers.get(event) ?? new Set<PreviewHandler>()
  listeners.add(target)
  handlers.set(event, listeners)
  return () => { listeners.delete(target) }
}

export async function once<T>(event: string, handler: (event: PreviewEvent<T>) => void): Promise<PreviewUnlistenFn> {
  const unlisten = await listen<T>(event, (received) => {
    void unlisten()
    handler(received)
  })
  return unlisten
}

export async function emit(event: string, payload?: unknown) {
  emitPreviewEvent(event, payload)
}

export async function emitTo(_target: string, event: string, payload?: unknown) {
  emitPreviewEvent(event, payload)
}

export function resetPreviewEvents() {
  handlers.clear()
}
