// Run during srcdoc parsing so script order and DOMContentLoaded keep their
// normal browser semantics. Blob URLs must belong to this sandbox's origin.
;(() => {
  // Tauri adds script hashes to the release CSP, which disables inline event
  // attributes even when the source CSP contains unsafe-inline. Bind callable
  // handlers instead, including attributes inserted by the page's own scripts.
  const bindHandlers = root => {
    const nodes = root instanceof Element ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')]
    for (const node of nodes) {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase()
        if (!name.startsWith('on') || !(name in node)) continue
        node.removeAttribute(attribute.name)
        try {
          node[name] = new Function('event', `with(document){with(this.form || {}){with(this){${attribute.value}\n}}}`)
        } catch (error) {
          console.error('HTML preview event handler:', error)
        }
      }
    }
  }
  bindHandlers(document)
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.attributeName?.toLowerCase().startsWith('on')) bindHandlers(record.target)
      } else {
        for (const node of record.addedNodes) if (node instanceof Element) bindHandlers(node)
      }
    }
  }).observe(document.documentElement, { attributes: true, childList: true, subtree: true })
  const urls = new Set()
  const markup = []
  for (const placeholder of document.querySelectorAll('script[data-superhigh-script-type]')) {
    const script = document.createElement('script')
    for (const attribute of placeholder.attributes) {
      if (attribute.name !== 'type' && attribute.name !== 'data-superhigh-script-type') {
        script.setAttribute(attribute.name, attribute.value)
      }
    }
    const type = placeholder.getAttribute('data-superhigh-script-type')
    if (type) script.type = type
    if (!script.hasAttribute('src')) {
      const url = URL.createObjectURL(new Blob([placeholder.textContent || ''], { type: 'text/javascript' }))
      urls.add(url)
      script.src = url
    }
    markup.push(script.outerHTML)
    placeholder.remove()
  }
  const release = event => {
    const url = event.target?.src
    if (urls.delete(url)) URL.revokeObjectURL(url)
  }
  document.addEventListener('load', release, true)
  document.addEventListener('error', release, true)
  window.addEventListener('pagehide', () => {
    for (const url of urls) URL.revokeObjectURL(url)
    urls.clear()
  }, { once: true })
  document.write(markup.join(''))
})()
