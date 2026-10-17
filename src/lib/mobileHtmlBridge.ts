export interface MobileHtmlDocument {
  document: string
  contextMessages: unknown[]
}

type HtmlRequest = { path: string; operation: string; data?: Record<string, unknown> }
type HtmlEvent = CustomEvent<{ request: HtmlRequest; resolve: (value: unknown) => void; reject: (error: Error) => void; claim: () => void }>
const EVENT = 'superhigh:mobile-html'
const pending = new Map<string, (data: Record<string, unknown>) => void>()
let sequence = 0

// Keep the existing desktop HTML handlers as the single implementation.
export function replyMobileHtml(data: Record<string, unknown>): boolean {
  const reply = typeof data.requestId === 'string' && pending.get(data.requestId)
  if (!reply) return false
  reply(data)
  return true
}

export function requestMobileHtml(request: HtmlRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let claimed = false
    const timer = setTimeout(() => reject(new Error('当前电脑未显示该 HTML 预览。')), 25000)
    window.dispatchEvent(new CustomEvent(EVENT, { detail: {
      request,
      resolve: (value: unknown) => { claimed = true; clearTimeout(timer); resolve(value) },
      reject: (error: Error) => { claimed = true; clearTimeout(timer); reject(error) },
      claim: () => { claimed = true },
    } }))
    if (!claimed) { clearTimeout(timer); reject(new Error('当前电脑未显示该 HTML 预览。')) }
  })
}

export function registerMobileHtmlPreview(
  path: () => string | undefined,
  document: () => MobileHtmlDocument | Promise<MobileHtmlDocument>,
  message: (data: Record<string, unknown>) => Promise<void>,
) {
  const handler = async (raw: Event) => {
    const { request, resolve, reject } = (raw as HtmlEvent).detail
    if (path()?.replace(/\\/g, '/').toLowerCase() !== request.path.replace(/\\/g, '/').toLowerCase()) return
    ;(raw as HtmlEvent).detail.claim()
    try {
      if (request.operation === 'html-document') {
        const preview = await document()
        // srcdoc uses the mobile page's origin for the shared bootstrap asset.
        preview.document = preview.document.split(new URL('/html-preview-bootstrap.js', window.location.href).href).join('/mobile/html-preview-bootstrap.js')
        resolve(preview)
      } else {
        const data = request.data ?? {}
        if (typeof data.requestId !== 'string') { await message(data); resolve(null); return }
        const id = `mobile-html-${++sequence}`
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('HTML 宿主响应超时。')) }, 24000)
        pending.set(id, result => {
          clearTimeout(timer)
          pending.delete(id)
          resolve({ ...result, requestId: data.requestId })
        })
        try { await message({ ...data, requestId: id }) }
        catch (error) { clearTimeout(timer); pending.delete(id); throw error }
      }
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
