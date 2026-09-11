export const OPEN_EXTERNAL_URL_MESSAGE_TYPE = 'superhigh:open-external-url'

export interface OpenExternalUrlMessage {
  type: typeof OPEN_EXTERNAL_URL_MESSAGE_TYPE
  url: string
}

// 判断是否是交给系统浏览器处理的网页 URL。
export function isHttpExternalUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim())
}

// 从 composedPath 的节点里取 Element，兼容 Shadow DOM 事件路径。
function elementFromEventPathTarget(target: EventTarget): Element | null {
  return target instanceof Element ? target : null
}

// 从点击事件中定位最近的 a[href]，用于 Markdown 与项目编辑器 Shadow DOM。
function anchorFromClickEvent(event: MouseEvent): HTMLAnchorElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const target of path) {
    const element = elementFromEventPathTarget(target)
    if (!element) continue
    const anchor = element.closest('a[href]')
    if (anchor instanceof HTMLAnchorElement) return anchor
  }

  const target = event.target
  const element = target instanceof Element ? target : null
  const anchor = element?.closest('a[href]')
  return anchor instanceof HTMLAnchorElement ? anchor : null
}

// 提取需要外部打开的链接，本地锚点、相对路径和下载链接保持原行为。
export function urlFromExternalLinkClick(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null
  const anchor = anchorFromClickEvent(event)
  if (!anchor || anchor.hasAttribute('download')) return null
  const href = anchor.href || anchor.getAttribute('href') || ''
  return isHttpExternalUrl(href) ? href.trim() : null
}

// 捕获外部网页点击后调用后端打开系统浏览器。
export function openExternalLinkFromClick(
  event: MouseEvent,
  openUrl: (url: string) => Promise<unknown> | unknown,
): boolean {
  const url = urlFromExternalLinkClick(event)
  if (!url) return false
  event.preventDefault()
  void Promise.resolve(openUrl(url))
  return true
}

// 生成 iframe 预览发给主窗口的消息负载。
export function openExternalUrlMessage(url: string): OpenExternalUrlMessage {
  return { type: OPEN_EXTERNAL_URL_MESSAGE_TYPE, url }
}

// 校验 iframe 发来的打开网页消息。
export function urlFromExternalUrlMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const payload = data as Partial<OpenExternalUrlMessage>
  return payload.type === OPEN_EXTERNAL_URL_MESSAGE_TYPE && isHttpExternalUrl(payload.url)
    ? payload.url.trim()
    : null
}

// 注入到 sandbox iframe 的桥接脚本，避免 iframe 自己导航或弹窗。
export function buildExternalLinkBridgeScript(): string {
  return `
(() => {
  const MESSAGE_TYPE = '${OPEN_EXTERNAL_URL_MESSAGE_TYPE}';
  const isHttpUrl = (value) => typeof value === 'string' && /^https?:\\/\\/[^\\s]+$/i.test(value.trim());
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    const url = anchor.href || anchor.getAttribute('href') || '';
    if (!isHttpUrl(url)) return;
    event.preventDefault();
    window.parent.postMessage({ type: MESSAGE_TYPE, url: url.trim() }, '*');
  }, true);
})();`
}
