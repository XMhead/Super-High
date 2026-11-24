import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { inspectPreview, snapshotChat, snapshotDom, snapshotElement, snapshotNotices, snapshotTerminal, snapshotTheme } from './inspect-preview.mjs'

test('element evidence bounds form values and omits password values', () => {
  const { document } = new JSDOM('<input id="name" value="retained"><input type="password" value="secret"><p>status</p>').window
  document.querySelector('#name').getBoundingClientRect = () => ({ x: 8, y: 10, width: 140, height: 30 })
  const result = snapshotElement('input,p', 2, document)
  assert.equal(result.elements[0].visible, true)
  assert.equal(result.elements[0].value, 'retained')
  assert.equal(result.elements[1].value, null)
  assert.equal(result.remainingElements, 1)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
  assert.equal(snapshotElement('.missing', 2, document), null)
})

test('theme evidence detects a body override and captures the painted target background', () => {
  const { document } = new JSDOM('<html style="--theme-bg: rgb(30, 30, 46)"><body style="--theme-bg: rgb(21, 21, 23)"><main style="background: rgb(21, 21, 23); color: rgb(200, 201, 202)"></main></body></html>').window
  const result = snapshotTheme('main', '--theme-bg', 8, document).theme
  assert.equal(result.rootToken, 'rgb(30, 30, 46)')
  // jsdom does not implement inheritance of custom properties: compare the body itself.
  assert.equal(snapshotTheme('body', '--theme-bg', 8, document).theme.targetToken, 'rgb(21, 21, 23)')
  assert.equal(result.background, 'rgb(21, 21, 23)')
  assert.equal(result.foreground, 'rgb(200, 201, 202)')
  assert.deepEqual(result.layers.map(layer => layer.tag), ['main', 'body', 'html'])
  assert.equal(result.remainingLayers, false)
  assert.equal(snapshotTheme('main', '', 1, document).theme.remainingLayers, true)
  assert.equal(snapshotTheme('.missing', '', 8, document), null)
})

function chatDocument() {
  const { document } = new JSDOM(`<title>Chat fixture</title><div class="command-search"></div><select class="search-sort-select"></select>
    <section class="chat-workspace"><aside class="chat-history-sidebar"><select aria-label="筛选智能体"><option value="codex" selected>Codex</option></select>
    <section class="chat-history-group"><button class="chat-history-row"><small>live</small></button><button class="chat-history-row">private session title</button></section></aside>
    <main class="chat-workspace-main"><div style="display:none"><section class="cli-chat"><textarea class="cli-chat-input"></textarea><p class="cli-chat-error">hidden error</p></section></div>
    <section class="cli-chat cli-chat--history"><button class="cli-chat-thinking-toggle">加载更早记录</button><article class="cli-chat-turn"><p class="cli-chat-answer-body">private answer</p>
    <details class="cli-chat-step-disclosure"><pre class="cli-chat-step-output">tool output</pre></details></article><button class="chat-resume-button">resume</button></section></main>
    <aside class="chat-workspace-preview"></aside><p class="chat-history-error">one</p><p class="cli-chat-error">two</p></section>`).window
  for (const element of document.querySelectorAll('*')) {
    element.getClientRects = () => element.closest('[style="display:none"]') ? [] : [element.getBoundingClientRect()]
    element.getBoundingClientRect = () => ({ x: element.classList.contains('command-search') ? 801 : 800, y: 0, width: 200, height: 100, right: 1000, bottom: 100 })
  }
  Object.defineProperty(document.defaultView.performance, 'getEntriesByType', { configurable: true, value: () => [] })
  return document
}

test('chat evidence separates native history from a hidden live view and bounds text exposure', () => {
  const document = chatDocument()
  const result = snapshotChat(1, document).chat
  assert.equal(result.scope, 'rendered-chat-dom')
  assert.equal(result.mode, 'history')
  assert.equal(result.providerFilter, 'codex')
  assert.deepEqual(result.sidebar, { visible: true, renderedGroups: 1, renderedRows: 2, renderedLiveRows: 1 })
  assert.deepEqual(result.content, { renderedTurns: 1, answerCharacters: 14, expandedSteps: 1, outputCharacters: 11, earlierPageAvailable: true })
  assert.deepEqual(result.receipts, { nativeMessages: 0, supplementalMessages: 0, pendingMessages: 0, unconfirmedMessages: 0, draftCharacters: 0 })
  assert.deepEqual(result.actions, { composerVisible: false, resumeVisible: true })
  assert.deepEqual(result.layout.alignment, { previewLeft: 800, searchLeft: 801, sortRight: 1000 })
  assert.equal(result.errorTotal, 2)
  assert.equal(result.remainingErrors, 1)
  assert.deepEqual(result.errors, ['one'])
  assert.doesNotMatch(JSON.stringify(result), /private|hidden error|tool output/)
  document.querySelector('.chat-workspace').getClientRects = () => []
  assert.equal(snapshotChat(8, document), null)
})

test('chat runtime evidence counts hidden terminals and retains resource history after disposal', () => {
  const document = chatDocument()
  const hidden = document.querySelector('[style="display:none"]')
  hidden.insertAdjacentHTML('beforeend', '<div class="terminal-host"><div class="xterm"></div></div>')
  Object.defineProperty(document.defaultView.performance, 'getEntriesByType', { configurable: true, value: type => {
    assert.equal(type, 'resource')
    return [{ name: 'http://fixture/assets/xterm-ab.js' }, { name: 'http://fixture/assets/xterm-ab.css' },
      { name: 'http://fixture/assets/addon-fit-ab.js' }, { name: 'http://fixture/assets/wraith_engine_bg-ab.wasm' },
      { name: 'http://fixture/assets/main.js' }]
  } })
  assert.deepEqual(snapshotChat(8, document).chat.runtime, { terminalHosts: 1, mountedTerminals: 1, loadedTerminalResources: 4 })
  hidden.querySelector('.terminal-host').remove()
  assert.deepEqual(snapshotChat(8, document).chat.runtime, { terminalHosts: 0, mountedTerminals: 0, loadedTerminalResources: 4 })
  Object.defineProperty(document.defaultView.performance, 'getEntriesByType', { configurable: true, value: undefined })
  assert.equal(snapshotChat(8, document).chat.runtime.loadedTerminalResources, null)
})

function addTerminal(document) {
  document.body.insertAdjacentHTML('beforeend', `<section class="terminal-host" data-terminal-renderer="webgpu">
    <div class="xterm"><canvas width="150" height="75"></canvas><textarea>private input</textarea></div></section>`)
  const host = document.querySelector('.terminal-host')
  for (const element of [host, host.querySelector('canvas')]) {
    element.getClientRects = () => [element.getBoundingClientRect()]
    element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 120, height: 60 })
  }
  Object.defineProperties(document.defaultView, { isSecureContext: { value: true, configurable: true }, devicePixelRatio: { value: 1.25, configurable: true } })
  Object.defineProperty(document.defaultView.navigator, 'gpu', { value: {}, configurable: true })
  Object.defineProperty(document.defaultView.performance, 'getEntriesByType', { configurable: true, value: () => [
    { name: 'http://fixture/assets/wraith_engine_bg-test.wasm?token=private', decodedBodySize: 200 },
    { name: 'http://fixture/pdf/other.wasm', decodedBodySize: 300 },
  ] })
  return host
}

test('terminal evidence separates active GPU, fallback, hidden hosts and missing observations without exposing input', () => {
  const { document } = new JSDOM('<title>Terminal fixture</title>').window
  const host = addTerminal(document)
  const result = snapshotTerminal('.terminal-host', 8, document).terminal
  assert.equal(result.gpuAvailable, true)
  assert.equal(result.secureContext, true)
  assert.equal(result.devicePixelRatio, 1.25)
  assert.equal(result.hosts[0].renderer, 'webgpu')
  assert.equal(result.hosts[0].fallbackReason, null)
  assert.equal(result.hosts[0].mounted, true)
  assert.deepEqual(result.hosts[0].canvases[0].pixels, { width: 150, height: 75 })
  assert.equal(result.hosts[0].canvases[0].rect.width, 120)
  assert.deepEqual(result.wasm, { observed: true, total: 1, remaining: 0, resources: [{ asset: 'wraith_engine_bg-test.wasm', decodedBytes: 200 }] })
  assert.doesNotMatch(JSON.stringify(result), /private|token=/)
  host.dataset.terminalRenderer = 'dom'
  host.dataset.terminalRendererFallback = 'WebGPU device lost'
  host.style.display = 'none'
  const fallback = snapshotTerminal('.terminal-host', 8, document).terminal.hosts[0]
  assert.equal(fallback.visible, false)
  assert.equal(fallback.mounted, true)
  assert.equal(fallback.renderer, 'dom')
  assert.equal(fallback.fallbackReason, 'WebGPU device lost')
  host.remove()
  Object.defineProperty(document.defaultView.performance, 'getEntriesByType', { value: undefined })
  const disposed = snapshotTerminal('.terminal-host', 8, document).terminal
  assert.equal(disposed.hostTotal, 0)
  assert.equal(disposed.wasm.observed, false)
})

test('terminal evidence bounds every repeated resource and permits a different host selector', () => {
  const { document } = new JSDOM().window
  const host = addTerminal(document)
  host.className = 'mobile-terminal'
  host.querySelector('.xterm').append(document.createElement('canvas'))
  document.body.append(host.cloneNode(true))
  Object.defineProperty(document.defaultView.performance, 'getEntriesByType', { value: () => [
    { name: '/wraith_engine_bg-one.wasm' }, { name: '/wraith_engine_bg-two.wasm' },
  ] })
  const result = snapshotTerminal('.mobile-terminal', 1, document).terminal
  assert.equal(result.hostTotal, 2)
  assert.equal(result.remainingHosts, 1)
  assert.equal(result.hosts[0].remainingCanvases, 1)
  assert.equal(result.wasm.remaining, 1)
  assert.equal(result.hosts.length, 1)
  assert.equal(result.wasm.resources.length, 1)
})

test('question evidence reports disabled and visible forms without exposing questions or drafts', () => {
  const document = chatDocument()
  const active = document.querySelector('.cli-chat--history')
  active.querySelector('.cli-chat-thinking-toggle').textContent = '取消菜单'
  active.insertAdjacentHTML('beforeend', `<section class="cli-session-questions">
    <form><p>private question</p><textarea>private answer</textarea><button type="submit" disabled>Reply</button></form>
    <form><button type="submit">Reply</button></form>
    <form style="display:none"><button type="submit" disabled>Reply</button></form>
    <p role="alert">Request unavailable</p></section>`)
  for (const element of active.querySelectorAll('.cli-session-questions *')) {
    element.getClientRects = () => element.closest('[style="display:none"]') ? [] : [{}]
  }
  const result = snapshotChat(8, document).chat
  assert.deepEqual(result.questions, { forms: 2, disabledSubmits: 1 })
  assert.equal(result.content.earlierPageAvailable, false)
  assert.ok(result.errors.includes('Request unavailable'))
  assert.doesNotMatch(JSON.stringify(result), /private question|private answer/)
})

function addChatReceipts(document) {
  const active = document.querySelector('.cli-chat--history')
  active.querySelector('.cli-chat-turn').insertAdjacentHTML('afterbegin', `<div class="cli-chat-user-bubble">private initial</div>
    <ol><li class="cli-chat-step--user"><div class="cli-chat-user-bubble">private first supplement</div></li>
    <li class="cli-chat-step--user"><div class="cli-chat-user-bubble">private second supplement</div></li></ol>`)
  active.insertAdjacentHTML('beforeend', `<article class="cli-chat-turn cli-chat-pending"><div class="cli-chat-user-bubble">private pending</div>
    <p class="cli-chat-note">等待 CLI 接收消息</p></article><article class="cli-chat-turn cli-chat-pending"><div class="cli-chat-user-bubble">private unconfirmed</div>
    <p class="cli-chat-note">暂未确认 CLI 接收，仍在核对；可切到工作模式查看。</p></article><textarea class="cli-chat-input">private draft</textarea>`)
  document.querySelector('.cli-chat:not(.cli-chat--history)').insertAdjacentHTML('beforeend', '<article class="cli-chat-pending"><div class="cli-chat-user-bubble">hidden pending</div></article>')
  return active
}

test('chat receipt evidence separates mid-turn messages, pending sends and drafts without exposing their text', () => {
  const document = chatDocument()
  const active = addChatReceipts(document)
  const result = snapshotChat(8, document).chat
  assert.equal(result.content.renderedTurns, 1)
  assert.deepEqual(result.receipts, { nativeMessages: 3, supplementalMessages: 2, pendingMessages: 2, unconfirmedMessages: 1, draftCharacters: 13 })
  assert.doesNotMatch(JSON.stringify(result), /private|hidden pending/)
  for (const element of active.querySelectorAll('.cli-chat-pending')) element.remove()
  active.querySelector('textarea').value = ''
  assert.deepEqual(snapshotChat(8, document).chat.receipts,
    { nativeMessages: 3, supplementalMessages: 2, pendingMessages: 0, unconfirmedMessages: 0, draftCharacters: 0 })
})

test('image evidence separates loaded, pending and broken resources with bounded labels', () => {
  const { document } = new JSDOM('<img alt="loaded"><img alt="pending"><img alt="broken one"><img alt="broken two">').window
  for (const [index, image] of [...document.images].entries()) Object.defineProperties(image, {
    complete: { value: index !== 1 }, naturalWidth: { value: index === 0 ? 16 : 0 },
  })
  assert.deepEqual(snapshotDom('html', 1, document).images,
    { total: 4, loaded: 1, pending: 1, broken: 2, brokenLabels: ['broken one'] })
})

test('IUI evidence requires its real root and retains media failures and limited detail', () => {
  const { document } = new JSDOM('<main class="shui-root"><audio></audio><video></video><div class="shui-model"><canvas width="640" height="320"></canvas></div><div class="shui-issue">model failed</div></main>').window
  Object.defineProperty(document.querySelector('audio'), 'error', { value: { code: 4 } })
  const result = snapshotDom('iui', 1, document)
  assert.equal(result.mediaTotal, 2)
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].error, 4)
  assert.equal(result.media[0].duration, null)
  assert.deepEqual(result.models, [{ width: 640, height: 320 }])
  assert.deepEqual(result.issues, ['model failed'])
  document.querySelector('main').remove()
  assert.equal(snapshotDom('iui', 1, document), null)
})

test('native notices use Tauri window labels and actual visibility, without control actions', async () => {
  const calls = []
  const invoke = async (method, args) => {
    calls.push([method, args])
    return method.endsWith('get_all_windows') ? ['main', 'cli-completion-one', 'cli-completion-two'] : false
  }
  assert.deepEqual(await snapshotNotices(invoke, 1), {
    total: 2, remaining: 1, windows: [{ label: 'cli-completion-one', visible: false }],
  })
  assert.deepEqual(calls.map(([method]) => method), ['plugin:window|get_all_windows', 'plugin:window|is_visible'])
})

test('notice query failures remain failures instead of an empty success', async () => {
  await assert.rejects(snapshotNotices(async () => { throw new Error('permission denied') }, 8), /permission denied/)
})

test('rejects non-HTTP debugging endpoints before connecting', async () => {
  await assert.rejects(inspectPreview({ cdp: 'file:///fixture', pageUrl: 'http://tauri.localhost/', view: 'notices' }), /HTTP/)
})

test('CDP collection reads the child frame and marks missing contexts incomplete', async () => {
  const savedFetch = globalThis.fetch
  const savedWebSocket = globalThis.WebSocket
  const documents = [chatDocument(),
    new JSDOM('<title>Review</title><img alt="missing">').window.document]
  const methods = []
  let childAvailable = true
  let closed = 0
  class FixtureSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
    async send(raw) {
      const { id, method, params } = JSON.parse(raw)
      methods.push(method)
      let result = {}
      if (method === 'Runtime.enable') {
        for (const contextId of childAvailable ? [1, 2] : [1]) this.message({ method: 'Runtime.executionContextCreated',
          params: { context: { id: contextId, auxData: { isDefault: true, frameId: contextId === 1 ? 'root' : 'child' } } } })
      } else if (method === 'Page.getFrameTree') {
        result = { frameTree: { frame: { id: 'root' }, childFrames: [{ frame: { id: 'child' } }] } }
      } else if (method === 'Runtime.evaluate') {
        try { result = { result: { value: await runInNewContext(params.expression, { document: documents[params.contextId - 1] }) } } }
        catch (error) { result = { exceptionDetails: { text: error.message } } }
      } else throw new Error(`Unexpected CDP action: ${method}`)
      this.message({ id, result })
    }
    close() { closed++; this.dispatchEvent(new Event('close')) }
  }
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [
      { type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: 'ws://fixture/' },
    ] })
    globalThis.WebSocket = FixtureSocket
    const options = { cdp: 'http://fixture/', pageUrl: 'http://tauri.localhost/', view: 'html', frameTitle: 'Review' }
    const present = await inspectPreview(options)
    assert.equal(present.complete, true)
    assert.equal(present.frames[0].title, 'Review')
    assert.equal(present.frames[0].images.broken, 1)
    const embeddedTheme = await inspectPreview({ ...options, view: 'theme', selector: 'body', themeToken: '--theme-bg' })
    assert.equal(embeddedTheme.complete, true)
    assert.equal(embeddedTheme.frames.length, 1)
    assert.equal(embeddedTheme.frames[0].title, 'Review')
    assert.equal(embeddedTheme.frames[0].theme.selector, 'body')
    const chat = await inspectPreview({ ...options, view: 'chat', frameTitle: undefined, limit: 1 })
    assert.equal(chat.complete, false)
    assert.equal(chat.frames[0].chat.mode, 'history')
    assert.equal(chat.frames[0].chat.remainingErrors, 1)
    childAvailable = false
    const missing = await inspectPreview(options)
    assert.equal(missing.complete, false)
    assert.match(missing.errors[0].error, /execution context/)
    assert.equal(closed, 4)
    assert.deepEqual([...new Set(methods)], ['Runtime.enable', 'Page.getFrameTree', 'Runtime.evaluate'])
  } finally { globalThis.fetch = savedFetch; globalThis.WebSocket = savedWebSocket }
})

test('inspection CLI collects bounded evidence and enforces the requested renderer through HTTP and WebSocket', async () => {
  const document = chatDocument()
  addChatReceipts(document)
  const pageUrl = 'http://fixture.local/chat'
  const methods = []
  let advertiseDuplicate = false
  const connections = []
  let port
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify([
      { id: 'first', type: 'page', url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/first` },
      ...(advertiseDuplicate ? [{ id: 'second', type: 'page', url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/second` }] : []),
    ]))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket, request) => { connections.push(request.url); socket.on('message', async raw => {
    const { id, method, params } = JSON.parse(raw)
    methods.push(method)
    let result = {}
    if (method === 'Runtime.enable') socket.send(JSON.stringify({ method: 'Runtime.executionContextCreated', params: {
      context: { id: 1, auxData: { isDefault: true, frameId: 'root' } },
    } }))
    else if (method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'root' } } }
    else if (method === 'Runtime.evaluate') {
      try { result = { result: { value: await runInNewContext(params.expression, { document }) } } }
      catch (error) { result = { exceptionDetails: { text: error.message } } }
    } else result = { unexpected: method }
    socket.send(JSON.stringify({ id, result }))
  }) })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./inspect-preview.mjs', import.meta.url)),
      '--cdp', `http://127.0.0.1:${port}`, '--page-url', pageUrl, '--view', 'chat'], { windowsHide: true, timeout: 10_000 })
    const result = JSON.parse(stdout)
    assert.equal(result.complete, true)
    assert.equal(result.frames[0].chat.mode, 'history')
    assert.equal(result.frames[0].chat.actions.composerVisible, false)
    assert.equal(result.frames[0].chat.content.outputCharacters, 11)
    assert.deepEqual(result.frames[0].chat.runtime, { terminalHosts: 0, mountedTerminals: 0, loadedTerminalResources: 0 })
    assert.deepEqual(result.frames[0].chat.questions, { forms: 0, disabledSubmits: 0 })
    assert.deepEqual(result.frames[0].chat.receipts,
      { nativeMessages: 3, supplementalMessages: 2, pendingMessages: 2, unconfirmedMessages: 1, draftCharacters: 13 })
    assert.doesNotMatch(stdout, /private|hidden pending/)
    const terminalHost = addTerminal(document)
    const terminalArgs = [fileURLToPath(new URL('./inspect-preview.mjs', import.meta.url)),
      '--cdp', `http://127.0.0.1:${port}`, '--page-url', pageUrl, '--view', 'terminal', '--expect-renderer', 'webgpu']
    const terminalRun = await promisify(execFile)(process.execPath, terminalArgs, { windowsHide: true, timeout: 10_000 })
    const terminal = JSON.parse(terminalRun.stdout)
    assert.equal(terminal.complete, true)
    assert.equal(terminal.frames[0].terminal.hosts[0].renderer, 'webgpu')
    assert.doesNotMatch(terminalRun.stdout, /private|token=/)
    terminalHost.dataset.terminalRenderer = 'dom'
    await assert.rejects(promisify(execFile)(process.execPath, terminalArgs, { windowsHide: true, timeout: 10_000 }), error => {
      assert.equal(error.code, 1)
      const result = JSON.parse(error.stdout)
      assert.equal(result.complete, false)
      assert.match(result.errors[0].error, /does not match webgpu/)
      return true
    })
    terminalHost.remove()
    await assert.rejects(promisify(execFile)(process.execPath, terminalArgs, { windowsHide: true, timeout: 10_000 }), error => {
      assert.equal(error.code, 1)
      assert.match(JSON.parse(error.stdout).errors[0].error, /No visible mounted terminal/)
      return true
    })
    const themeRun = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./inspect-preview.mjs', import.meta.url)),
      '--cdp', `http://127.0.0.1:${port}`, '--page-url', pageUrl, '--view', 'theme', '--selector', '.chat-workspace', '--theme-token', 'color-bg-primary'], { windowsHide: true, timeout: 10_000 })
    const theme = JSON.parse(themeRun.stdout)
    assert.equal(theme.complete, true)
    assert.equal(theme.frames[0].theme.selector, '.chat-workspace')
    assert.equal(theme.frames[0].theme.token, '--color-bg-primary')
    assert.doesNotMatch(themeRun.stdout, /private|hidden pending/)
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./inspect-preview.mjs', import.meta.url)),
      '--cdp', `http://127.0.0.1:${port}`, '--page-url', pageUrl, '--view', 'theme', '--selector', '.missing'], { windowsHide: true, timeout: 10_000 }),
    error => /No element matches the theme selector/.test(error.stdout))
    advertiseDuplicate = true
    const args = [fileURLToPath(new URL('./inspect-preview.mjs', import.meta.url)), '--cdp', `http://127.0.0.1:${port}`, '--page-url', pageUrl, '--view', 'element', '--selector', '.cli-chat-input']
    await assert.rejects(promisify(execFile)(process.execPath, args, { windowsHide: true, timeout: 10_000 }), error => /select --target-id/.test(error.stdout))
    const selected = await promisify(execFile)(process.execPath, [...args, '--target-id', 'second'], { windowsHide: true, timeout: 10_000 })
    assert.equal(JSON.parse(selected.stdout).complete, true)
    assert.equal(connections.at(-1), '/second')
    await assert.rejects(promisify(execFile)(process.execPath, [...args, '--target-id', 'missing'], { windowsHide: true, timeout: 10_000 }), error => /found 0/.test(error.stdout))
    assert.deepEqual([...new Set(methods)], ['Runtime.enable', 'Page.getFrameTree', 'Runtime.evaluate'])
  } finally {
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
})
