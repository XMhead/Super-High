import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export const FIELD_CONSUMERS = {
  complete: { 'superhigh-html/SKILL.md': 'Choose whether further evidence is required before diagnosing the feature.' },
  errors: { 'superhigh-html/SKILL.md': 'Distinguish connection, permission and unavailable-frame failures.' },
  view: { 'superhigh-html/SKILL.md': 'Interpret the selected HTML, IUI, chat, theme or notification evidence.' },
  frames: { 'superhigh-html/SKILL.md': 'Locate broken images, media errors and missing model canvases in the target frame.' },
  frameTotal: { 'superhigh-html/SKILL.md': 'Check how many frames belong to the selected view.' },
  remainingFrames: { 'superhigh-html/SKILL.md': 'Increase the limit or narrow the frame selection when coverage was capped.' },
  notices: { 'superhigh-html/SKILL.md': 'Distinguish missing windows from hidden native notifications.' },
  chat: { 'superhigh-html/references/chat-history.md': 'Check rendered history, read-only mode, tool details and panel alignment before selecting the next UI action.' },
  'chat.receipts': { 'superhigh-html/references/chat-history.md': 'Check native and supplemental message counts, outstanding confirmations and draft length during mid-turn and late-receipt acceptance.' },
  'chat.runtime': { 'superhigh-html/references/chat-history.md': 'Check terminalHosts, mountedTerminals and loadedTerminalResources on chat startup and after switching modes; null resource counts require another collection method.' },
  'chat.questions': { 'superhigh-html/references/chat-history.md': 'Check visible forms and disabledSubmits before answering and after native acknowledgement; verify answer content in the native session.' },
  theme: { 'superhigh-html/SKILL.md': 'Compare the actual target element and its background layers with host theme tokens and identify overrides.' },
  elements: { 'superhigh-html/SKILL.md': 'Read selected iframe form values and geometry to verify parameter updates and retained page input.' },
  remainingElements: { 'superhigh-html/SKILL.md': 'Narrow the selector or increase the bound before judging the selected elements.' },
  terminal: { 'superhigh-html/references/terminal-rendering.md': 'Check the active renderer and fallback, disposed hosts, canvas scaling and loaded Wraith Wasm before accepting a renderer change.' },
}

export function snapshotTheme(selector, token, limit, document) {
  const target = document.querySelector(selector)
  if (!target) return null
  const window = document.defaultView
  const styleOf = element => window.getComputedStyle(element)
  const targetStyle = styleOf(target)
  const rootStyle = styleOf(document.documentElement)
  const layers = []
  let node = target
  while (node && layers.length < limit) {
    const style = styleOf(node)
    layers.push({ tag: node.tagName.toLowerCase(), background: style.backgroundColor,
      backgroundImage: style.backgroundImage && style.backgroundImage !== 'none' ? 'present' : 'none', opacity: style.opacity })
    node = node.parentElement
  }
  return { title: document.title, theme: { selector, token: token || null,
    rootToken: token ? rootStyle.getPropertyValue(token).trim() : null,
    targetToken: token ? targetStyle.getPropertyValue(token).trim() : null,
    background: targetStyle.backgroundColor, foreground: targetStyle.color,
    colorScheme: targetStyle.colorScheme, layers, remainingLayers: Boolean(node) } }
}

export function snapshotElement(selector, limit, document) {
  const elements = [...document.querySelectorAll(selector)]
  if (!elements.length) return null
  return { title: document.title, elements: elements.slice(0, limit).map(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    const style = document.defaultView.getComputedStyle(element)
    return { tag: element.tagName.toLowerCase(), id: element.id || null,
      visible: width > 0 && height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      text: element.textContent.slice(0, 160),
      value: element.type !== 'password' && typeof element.value === 'string' ? element.value.slice(0, 160) : null,
      rect: { x, y, width, height } }
  }), remainingElements: Math.max(0, elements.length - limit) }
}

export function snapshotTerminal(selector, limit, document) {
  const window = document.defaultView
  const visible = element => Boolean(element.getClientRects().length
    && window.getComputedStyle(element).visibility !== 'hidden' && window.getComputedStyle(element).display !== 'none')
  const rect = element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  }
  const hosts = [...document.querySelectorAll(selector)]
  const resources = typeof window.performance?.getEntriesByType === 'function' ? window.performance.getEntriesByType('resource') : null
  const wasm = resources?.filter(resource => /\/wraith[^/?#]*\.wasm(?:[?#]|$)/i.test(resource.name)) ?? []
  return { title: document.title, terminal: {
    selector, secureContext: window.isSecureContext ?? null, gpuAvailable: Boolean(window.navigator?.gpu),
    devicePixelRatio: window.devicePixelRatio, viewport: { width: window.innerWidth, height: window.innerHeight },
    hostTotal: hosts.length, remainingHosts: Math.max(0, hosts.length - limit),
    hosts: hosts.slice(0, limit).map(host => {
      const canvases = [...host.querySelectorAll('canvas')]
      return { visible: visible(host), mounted: Boolean(host.querySelector('.xterm')),
        renderer: host.dataset.terminalRenderer ?? null, fallbackReason: host.dataset.terminalRendererFallback ?? null,
        rect: rect(host), canvasTotal: canvases.length, remainingCanvases: Math.max(0, canvases.length - limit),
        canvases: canvases.slice(0, limit).map(canvas => ({ visible: visible(canvas),
          pixels: { width: canvas.width, height: canvas.height }, rect: rect(canvas) })) }
    }),
    wasm: { observed: resources !== null, total: wasm.length, remaining: Math.max(0, wasm.length - limit),
      resources: wasm.slice(0, limit).map(resource => ({
        asset: resource.name.split(/[?#]/)[0].split('/').at(-1), decodedBytes: resource.decodedBodySize ?? null,
      })) },
  } }
}

export function snapshotChat(limit, document) {
  const root = document.querySelector('.chat-workspace')
  if (!root) return null
  const window = document.defaultView
  const visible = element => Boolean(element && element.getClientRects().length
    && window.getComputedStyle(element).visibility !== 'hidden' && window.getComputedStyle(element).display !== 'none')
  if (!visible(root)) return null
  const rect = element => {
    if (!visible(element)) return null
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  }
  const history = root.querySelector('.cli-chat--history')
  const active = history ?? [...root.querySelectorAll('.cli-chat')].find(visible)
  const pendingMessages = [...active?.querySelectorAll('.cli-chat-pending') ?? []]
  const rows = [...root.querySelectorAll('.chat-history-row')]
  const errors = [...root.querySelectorAll('.chat-history-error,.cli-chat-error,.cli-session-questions [role="alert"]')].filter(visible)
  const questionForms = [...active?.querySelectorAll('.cli-session-questions form') ?? []].filter(visible)
  const resources = typeof window.performance?.getEntriesByType === 'function' ? window.performance.getEntriesByType('resource') : null
  const sidebar = root.querySelector('.chat-history-sidebar')
  const provider = root.querySelector('[aria-label="筛选智能体"]')
  const preview = document.querySelector('.chat-workspace-preview')
  const search = document.querySelector('.command-search')
  const sort = document.querySelector('.search-sort-select')
  const previewRect = rect(preview)
  return { title: document.title, chat: {
    scope: 'rendered-chat-dom', mode: history ? 'history' : active ? 'live' : 'native-or-empty',
    providerFilter: provider?.value ?? null,
    runtime: {
      terminalHosts: root.querySelectorAll('.terminal-host').length,
      mountedTerminals: root.querySelectorAll('.xterm').length,
      loadedTerminalResources: resources ? resources.filter(resource => /\/(?:xterm[.-]|wraith_engine[._-]|addon-(?:fit|serialize|webgl)[.-])/i.test(resource.name)).length : null,
    },
    questions: { forms: questionForms.length,
      disabledSubmits: questionForms.filter(form => form.querySelector('button[type="submit"]')?.disabled).length },
    sidebar: { visible: visible(sidebar), renderedGroups: root.querySelectorAll('.chat-history-group').length,
      renderedRows: rows.length, renderedLiveRows: rows.filter(row => row.querySelector('small')).length },
    content: { renderedTurns: active?.querySelectorAll('.cli-chat-turn:not(.cli-chat-pending)').length ?? 0,
      answerCharacters: [...active?.querySelectorAll('.cli-chat-answer-body') ?? []].reduce((sum, item) => sum + item.textContent.length, 0),
      expandedSteps: active?.querySelectorAll('.cli-chat-step-disclosure').length ?? 0,
      outputCharacters: [...active?.querySelectorAll('.cli-chat-step-output') ?? []].reduce((sum, item) => sum + item.textContent.length, 0),
      earlierPageAvailable: [...active?.querySelectorAll('.cli-chat-thinking-toggle') ?? []].some(button => button.textContent.trim() === '加载更早记录') },
    receipts: {
      nativeMessages: [...active?.querySelectorAll('.cli-chat-user-bubble') ?? []].filter(element => !element.closest('.cli-chat-pending')).length,
      supplementalMessages: active?.querySelectorAll('.cli-chat-step--user .cli-chat-user-bubble').length ?? 0,
      pendingMessages: pendingMessages.length,
      unconfirmedMessages: pendingMessages.filter(element => element.querySelector('.cli-chat-note')?.textContent.trim().startsWith('暂未确认 CLI 接收')).length,
      draftCharacters: active?.querySelector('.cli-chat-input')?.value.length ?? 0,
    },
    actions: { composerVisible: visible(active?.querySelector('.cli-chat-input')),
      resumeVisible: visible(active?.querySelector('.chat-resume-button')) },
    layout: { viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      panels: { sidebar: rect(sidebar), main: rect(root.querySelector('.chat-workspace-main')), preview: previewRect },
      alignment: previewRect ? { previewLeft: previewRect.x, searchLeft: rect(search)?.x ?? null,
        sortRight: visible(sort) ? sort.getBoundingClientRect().right : null } : null },
    errorTotal: errors.length, remainingErrors: Math.max(0, errors.length - limit),
    errors: errors.slice(0, limit).map(item => item.textContent.slice(0, 160)),
  } }
}
export function snapshotDom(view, limit, document) {
  const root = view === 'iui' ? document.querySelector('.shui-root') : document
  if (!root) return null
  const images = view === 'iui' ? [...root.querySelectorAll('img')] : [...document.images]
  const broken = images.filter(image => image.complete && !image.naturalWidth)
  const result = {
    title: document.title,
    images: { total: images.length, loaded: images.filter(image => image.complete && image.naturalWidth > 0).length,
      pending: images.filter(image => !image.complete).length, broken: broken.length,
      brokenLabels: broken.slice(0, limit).map(image => image.alt.slice(0, 100)) },
  }
  if (view === 'iui') {
    const media = [...root.querySelectorAll('audio,video')]
    const canvases = [...root.querySelectorAll('.shui-model canvas')]
    const issues = [...root.querySelectorAll('.shui-issue')]
    Object.assign(result, {
      mediaTotal: media.length,
      media: media.slice(0, limit).map(item => ({ kind: item.tagName, ready: item.readyState,
        duration: Number.isFinite(item.duration) ? item.duration : null, time: item.currentTime,
        paused: item.paused, ended: item.ended, error: item.error?.code ?? null })),
      modelTotal: canvases.length,
      models: canvases.slice(0, limit).map(canvas => ({ width: canvas.width, height: canvas.height })),
      issueTotal: issues.length, issues: issues.slice(0, limit).map(item => item.textContent.slice(0, 160)),
    })
  }
  return result
}

export async function snapshotNotices(invoke, limit) {
  const labels = (await invoke('plugin:window|get_all_windows')).filter(label => label.startsWith('cli-completion-'))
  return { total: labels.length, remaining: Math.max(0, labels.length - limit),
    windows: await Promise.all(labels.slice(0, limit).map(async label => ({ label,
      visible: await invoke('plugin:window|is_visible', { label }) }))) }
}

export async function inspectPreview({ cdp, pageUrl, targetId, view, frameTitle, selector, themeToken, expectRenderer, limit = 8 }) {
  selector ??= view === 'terminal' ? '.terminal-host' : 'body'
  const origin = new URL(cdp)
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('--cdp requires an HTTP debugging origin')
  const response = await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(5000) })
    .catch(() => { throw new Error('CDP discovery failed; check that the selected app exposes its debugging endpoint') })
  if (!response.ok) throw new Error(`CDP discovery: HTTP ${response.status}`)
  const targets = (await response.json()).filter(target => target.type === 'page' && target.url === pageUrl && (!targetId || target.id === targetId))
  if (targets.length !== 1) throw new Error(`Expected one exact --page-url${targetId ? ' and --target-id' : ''} match; found ${targets.length}${!targetId && targets.length > 1 ? '; select --target-id from /json/list' : ''}`)
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  const pending = new Map()
  const contexts = new Map()
  let sequence = 0
  const failPending = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP disconnected')) }
    pending.clear()
  }
  ws.addEventListener('close', failPending)
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.executionContextCreated') contexts.set(message.params.context.id, message.params.context)
    if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.params.executionContextId)
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear()
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(message.id)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
  })
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 5000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(contextId, expression) {
    const value = await call('Runtime.evaluate', { contextId, expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('CDP connection timed out')) }, 5000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
    })
    await call('Runtime.enable')
    const tree = (await call('Page.getFrameTree')).frameTree
    const flatten = node => [node.frame, ...(node.childFrames ?? []).flatMap(flatten)]
    const expected = flatten(tree).filter(frame => view === 'html' ? frame.id !== tree.frame.id
      : ['theme', 'element', 'terminal'].includes(view) && frameTitle ? true : frame.id === tree.frame.id)
    const result = { view, complete: expected.length <= limit, frameTotal: expected.length,
      remainingFrames: Math.max(0, expected.length - limit), frames: [], errors: [] }
    for (const frame of expected.slice(0, limit)) {
      const context = [...contexts.values()].find(context => context.auxData?.isDefault && context.auxData.frameId === frame.id)
      if (!context) { result.errors.push({ frameId: frame.id, error: 'No available default execution context' }); continue }
      try {
        const title = await evaluate(context.id, 'document.title')
        if (frameTitle && title !== frameTitle) continue
        if (view === 'notices') {
          result.notices = await evaluate(context.id, `(${snapshotNotices})(window.__TAURI_INTERNALS__.invoke, ${limit})`)
        } else {
          const expression = view === 'chat' ? `(${snapshotChat})(${limit}, document)`
            : view === 'terminal' ? `(${snapshotTerminal})(${JSON.stringify(selector)}, ${limit}, document)`
            : view === 'element' ? `(${snapshotElement})(${JSON.stringify(selector)}, ${limit}, document)`
            : view === 'theme' ? `(${snapshotTheme})(${JSON.stringify(selector)}, ${JSON.stringify(themeToken ?? '')}, ${limit}, document)`
            : `(${snapshotDom})(${JSON.stringify(view)}, ${limit}, document)`
          const frame = await evaluate(context.id, expression)
          if (!frame) {
            if (['theme', 'element'].includes(view)) result.errors.push({ frameId: context.auxData.frameId, error: view === 'theme' ? 'No element matches the theme selector' : 'No element matches the selector' })
            continue
          }
          result.frames.push({ frameId: context.auxData.frameId, ...frame })
          if (frame.chat?.remainingErrors || frame.theme?.remainingLayers || frame.remainingElements) result.complete = false
          if (frame.terminal?.remainingHosts || frame.terminal?.wasm.remaining || frame.terminal?.hosts.some(host => host.remainingCanvases)) result.complete = false
        }
      } catch (error) { result.errors.push({ frameId: context.auxData.frameId, error: error.message }) }
    }
    if (result.errors.length || (view === 'notices' ? !result.notices || result.notices.remaining > 0 : !result.frames.length)) result.complete = false
    if (expectRenderer) {
      const hosts = result.frames.flatMap(frame => frame.terminal?.hosts ?? []).filter(host => host.visible && host.mounted)
      if (!hosts.length) result.errors.push({ error: `No visible mounted terminal for expected renderer ${expectRenderer}` })
      else if (hosts.some(host => host.renderer !== expectRenderer)) result.errors.push({ error: `Visible terminal renderer does not match ${expectRenderer}` })
      if (result.errors.length) result.complete = false
    }
    return result
  } finally { ws.close(); failPending() }
}

async function main() {
  try {
    const { values } = parseArgs({ options: { cdp: { type: 'string' }, 'page-url': { type: 'string' }, 'target-id': { type: 'string' },
      view: { type: 'string' }, 'frame-title': { type: 'string' }, selector: { type: 'string' },
      'theme-token': { type: 'string' }, 'expect-renderer': { type: 'string' }, limit: { type: 'string', default: '8' }, help: { type: 'boolean' } } })
    if (values.help) {
      console.log('Usage: node inspect-preview.mjs --cdp <HTTP origin> --page-url <exact URL> [--target-id <CDP target ID>] --view html|iui|chat|notices|theme|element|terminal [--frame-title <exact title>] [--selector <CSS selector>] [--theme-token color-bg-primary] [--expect-renderer webgpu|dom] [--limit 1..20]\nRead-only snapshot; Node.js with built-in WebSocket required. Select --target-id from /json/list when several windows share the same URL. HTML covers child frames; theme, element and terminal search frames when --frame-title is set. Terminal defaults to .terminal-host, omits terminal text and reports renderer, fallback, canvas dimensions and Wraith Wasm assets. --expect-renderer fails unless a visible mounted terminal matches. Element reports bounded form values and geometry. Incomplete coverage exits nonzero. Inspect native composition and input in their actual consumers.')
      return
    }
    const limit = Number(values.limit)
    if (!values.cdp || !values['page-url'] || !['html', 'iui', 'chat', 'notices', 'theme', 'element', 'terminal'].includes(values.view)
      || (values.selector && !['theme', 'element', 'terminal'].includes(values.view))
      || (values['theme-token'] && values.view !== 'theme')
      || (values['expect-renderer'] && (values.view !== 'terminal' || !['webgpu', 'dom'].includes(values['expect-renderer'])))
      || (values['theme-token'] && !/^(?:--)?[a-zA-Z0-9_-]+$/.test(values['theme-token']))
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid or missing argument; see --help')
    const themeToken = values['theme-token'] ? `--${values['theme-token'].replace(/^--/, '')}` : undefined
    const result = await inspectPreview({ cdp: values.cdp, pageUrl: values['page-url'], targetId: values['target-id'], view: values.view, frameTitle: values['frame-title'], selector: values.selector, themeToken, expectRenderer: values['expect-renderer'], limit })
    console.log(JSON.stringify(result))
    if (!result.complete) process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({ complete: false, errors: [{ error: error.message }] }))
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
