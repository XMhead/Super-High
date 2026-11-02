import { normalizePath } from '@/lib/path'

export const HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE = 'superhigh:html-preview-long-press'
export const HTML_PREVIEW_LONG_PRESS_MS = 600

// iframe 内长按检测：按住不动超过阈值即通知主窗口，并吞掉随后的 click，避免误触页面按钮。
export function buildHtmlPreviewLongPressScript(): string {
  return `
(() => {
  const MESSAGE_TYPE = '${HTML_PREVIEW_LONG_PRESS_MESSAGE_TYPE}';
  const DELAY = ${HTML_PREVIEW_LONG_PRESS_MS};
  const TOLERANCE = 6;
  let timer = 0;
  let start = null;
  let suppressClick = false;
  const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
  document.addEventListener('pointerdown', (event) => {
    cancel();
    suppressClick = false;
    if (event.button !== 0 || !event.isPrimary) return;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = 0;
      start = null;
      suppressClick = true;
      window.parent.postMessage({ type: MESSAGE_TYPE }, '*');
    }, DELAY);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TOLERANCE) cancel();
  }, true);
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})();`
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
