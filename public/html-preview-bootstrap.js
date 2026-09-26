// Run during srcdoc parsing so script order and DOMContentLoaded keep their
// normal browser semantics. Blob URLs must belong to this sandbox's origin.
;(() => {
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
