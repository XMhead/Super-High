;(() => {
  const script = new URL(document.currentScript.src)
  const originalFetch = window.fetch.bind(window)
  const revisionUrl = new URL('./revision', script)
  const initialRevision = script.searchParams.get('revision')
  const nav = window.navigation
  const embedded = window.parent !== window && window.parent === window.top

  function report() {
    if (!embedded) return
    window.parent.postMessage({
      type: 'superhigh-html:navigation',
      url: location.href,
      canGoBack: nav?.canGoBack ?? false,
      canGoForward: nav?.canGoForward ?? false,
    }, '*')
  }

  if (embedded) {
    nav?.addEventListener('currententrychange', report)
    addEventListener('pageshow', report)
    addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.type !== 'superhigh-html:navigate') return
      const { action, url } = event.data
      if (action === 'report') report()
      if (action === 'back' && nav?.canGoBack) nav.back()
      if (action === 'forward' && nav?.canGoForward) nav.forward()
      if (action === 'reload') location.reload()
      if (action === 'open') {
        const target = new URL(url, location.href)
        if (target.origin === location.origin) location.assign(target)
      }
    })
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0) return
      const anchor = event.composedPath().find(element => element instanceof HTMLAnchorElement)
      if (!anchor || anchor.hasAttribute('download') || !anchor.hasAttribute('href')) return
      const url = new URL(anchor.href)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return
      event.preventDefault()
      window.parent.postMessage({ type: 'superhigh:open-external-url', url: url.href }, '*')
    })
    report()
  }

  // Nested documents are refreshed with their top-level preview.
  let nestedInSite = false
  try { nestedInSite = window.parent !== window && window.parent.location.origin === location.origin } catch {}
  if (nestedInSite) return
  let polling = false
  const timer = setInterval(async () => {
    if (polling || document.hidden) return
    polling = true
    try {
      const response = await originalFetch(revisionUrl)
      if (response.ok && await response.text() !== initialRevision) {
        clearInterval(timer)
        location.reload()
      }
    } catch {
      // The preview server may be unavailable while the desktop app restarts.
    } finally {
      polling = false
    }
  }, 850)
})()
