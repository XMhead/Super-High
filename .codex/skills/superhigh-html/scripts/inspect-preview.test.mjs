import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { inspectPreview, snapshotChat, snapshotDom, snapshotNotices } from './inspect-preview.mjs'

function chatDocument() {
  const { document } = new JSDOM(`<title>Chat fixture</title><div class="command-search"></div><select class="search-sort-select"></select>
    <section class="chat-workspace"><aside class="chat-history-sidebar"><select aria-label="筛选智能体"><option value="codex" selected>Codex</option></select>
    <section class="chat-history-group"><button class="chat-history-row"><small>live</small></button><button class="chat-history-row">private session title</button></section></aside>
    <main class="chat-workspace-main"><div style="display:none"><section class="cli-chat"><textarea class="cli-chat-input"></textarea><p class="cli-chat-error">hidden error</p></section></div>
    <section class="cli-chat cli-chat--history"><button class="cli-chat-thinking-toggle">older page</button><article class="cli-chat-turn"><p class="cli-chat-answer-body">private answer</p>
    <details class="cli-chat-step-disclosure"><pre class="cli-chat-step-output">tool output</pre></details></article><button class="chat-resume-button">resume</button></section></main>
    <aside class="chat-workspace-preview"></aside><p class="chat-history-error">one</p><p class="cli-chat-error">two</p></section>`).window
  for (const element of document.querySelectorAll('*')) {
    element.getClientRects = () => element.closest('[style="display:none"]') ? [] : [element.getBoundingClientRect()]
    element.getBoundingClientRect = () => ({ x: element.classList.contains('command-search') ? 801 : 800, y: 0, width: 200, height: 100, right: 1000, bottom: 100 })
  }
  return document
}

test('chat evidence separates native history from the hidden live terminal and bounds text exposure', () => {
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
    const chat = await inspectPreview({ ...options, view: 'chat', frameTitle: undefined, limit: 1 })
    assert.equal(chat.complete, false)
    assert.equal(chat.frames[0].chat.mode, 'history')
    assert.equal(chat.frames[0].chat.remainingErrors, 1)
    childAvailable = false
    const missing = await inspectPreview(options)
    assert.equal(missing.complete, false)
    assert.match(missing.errors[0].error, /execution context/)
    assert.equal(closed, 3)
    assert.deepEqual([...new Set(methods)], ['Runtime.enable', 'Page.getFrameTree', 'Runtime.evaluate'])
  } finally { globalThis.fetch = savedFetch; globalThis.WebSocket = savedWebSocket }
})

test('chat CLI collects bounded evidence through its actual HTTP and WebSocket entry', async () => {
  const document = chatDocument()
  addChatReceipts(document)
  const pageUrl = 'http://fixture.local/chat'
  const methods = []
  let port
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify([{ type: 'page', url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools` }]))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => socket.on('message', async raw => {
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
  }))
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
    assert.deepEqual(result.frames[0].chat.receipts,
      { nativeMessages: 3, supplementalMessages: 2, pendingMessages: 2, unconfirmedMessages: 1, draftCharacters: 13 })
    assert.doesNotMatch(stdout, /private|hidden pending/)
    assert.deepEqual([...new Set(methods)], ['Runtime.enable', 'Page.getFrameTree', 'Runtime.evaluate'])
  } finally {
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
})
