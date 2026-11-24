import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'

// A real phone's isolated WebView only. No ADB input or interaction with display 0.
const { values } = parseArgs({ options: { cdp: { type: 'string' }, smoke: { type: 'boolean' },
  crop: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: node check-phone-ui.mjs --cdp <mobile debug-start cdpUrl> [--smoke] [--crop <selector> --output <png>]\nStructured real WebView evidence. Smoke opens the resource drawer, settings and returns; never sends a model request. Optional screenshot is cropped to the selected element before saving. Use mobile debug-stop afterwards.')
  process.exit(0)
}
if (!values.cdp || new URL(values.cdp).hostname !== '127.0.0.1' || !!values.crop !== !!values.output) throw new Error('See --help')
const targets = await (await fetch(new URL('/json/list', values.cdp), { signal: AbortSignal.timeout(5000) })).json()
const pages = targets.filter(page => page.type === 'page' && new URL(page.url).pathname.startsWith('/mobile/'))
if (pages.length !== 1) throw new Error('Expected exactly one isolated phone /mobile/ WebView; refusing ambiguous targets')
const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
ws.addEventListener('message', event => {
  const response = JSON.parse(event.data)
  const task = pending.get(response.id)
  if (!task) return
  pending.delete(response.id)
  clearTimeout(task.timer)
  response.error ? task.reject(new Error(response.error.message)) : task.resolve(response.result)
})
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 6000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error('Phone evaluation failed')
  return result.result.value
}
async function point(selector) {
  const result = await evaluate(`(() => { const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility()); if(nodes.length!==1) return null; const r=nodes[0].getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,left:r.x,top:r.y}; })()`)
  if (!result?.width || !result.height) throw new Error(`Expected one visible control: ${selector}`)
  return result
}
async function click(selector) {
  const { x, y } = await point(selector)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Phone CDP connection timed out')), 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Phone CDP connection failed')) }, { once: true })
  })
  const evidence = await evaluate(`(async () => {
    let connected=false;
    try { const saved=JSON.parse(localStorage.getItem('super-high-mobile-connection')); connected=!!saved?.token && (await fetch('/api/mobile/status',{headers:{Authorization:'Bearer '+saved.token}})).ok; } catch {}
    return {path:location.pathname,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},nativeVoice:!!window.SuperHighVoice,app:!!document.querySelector('.mobile-app'),connected,settingsVisible:!!document.querySelector('.mobile-settings')?.checkVisibility(),visibleErrors:[...document.querySelectorAll('[role="alert"]')].filter(e=>e.checkVisibility()).length,controls:[...document.querySelectorAll('button[aria-label]')].filter(e=>e.checkVisibility()).map(e=>e.getAttribute('aria-label')).filter(label=>!/[a-f0-9]{8}-[a-f0-9-]{27}/.test(label)).slice(0,12)}
  })()`)
  if (!evidence.app || !evidence.nativeVoice || !evidence.connected || evidence.visibleErrors) {
    console.log(JSON.stringify(evidence))
    throw new Error('Real native mobile app not ready, disconnected or displays an error')
  }
  if (values.smoke) {
    if (evidence.settingsVisible) throw new Error('Close existing settings before smoke; preserving current state')
    await click('[aria-label="打开工作区资源管理器"]')
    await click('[aria-label="账号与设置"]')
    const opened = await evaluate("document.querySelector('.mobile-settings')?.checkVisibility()")
    if (!opened) throw new Error('Settings did not open in phone WebView')
    await click('.mobile-settings .mobile-topbar button')
    await click('[aria-label="关闭资源管理器"]')
    evidence.smoke = { settingsOpened: opened, returned: !(await evaluate("document.querySelector('.mobile-settings')?.checkVisibility()")) }
  }
  if (values.crop) {
    const rect = await point(values.crop)
    const image = await call('Page.captureScreenshot', { format: 'png', clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 } })
    await writeFile(values.output, Buffer.from(image.data, 'base64'))
    evidence.crop = { selector: values.crop, path: values.output, ...rect }
  }
  console.log(JSON.stringify(evidence))
} finally {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP disconnected')) }
  ws.close()
}
