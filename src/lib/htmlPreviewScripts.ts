// The release CSP permits bundled scripts but rejects dynamic inline scripts.
// The loader creates script URLs inside the sandbox's own opaque origin.
export function prepareHtmlPreviewScripts(html: string, bootstrapUrl: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const script of document.querySelectorAll('script')) {
    const type = (script.getAttribute('type') ?? '').trim().toLowerCase()
    if (type && type !== 'module' && !/^(?:text|application)\/(?:java|ecma)script$/.test(type)) continue
    script.setAttribute('data-superhigh-script-type', script.getAttribute('type') ?? '')
    script.setAttribute('type', 'application/x-superhigh-script')
  }
  const loader = document.createElement('script')
  loader.src = bootstrapUrl
  document.body.appendChild(loader)
  return `<!doctype html>\n${document.documentElement.outerHTML}`
}
