import { normalizePath } from '@/lib/path'
import htmlPreviewLongPressBridge from './htmlPreviewLongPressBridge.js?raw'

export const HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE = 'superhigh:html-preview-long-press'
export const HTML_PREVIEW_LONG_PRESS_MS = 600

// iframe 内长按检测：按住不动超过阈值即通知主窗口，并吞掉随后的 click，避免误触页面按钮。
export function buildHtmlPreviewLongPressScript(): string {
  return htmlPreviewLongPressBridge
}

export function isHtmlPreviewLongPressMessage(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE
}

// 只把文件绝对路径（正斜杠）以纯文本插入 CLI 输入框。
export function sendHtmlPreviewPathToChat(path: string) {
  const text = normalizePath(path)
  if (!text) return
  window.dispatchEvent(new CustomEvent('superhigh:add-selection-to-chat', {
    detail: { text, insertMode: 'plain' },
  }))
}
