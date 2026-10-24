import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'

const { values } = parseArgs({ options: {
  cdp: { type: 'string' }, 'page-url': { type: 'string' }, 'frame-url': { type: 'string' },
  selector: { type: 'string', default: 'body *' }, limit: { type: 'string', default: '12' },
  output: { type: 'string' }, help: { type: 'boolean' },
} })

if (values.help) {
  console.log('Usage: node scripts/inspect-rendered-fonts.mjs --cdp <HTTP debugging origin> --page-url <exact page URL> [--frame-url <exact frame URL>] [--selector <CSS selector>] [--limit <1..100>] [--output <JSON path>]\nReads rendered DOM text in the selected page and its available frame contexts. Does not navigate, change settings, or restart the app. Requires Node.js with built-in WebSocket. Output reports sampling limits and unavailable frames; canvas text is outside scope.')
  process.exit(0)
}

const limit = Number(values.limit)
if (!values.cdp || !values['page-url'] || !Number.isInteger(limit) || limit < 1 || limit > 100) {
  throw new Error('--cdp, --page-url and an integer --limit between 1 and 100 are required; see --help')
}
const origin = new URL(values.cdp)
if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('--cdp must be an HTTP debugging origin')
const response = await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(15000) })
if (!response.ok) throw new Error(`CDP target lookup failed: HTTP ${response.status}`)
const targets = (await response.json()).filter(t => t.type === 'page' && t.url === values['page-url'])
if (targets.length !== 1) throw new Error(`Expected exactly one matching page; found ${targets.length}`)

const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connection timed out')) }, 15000)
  ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
})
let sequence = 0
const pending = new Map()
const contexts = new Map()
ws.addEventListener('message', event => {
  const data = JSON.parse(event.data)
  if (data.id) {
    const request = pending.get(data.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(data.id)
    if (data.error) request.reject(new Error(`${request.method}: ${data.error.message}`))
    else request.resolve(data.result)
  }
  if (data.method === 'Runtime.executionContextCreated') contexts.set(data.params.context.id, data.params.context)
  if (data.method === 'Runtime.executionContextDestroyed') contexts.delete(data.params.executionContextId)
  if (data.method === 'Runtime.executionContextsCleared') contexts.clear()
})
ws.addEventListener('close', () => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP connection closed')) }
  pending.clear()
})
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15000)
    pending.set(id, { resolve, reject, timer, method })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
function checked(result) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result
}
async function evaluate(expression, contextId) {
  return checked(await call('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true })).value
}
function flattenFrames(tree) { return [tree.frame, ...(tree.childFrames || []).flatMap(flattenFrames)] }

try {
  await call('Runtime.enable')
  await call('DOM.enable')
  await call('CSS.enable')
  await call('DOM.getDocument', { depth: -1, pierce: true })
  const frames = flattenFrames((await call('Page.getFrameTree')).frameTree)
    .filter(frame => !values['frame-url'] || frame.url === values['frame-url'])
  if (!frames.length) throw new Error('No frame matches --frame-url')
  const result = { pageUrl: targets[0].url, selector: values.selector, limitPerFrame: limit, frames: [], unavailableFrames: [] }
  for (const frame of frames) {
    const context = [...contexts.values()].find(ctx => ctx.auxData?.isDefault && ctx.auxData.frameId === frame.id)
    if (!context) { result.unavailableFrames.push({ frameId: frame.id, url: frame.url }); continue }
    const objectGroup = `rendered-fonts-${context.id}`
    try {
      await evaluate('document.fonts.ready.then(() => true)', context.id)
      const elements = checked(await call('Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll(${JSON.stringify(values.selector)})).filter(el => !['SCRIPT','STYLE','NOSCRIPT','OPTION'].includes(el.tagName) && Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible')`,
        contextId: context.id, objectGroup,
      }))
      const total = checked(await call('Runtime.callFunctionOn', {
        objectId: elements.objectId, functionDeclaration: 'function(){return this.length}', returnByValue: true,
      })).value
      const measured = { frameId: frame.id, url: frame.url, title: await evaluate('document.title', context.id), total, sampled: Math.min(total, limit), truncated: total > limit, samples: [] }
      for (let index = 0; index < Math.min(total, limit); index++) {
        const element = checked(await call('Runtime.callFunctionOn', {
          objectId: elements.objectId, functionDeclaration: 'function(i){return this[i]}', arguments: [{ value: index }], objectGroup,
        }))
        const sample = checked(await call('Runtime.callFunctionOn', {
          objectId: element.objectId, functionDeclaration: `function(){const s=getComputedStyle(this);return {tag:this.tagName,id:this.id,classes:String(this.className),text:Array.from(this.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim().slice(0,80),cssFamily:s.fontFamily,weight:s.fontWeight,size:s.fontSize}}`, returnByValue: true,
        })).value
        const { nodeId } = await call('DOM.requestNode', { objectId: element.objectId })
        sample.renderedFonts = (await call('CSS.getPlatformFontsForNode', { nodeId })).fonts
        measured.samples.push(sample)
      }
      result.frames.push(measured)
    } finally { await call('Runtime.releaseObjectGroup', { objectGroup }) }
  }
  result.complete = result.unavailableFrames.length === 0 && result.frames.every(frame => frame.total > 0 && !frame.truncated && frame.samples.every(sample => sample.renderedFonts.length > 0))
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ ...result, output: values.output, frames: result.frames.map(({ samples, ...frame }) => ({ ...frame, renderedFonts: [...new Set(samples.flatMap(sample => sample.renderedFonts.map(font => font.familyName)))] })) }))
  } else console.log(JSON.stringify(result))
  if (result.unavailableFrames.length || result.frames.every(frame => frame.total === 0)) process.exitCode = 1
} finally { ws.close() }
