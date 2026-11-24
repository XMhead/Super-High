import bootstrapSource from './htmlPreviewBootstrap.js?raw'

// The release CSP allows this exact loader. HTML parsing normalizes line endings.
const bootstrap = bootstrapSource.replace(/\r\n?/g, '\n')

export function prepareHtmlPreviewScripts(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const script of document.querySelectorAll('script')) {
    const type = (script.getAttribute('type') ?? '').trim().toLowerCase()
    if (type && type !== 'module' && !/^(?:text|application)\/(?:java|ecma)script$/.test(type)) continue
    script.setAttribute('data-superhigh-script-type', script.getAttribute('type') ?? '')
    script.setAttribute('type', 'application/x-superhigh-script')
  }
  const loader = document.createElement('script')
  loader.id = 'superhigh-html-preview-bootstrap'
  loader.textContent = bootstrap
  document.body.appendChild(loader)
  return `<!doctype html>\n${document.documentElement.outerHTML}`
}
