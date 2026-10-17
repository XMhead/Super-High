import { normalizePath } from '@/lib/path'

export const HTML_PREVIEW_RESOURCE_MESSAGE = 'superhigh-editor:resource'
export const HTML_PREVIEW_RESOURCE_RESULT_MESSAGE = 'superhigh-editor:resource-result'
export const HTML_PREVIEW_RESOURCE_ERROR_MESSAGE = 'superhigh-editor:resource-error'
export const HTML_PREVIEW_DOWNLOAD_MESSAGE = 'superhigh-editor:download'

function isRelativeResource(value: string) {
  const trimmed = value.trim()
  return !!trimmed
    && !trimmed.startsWith('#')
    && !trimmed.startsWith('/')
    && !trimmed.startsWith('\\')
    && !/^[a-z][a-z\d+.-]*:/i.test(trimmed)
    && !trimmed.startsWith('//')
}

export function resolveHtmlPreviewResourcePath(documentPath: string, resourcePath: string) {
  if (!isRelativeResource(resourcePath)) return null
  const source = normalizePath(documentPath).replace(/\/+$/, '')
  const separator = source.lastIndexOf('/')
  if (separator < 0) return null
  const base = source.slice(0, separator)
  const cleanResource = resourcePath.replace(/\\/g, '/').split(/[?#]/, 1)[0]
  if (!cleanResource) return null
  const segments = normalizePath(`${base}/${cleanResource}`).split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (resolved.length && !resolved[resolved.length - 1].endsWith(':')) resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  const candidate = resolved.join('/').replace(/\/+$/, '')
  if (!candidate || candidate === base || !candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null
  return candidate
}

export function buildHtmlPreviewResourceBridge(documentPath: string) {
  const baseDirectory = normalizePath(documentPath).replace(/\/[^/]*$/, '')
  return `
(() => {
  const RESOURCE = '${HTML_PREVIEW_RESOURCE_MESSAGE}';
  const RESULT = '${HTML_PREVIEW_RESOURCE_RESULT_MESSAGE}';
  const ERROR = '${HTML_PREVIEW_RESOURCE_ERROR_MESSAGE}';
  const baseDirectory = ${JSON.stringify(baseDirectory)};
  const pending = new Map();
  const relative = (value) => {
    const text = String(value || '').trim();
    return text && !text.startsWith('#') && !text.startsWith('/') && !text.startsWith('\\\\')
      && !/^[a-z][a-z\\d+.-]*:/i.test(text) && !text.startsWith('//');
  };
  const request = (image, value) => {
    if (!relative(value) || image.dataset.superhighResourceRequested === value) return;
    const requestId = (globalThis.crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : String(Date.now()) + Math.random();
    image.dataset.superhighResourceRequested = value;
    pending.set(requestId, { image, value });
    window.parent.postMessage({ type: RESOURCE, requestId, path: value, baseDirectory }, '*');
  };
  const scan = (root) => {
    if (root instanceof HTMLImageElement) request(root, root.getAttribute('src') || '');
    if (root.querySelectorAll) root.querySelectorAll('img[src]').forEach((image) => request(image, image.getAttribute('src') || ''));
  };
  window.addEventListener('message', ({ data }) => {
    if (!data || (data.type !== RESULT && data.type !== ERROR)) return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    const { image, value } = entry;
    if (image.getAttribute('src') !== value) return;
    delete image.dataset.superhighResourceRequested;
    if (data.type === RESULT && typeof data.dataUrl === 'string' && data.dataUrl) image.src = data.dataUrl;
  });
  const download = (anchor) => {
    if (!anchor || !anchor.hasAttribute('download') || !/^(blob:|data:)/i.test(anchor.href)) return false;
    fetch(anchor.href).then((response) => response.blob()).then((blob) => {
      const reader = new FileReader();
      reader.onload = () => window.parent.postMessage({ type: '${HTML_PREVIEW_DOWNLOAD_MESSAGE}', fileName: anchor.download || 'download', dataUrl: reader.result }, '*');
      reader.onerror = () => console.error('HTML preview download:', reader.error);
      reader.readAsDataURL(blob);
    }).catch((error) => console.error('HTML preview download:', error));
    return true;
  };
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    if (!this.isConnected && download(this)) return;
    return originalClick.call(this);
  };
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[download]') : null;
    if (!event.defaultPrevented && download(anchor)) event.preventDefault();
  }, true);
  document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  new MutationObserver((records) => records.forEach((record) => {
    if (record.type === 'attributes') scan(record.target);
    else record.addedNodes.forEach((node) => { if (node instanceof Element) scan(node); });
  })).observe(document.documentElement, { attributes: true, attributeFilter: ['src'], childList: true, subtree: true });
  window.parent.postMessage({ type: 'superhigh-editor:resource-ready' }, '*');
})();`
}

export async function saveHtmlPreviewDownload(
  documentPath: string,
  data: { fileName?: unknown; dataUrl?: unknown },
  files: { pickSaveFilePath: (path: string) => Promise<string | null>; saveDownloadDataUrl: (path: string, dataUrl: string) => Promise<string> },
) {
  if (typeof data.dataUrl !== 'string' || !/^data:[^,]*;base64,/.test(data.dataUrl)) throw new Error('HTML 下载内容无效。')
  const fileName = (typeof data.fileName === 'string' ? data.fileName : 'download').split(/[\\/]/).pop() || 'download'
  const source = normalizePath(documentPath)
  const directory = source.slice(0, source.lastIndexOf('/'))
  const path = await files.pickSaveFilePath(`${directory}/${fileName}`)
  if (!path) return null
  return files.saveDownloadDataUrl(path, data.dataUrl)
}
