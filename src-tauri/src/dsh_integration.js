(() => {
  const aliases = {
    '--dsw-alias-bg-base': '--color-bg-primary', '--dsw-alias-bg-layer-1': '--color-bg-secondary',
    '--dsw-alias-bg-layer-2': '--color-bg-tertiary', '--dsw-alias-bg-layer-3': '--color-bg-tertiary',
    '--dsw-alias-bg-layer-4': '--color-bg-hover', '--dsw-alias-bg-module-platform': '--color-bg-secondary',
    '--dsw-alias-bg-skeleton': '--color-bg-hover', '--dsw-alias-border-l1': '--color-border',
    '--dsw-alias-border-l2': '--color-border', '--dsw-alias-border-l2-darkmode-thin': '--color-border',
    '--dsw-alias-border-l3': '--color-border', '--dsw-alias-border-l4': '--color-border',
    '--dsw-alias-label-primary': '--color-text-primary', '--dsw-alias-label-secondary': '--color-text-secondary',
    '--dsw-alias-label-tertiary': '--color-text-muted', '--dsw-alias-label-caption': '--color-text-muted',
    '--dsw-alias-label-dimmed': '--color-text-muted', '--dsw-alias-brand-primary': '--color-accent-blue',
    '--dsw-alias-state-business-primary': '--color-accent-blue', '--dsw-alias-link': '--color-accent-blue',
    '--dsw-alias-state-error-primary': '--color-accent-red', '--dsw-alias-label-error': '--color-accent-red',
    '--dsw-alias-state-success-primary': '--color-accent-green', '--dsw-alias-state-warn-primary': '--color-accent-yellow',
    '--dsw-alias-interactive-bg-hover': '--color-bg-hover', '--dsw-alias-interactive-bg-hover-solid': '--color-bg-hover',
    '--dsw-alias-interactive-bg-active': '--color-bg-tertiary', '--dsw-alias-markdown-code-block': '--color-bg-secondary',
    '--dsw-alias-markdown-inline-code': '--color-bg-tertiary', '--dsw-alias-scrollbar-bg-l2': '--color-border',
    '--dsw-alias-scrollbar-hover-l2': '--color-accent-blue', '--dsw-alias-button-primary-fill': '--color-accent-blue',
    '--dsw-alias-button-primary-hover': '--color-accent-blue', '--dsw-alias-toast-bg': '--color-bg-secondary',
    '--dsw-alias-tooltip-bg': '--color-bg-tertiary', '--dsw-alias-button-elevated-fill': '--color-bg-tertiary',
    '--dsw-alias-button-floating-fill': '--color-bg-tertiary', '--dsw-alias-button-floating-hover': '--color-bg-hover',
    '--dsw-alias-button-tool-bar-fill': '--color-bg-secondary', '--dsw-alias-button-tool-bar-hover': '--color-bg-hover',
    '--dsw-alias-button-ghost-active-fill': '--color-bg-hover', '--dsw-alias-button-ghost-active-hover': '--color-bg-hover',
    '--dsw-alias-button-ghost-active-border': '--color-border', '--dsw-alias-settings-card-fill': '--color-bg-secondary',
    '--dsw-alias-settings-card-stroke': '--color-border', '--dsw-alias-bg-overlay': '--color-bg-secondary',
    '--dsw-alias-bg-l1': '--color-bg-secondary', '--dsw-alias-fill-l1': '--color-bg-secondary',
    '--dsw-alias-fill-l2': '--color-bg-tertiary', '--dsw-alias-fill-tertiary': '--color-bg-hover',
    '--dsw-alias-menu-group-header-fill': '--color-bg-secondary', '--dsw-alias-markdown-code-block-banner': '--color-bg-tertiary',
    '--dsw-alias-scrollbar-bg-l1': '--color-border', '--dsw-alias-scrollbar-hover-l1': '--color-accent-blue',
    '--dsw-specific-sidebar-fill': '--color-bg-secondary',
    '--dsw-specific-sidebar-nav-item-active': '--color-bg-hover', '--dsw-specific-sidebar-nav-item-active-accent': '--color-accent-blue',
    '--dsw-specific-input-major': '--color-bg-secondary', '--dsw-specific-login-input': '--color-bg-secondary',
    '--dsw-specific-bubble': '--color-bg-secondary', '--dsw-specific-bubble-highlight': '--color-bg-hover',
    '--dsw-specific-menu': '--color-bg-secondary', '--dsw-specific-selector': '--color-bg-tertiary',
    '--dsw-specific-tip': '--color-bg-secondary'
  }
  // The child WebView is opaque and DSH stacks several background layers.
  // Use the theme's RGB components so translucent glass tokens do not blend
  // repeatedly against the WebView's black backing surface.
  function opaqueSurface(value) {
    return value.replace(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i, 'rgb($1, $2, $3)')
  }
  let currentTheme = null
  function syncBodyMode() {
    if (!currentTheme || !document.body) return
    const dark = currentTheme.colorScheme === 'dark'
    if (document.body.hasAttribute('data-ds-dark-theme') !== dark) document.body.toggleAttribute('data-ds-dark-theme', dark)
  }
  window.__superhighDshSetTheme = (theme) => {
    if (theme && theme.vars) currentTheme = theme
    if (!currentTheme || !document.documentElement) return
    const root = document.documentElement
    // DSH declares theme variables on body, so inherited values on html alone
    // do not override its palette.
    for (const target of [root, document.body].filter(Boolean)) {
      for (const [name, source] of Object.entries(aliases)) {
        const value = currentTheme.vars[source]
        if (value) target.style.setProperty(name, source.startsWith('--color-bg-') ? opaqueSurface(value) : value, 'important')
      }
    }
    for (const name of ['--font-ui', '--font-content', '--font-mono']) {
      if (currentTheme.vars[name]) root.style.setProperty(name, currentTheme.vars[name])
    }
    root.style.colorScheme = currentTheme.colorScheme || 'dark'
    syncBodyMode()
  }
  let serial = 0
  const pending = new Map()
  window.__superhighDshResult = ({ request, result, error }) => {
    const target = pending.get(request)
    if (!target) return
    pending.delete(request)
    if (!target.isConnected) return
    if (error) { target.textContent = error; return }
    if (result?.source !== undefined) target.textContent = `${result.path}\n\n${result.source}`
    else target.textContent = ''
  }
  function request(action, module, target) {
    const id = String(++serial)
    pending.set(id, target)
    target.textContent = action === 'preview' ? '正在读取源码…' : '正在打开目录…'
    const link = document.createElement('a')
    link.href = `https://superhigh-dsh.local/action?${new URLSearchParams({ action, module, request: id })}`
    link.click()
  }
  function addActions() {
    document.querySelectorAll('li[data-plugin-module][data-open="true"]').forEach(card => {
      if (card.querySelector(':scope > .superhigh-dsh-actions')) return
      const module = card.getAttribute('data-plugin-module')
      if (!module) return
      const section = document.createElement('div')
      section.className = 'superhigh-dsh-actions'
      const controls = document.createElement('div')
      controls.className = 'superhigh-dsh-controls'
      const output = document.createElement('pre')
      output.className = 'superhigh-dsh-source'
      output.hidden = true
      const status = document.createElement('div')
      status.className = 'superhigh-dsh-status'
      status.setAttribute('role', 'status')
      const preview = document.createElement('button')
      preview.type = 'button'
      preview.textContent = '预览源码'
      preview.setAttribute('aria-expanded', 'false')
      preview.addEventListener('click', () => {
        output.hidden = !output.hidden
        preview.setAttribute('aria-expanded', String(!output.hidden))
        preview.textContent = output.hidden ? '预览源码' : '收起源码'
        if (!output.hidden) request('preview', module, output)
      })
      const directory = document.createElement('button')
      directory.type = 'button'
      directory.textContent = '打开目录'
      directory.addEventListener('click', () => request('directory', module, status))
      controls.append(preview, directory)
      section.append(controls, status, output)
      card.append(section)
    })
  }
  if (window.__superhighDshEditor) document.addEventListener('keydown', event => {
    if (!['F1', 'F4'].includes(event.key) || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    const link = document.createElement('a')
    link.href = `https://superhigh-dsh.local/shortcut?key=${event.key}`
    link.click()
  }, true)
  function start() {
    window.__superhighDshSetTheme(currentTheme)
    const style = document.createElement('style')
    style.textContent = `html,body,button,input,textarea,select { font-family:var(--font-ui) !important; }
      pre,code { font-family:var(--font-mono) !important; }
      button,input,textarea,select,[data-plugin-module] { border-radius:4px !important; }
      .superhigh-dsh-actions { padding:8px; border-top:1px solid var(--dsw-alias-border-l2); }
      .superhigh-dsh-controls { display:flex; gap:6px; }
      .superhigh-dsh-controls button { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); padding:3px 8px; cursor:pointer; }
      .superhigh-dsh-controls button:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .superhigh-dsh-controls button:focus-visible { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:-1px; }
      .superhigh-dsh-status:not(:empty) { margin-top:6px; color:var(--dsw-alias-label-secondary); font-size:12px; }
      .superhigh-dsh-source { white-space:pre; overflow:auto; max-height:240px; margin:8px 0 0; padding:8px; font-size:12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); }
      .superhigh-dsh-source[hidden] { display:none; }`
    document.head.append(style)
    addActions()
    new MutationObserver(addActions).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['data-open'] })
    new MutationObserver(syncBodyMode).observe(document.body, { attributes:true, attributeFilter:['data-ds-dark-theme'] })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true })
  else start()
})()
