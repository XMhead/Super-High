import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export const FIELD_CONSUMERS = {
  complete: { '../SKILL.md': 'Choose whether further evidence is required before diagnosing the feature.' },
  errors: { '../SKILL.md': 'Distinguish connection, permission and unavailable-frame failures.' },
  view: { '../SKILL.md': 'Interpret the selected HTML, IUI, chat or notification evidence.' },
  frames: { '../SKILL.md': 'Locate broken images, media errors and missing model canvases in the target frame.' },
  frameTotal: { '../SKILL.md': 'Check how many frames belong to the selected view.' },
  remainingFrames: { '../SKILL.md': 'Increase the limit or narrow the frame selection when coverage was capped.' },
  notices: { '../SKILL.md': 'Distinguish missing windows from hidden native notifications.' },
  chat: { '../references/chat-history.md': 'Check rendered history, read-only mode, tool details and panel alignment before selecting the next UI action.' },
  'chat.receipts': { '../references/chat-history.md': 'Check native and supplemental message counts, outstanding confirmations and draft length during mid-turn and late-receipt acceptance.' },
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
  const errors = [...root.querySelectorAll('.chat-history-error,.cli-chat-error')].filter(visible)
  const sidebar = root.querySelector('.chat-history-sidebar')
  const provider = root.querySelector('[aria-label="筛选智能体"]')
  const preview = document.querySelector('.chat-workspace-preview')
  const search = document.querySelector('.command-search')
  const sort = document.querySelector('.search-sort-select')
  const previewRect = rect(preview)
  return { title: document.title, chat: {
    scope: 'rendered-chat-dom', mode: history ? 'history' : active ? 'live' : 'native-or-empty',
    providerFilter: provider?.value ?? null,
    sidebar: { visible: visible(sidebar), renderedGroups: root.querySelectorAll('.chat-history-group').length,
      renderedRows: rows.length, renderedLiveRows: rows.filter(row => row.querySelector('small')).length },
    content: { renderedTurns: active?.querySelectorAll('.cli-chat-turn:not(.cli-chat-pending)').length ?? 0,
      answerCharacters: [...active?.querySelectorAll('.cli-chat-answer-body') ?? []].reduce((sum, item) => sum + item.textContent.length, 0),
      expandedSteps: active?.querySelectorAll('.cli-chat-step-disclosure').length ?? 0,
      outputCharacters: [...active?.querySelectorAll('.cli-chat-step-output') ?? []].reduce((sum, item) => sum + item.textContent.length, 0),
      earlierPageAvailable: [...active?.querySelectorAll('.cli-chat-thinking-toggle') ?? []].some(button => !button.closest('.cli-chat-turn')) },
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

export async function inspectPreview({ cdp, pageUrl, view, frameTitle, limit = 8 }) {
  const origin = new URL(cdp)
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('--cdp requires an HTTP debugging origin')
  const response = await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(5000) })
    .catch(() => { throw new Error('CDP discovery failed; check that the selected app exposes its debugging endpoint') })
  if (!response.ok) throw new Error(`CDP discovery: HTTP ${response.status}`)
  const targets = (await response.json()).filter(target => target.type === 'page' && target.url === pageUrl)
  if (targets.length !== 1) throw new Error(`Expected one exact --page-url match; found ${targets.length}`)
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
    const expected = flatten(tree).filter(frame => view === 'html' ? frame.id !== tree.frame.id : frame.id === tree.frame.id)
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
            : `(${snapshotDom})(${JSON.stringify(view)}, ${limit}, document)`
          const frame = await evaluate(context.id, expression)
          if (!frame) continue
          result.frames.push({ frameId: context.auxData.frameId, ...frame })
          if (frame.chat?.remainingErrors) result.complete = false
        }
      } catch (error) { result.errors.push({ frameId: context.auxData.frameId, error: error.message }) }
    }
    if (result.errors.length || (view === 'notices' ? !result.notices || result.notices.remaining > 0 : !result.frames.length)) result.complete = false
    return result
  } finally { ws.close(); failPending() }
}

async function main() {
  try {
    const { values } = parseArgs({ options: { cdp: { type: 'string' }, 'page-url': { type: 'string' },
      view: { type: 'string' }, 'frame-title': { type: 'string' }, limit: { type: 'string', default: '8' }, help: { type: 'boolean' } } })
    if (values.help) {
      console.log('Usage: node inspect-preview.mjs --cdp <HTTP origin> --page-url <exact URL> --view html|iui|chat|notices [--frame-title <exact title>] [--limit 1..20]\nRead-only snapshot; Node.js with built-in WebSocket required. Does not navigate, play media, reply, create sessions, or restart apps. complete means evidence collection, not feature acceptance. HTML covers available child-frame contexts; IUI and chat cover the main frame. Chat counts cover rendered rows, loaded turns and expanded steps; use native readers for global counts and interact to verify resume. Media state and canvas dimensions do not prove playback or model interaction. Notice visibility does not prove delivery to the originating session.')
      return
    }
    const limit = Number(values.limit)
    if (!values.cdp || !values['page-url'] || !['html', 'iui', 'chat', 'notices'].includes(values.view)
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid or missing argument; see --help')
    const result = await inspectPreview({ cdp: values.cdp, pageUrl: values['page-url'], view: values.view, frameTitle: values['frame-title'], limit })
    console.log(JSON.stringify(result))
    if (!result.complete) process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({ complete: false, errors: [{ error: error.message }] }))
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
