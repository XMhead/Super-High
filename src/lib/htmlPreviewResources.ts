import { normalizePath } from '@/lib/path'
import { buildHtmlPreviewStorageBridge } from './htmlPreviewStorage'

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

// Resolve page assets before the sandbox starts executing scripts. Keeping
// them in the document preserves parser order and DOMContentLoaded semantics.
export async function inlineHtmlPreviewAssets(source: string, documentPath: string, files: {
  readFile: (path: string) => Promise<string>
  readMediaAsDataUrl: (path: string) => Promise<string>
}, scopeRoot?: string) {
  const document = new DOMParser().parseFromString(source, 'text/html')
  const resolve = (from: string, value: string, allowMediaOutsideScope = false) => {
    return resolveHtmlPreviewResourcePath(from, value, scopeRoot || normalizePath(documentPath).replace(/\/[^/]*$/, ''), allowMediaOutsideScope)
  }
  const css = async (text: string, from: string, visited: Set<string>): Promise<string> => {
    // Inline imports first, then resolve URLs relative to their stylesheet.
    const imports = [...text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/gi)]
    for (const match of imports) {
      const path = resolve(from, match[1]!)
      if (!path) continue
      if (visited.has(path)) { text = text.replace(match[0], ''); continue }
      const next = new Set(visited).add(path)
      const content = await css(await files.readFile(path), path, next)
      text = text.replace(match[0], () => match[2]?.trim() ? `@media ${match[2]}{${content}}` : content)
    }
    const urls = [...text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)]
    for (const match of urls) {
      const path = resolve(from, match[2]!.trim(), true)
      if (path) {
        const dataUrl = await files.readMediaAsDataUrl(path)
        text = text.replace(match[0], () => `url("${dataUrl}")`)
      }
    }
    return text
  }
  for (const element of document.querySelectorAll('script[src], link[rel="stylesheet"][href], style')) {
    if (element.tagName === 'SCRIPT') {
      const path = resolve(documentPath, element.getAttribute('src') ?? '')
      if (!path) continue
      element.textContent = (await files.readFile(path)).replace(/<\/script/gi, '<\\/script')
      element.removeAttribute('src')
    } else if (element.tagName === 'LINK') {
      const path = resolve(documentPath, element.getAttribute('href') ?? '')
      if (!path) continue
      const style = document.createElement('style')
      if (element.hasAttribute('media')) style.setAttribute('media', element.getAttribute('media')!)
      style.textContent = (await css(await files.readFile(path), path, new Set([path]))).replace(/<\/style/gi, '<\\/style')
      element.replaceWith(style)
    } else {
      element.textContent = (await css(element.textContent ?? '', documentPath, new Set())).replace(/<\/style/gi, '<\\/style')
    }
  }
  return `<!doctype html>\n${document.documentElement.outerHTML}`
}

export function resolveHtmlPreviewResourcePath(documentPath: string, resourcePath: string, scopeRoot?: string, allowMediaOutsideScope = false) {
  let resource = resourcePath.trim()
  if (/^file:/i.test(resource)) {
    if (!scopeRoot && !allowMediaOutsideScope) return null
    try {
      const url = new URL(resource)
      if (url.hostname) return null
      resource = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1')
    } catch { return null }
  } else {
    try { resource = decodeURIComponent(resource.split(/[?#]/, 1)[0]!) } catch { return null }
  }
  const absolute = /^[a-z]:[\\/]/i.test(resource)
  if (!isRelativeResource(resource) && !((scopeRoot || allowMediaOutsideScope) && absolute)) return null
  const source = normalizePath(documentPath).replace(/\/+$/, '')
  const separator = source.lastIndexOf('/')
  if (separator < 0) return null
  const directory = source.slice(0, separator)
  const workspace = normalizePath(scopeRoot || '').replace(/\/+$/, '')
  // System/global editor pages live outside the workspace. Their own assets
  // remain readable beside the explicitly opened document.
  const base = workspace && source.toLowerCase().startsWith(`${workspace.toLowerCase()}/`) ? workspace : directory
  const cleanResource = resource.replace(/\\/g, '/')
  if (!cleanResource) return null
  const segments = normalizePath(absolute ? cleanResource : `${directory}/${cleanResource}`).split('/')
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
  if (!candidate || (!allowMediaOutsideScope && (candidate === base || !candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`)))) return null
  return candidate
}

export function buildHtmlPreviewResourceBridge(documentPath: string) {
  const baseDirectory = normalizePath(documentPath).replace(/\/[^/]*$/, '')
  return buildHtmlPreviewStorageBridge(documentPath) + `
(() => {
  const RESOURCE = '${HTML_PREVIEW_RESOURCE_MESSAGE}';
  const RESULT = '${HTML_PREVIEW_RESOURCE_RESULT_MESSAGE}';
  const ERROR = '${HTML_PREVIEW_RESOURCE_ERROR_MESSAGE}';
  const baseDirectory = ${JSON.stringify(baseDirectory)};
  const pending = new Map();
  const relative = (value) => {
    const text = String(value || '').trim();
    return /^file:/i.test(text) || /^[a-z]:[\\\\/]/i.test(text) || (text && !text.startsWith('#') && !text.startsWith('/') && !text.startsWith('\\\\')
      && !/^[a-z][a-z\\d+.-]*:/i.test(text) && !text.startsWith('//'));
  };
  const requestResource = (value, kind) => new Promise((resolve, reject) => {
    const requestId = (globalThis.crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : String(Date.now()) + Math.random();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('HTML resource timed out: ' + value)); }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type: RESOURCE, requestId, path: value, kind, baseDirectory }, '*');
  });
  const nativeFetch = window.fetch && window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!relative(value)) return nativeFetch(input, init);
    const method = init && init.method || input && input.method || 'GET';
    if (method.toUpperCase() !== 'GET') throw new TypeError('Local HTML resources only support GET');
    if (init && init.signal && init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const data = await requestResource(value, 'text');
    return new Response(data.text, { status: 200, headers: { 'Content-Type': /\\.json(?:[?#]|$)/i.test(value) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' } });
  };
  const request = (image, value) => {
    if (!relative(value) || image.dataset.superhighResourceRequested === value) return;
    image.dataset.superhighResourceRequested = value;
    requestResource(value, 'media').then((data) => {
      if (image.getAttribute('src') === value && typeof data.dataUrl === 'string' && data.dataUrl) image.src = data.dataUrl;
    }).catch((error) => console.error('HTML preview image:', error)).finally(() => {
      if (image.dataset.superhighResourceRequested === value) delete image.dataset.superhighResourceRequested;
    });
  };
  const requestSrcset = (image) => {
    const value = image.getAttribute('srcset') || '';
    if (!value || image.dataset.superhighSrcsetRequested === value) return;
    const entries = [...value.matchAll(/(^|,\\s*)(data:[^\\s]+|[^,\\s]+)(\\s+[^,]*)?/gi)];
    if (!entries.some((entry) => relative(entry[2]))) return;
    image.dataset.superhighSrcsetRequested = value;
    Promise.all(entries.map(async (entry) => {
      if (!relative(entry[2])) return entry[0];
      try {
        const data = await requestResource(entry[2], 'media');
        return entry[1] + data.dataUrl + (entry[3] || '');
      } catch (error) { console.error('HTML preview image:', error); return entry[0]; }
    })).then((parts) => {
      const result = parts.join('');
      if (result !== value && image.getAttribute('srcset') === value) image.setAttribute('srcset', result);
    }).finally(() => {
      if (image.dataset.superhighSrcsetRequested === value) delete image.dataset.superhighSrcsetRequested;
    });
  };
  const scan = (root) => {
    const scanImage = (image) => { request(image, image.getAttribute('src') || ''); requestSrcset(image); };
    if (root instanceof HTMLImageElement) scanImage(root);
    else if (root instanceof HTMLSourceElement) requestSrcset(root);
    if (root.querySelectorAll) root.querySelectorAll('img[src], img[srcset]').forEach(scanImage);
    if (root.querySelectorAll) root.querySelectorAll('picture source[srcset]').forEach(requestSrcset);
  };
  window.addEventListener('message', ({ data, source }) => {
    if (source !== window.parent) return;
    if (!data || (data.type !== RESULT && data.type !== ERROR)) return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    if (data.type === ERROR) entry.reject(new Error(data.error || 'HTML resource failed'));
    else entry.resolve(data);
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  else scan(document);
  new MutationObserver((records) => records.forEach((record) => {
    if (record.type === 'attributes') scan(record.target);
    else record.addedNodes.forEach((node) => { if (node instanceof Element) scan(node); });
  })).observe(document.documentElement, { attributes: true, attributeFilter: ['src', 'srcset'], childList: true, subtree: true });
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
