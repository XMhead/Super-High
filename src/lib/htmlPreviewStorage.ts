import { normalizePath } from './path'

export const HTML_PREVIEW_STORAGE_MESSAGE = 'superhigh-html:storage'

function storageKey(path: string) {
  return `superhigh:html-storage:${normalizePath(path).toLowerCase()}`
}

export function persistHtmlPreviewStorage(path: string, data: unknown) {
  if (!data || typeof data !== 'object') return false
  const message = data as { type?: unknown; entries?: unknown }
  if (message.type !== HTML_PREVIEW_STORAGE_MESSAGE) return false
  if (!message.entries || typeof message.entries !== 'object' || Array.isArray(message.entries)) return true
  const entries = Object.entries(message.entries)
  if (entries.some(([, value]) => typeof value !== 'string')) return true
  window.localStorage.setItem(storageKey(path), JSON.stringify(Object.fromEntries(entries)))
  return true
}

// Opaque sandbox origins cannot access Web Storage. Keep the sandbox isolated
// while providing the standard synchronous API with per-document persistence.
export function buildHtmlPreviewStorageBridge(path: string) {
  let entries = '{}'
  try { entries = JSON.stringify(JSON.parse(window.localStorage.getItem(storageKey(path)) ?? '{}')) } catch {}
  return `;(() => {
    const createStorage = (initial, persist) => {
      const data = new Map(Object.entries(initial));
      const save = () => { if (persist) window.parent.postMessage({ type: '${HTML_PREVIEW_STORAGE_MESSAGE}', entries: Object.fromEntries(data) }, '*'); };
      const api = {
        get length() { return data.size; },
        key(index) { return [...data.keys()][Number(index)] ?? null; },
        getItem(key) { return data.get(String(key)) ?? null; },
        setItem(key, value) { data.set(String(key), String(value)); save(); },
        removeItem(key) { data.delete(String(key)); save(); },
        clear() { data.clear(); save(); }
      };
      return new Proxy(api, {
        get(target, key) { return key in target ? Reflect.get(target, key) : data.get(String(key)); },
        set(_target, key, value) { api.setItem(key, value); return true; },
        deleteProperty(_target, key) { api.removeItem(key); return true; },
        ownKeys() { return [...data.keys()]; },
        getOwnPropertyDescriptor(_target, key) { return data.has(String(key)) ? { configurable: true, enumerable: true, writable: true, value: data.get(String(key)) } : undefined; }
      });
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: createStorage(${entries.replace(/</g, '\\u003c')}, true) });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: createStorage({}, false) });
  })();`
}
