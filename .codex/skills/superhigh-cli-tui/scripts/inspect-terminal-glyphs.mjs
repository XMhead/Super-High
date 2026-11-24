import { parseArgs, promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'vite'
import { wraith } from 'wraithterm/vite'

const { values: args } = parseArgs({ options: {
  output: { type: 'string' }, scale: { type: 'string', default: '1.25' },
  browser: { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  port: { type: 'string', default: '1439' }, 'cdp-port': { type: 'string', default: '9349' },
  help: { type: 'boolean' },
} })
if (args.help || !args.output) {
  console.log('Usage: node inspect-terminal-glyphs.mjs --output <directory> [--scale 1|1.25|1.5|2] [--browser <Edge executable>] [--port 1439] [--cdp-port 9349]\nCompares Wraith WebGPU text with a Canvas2D reference using the same font, glyph atlas and physical cell size. Uses an isolated browser; never controls a live CLI or desktop window. Saves PNGs, font metrics and owned-process cleanup evidence.')
  process.exit(args.help ? 0 : 2)
}
const scale = Number(args.scale)
if (![1, 1.25, 1.5, 2].includes(scale)) throw Error('Unsupported native scale')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const output = path.resolve(args.output)
await fs.mkdir(output, { recursive: true })
const profile = path.join(output, 'edge-profile')
const exec = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const origin = `http://127.0.0.1:${Number(args.port)}`
const cdpOrigin = `http://127.0.0.1:${Number(args['cdp-port'])}`
const report = { startedAt: new Date().toISOString(), scale, samples: [], cleanup: null, complete: false }
let server, browser, browserCdp, pageCdp
const owned = []

class Cdp {
  pending = new Map()
  sequence = 0
  constructor(url) {
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('CDP connection timed out')), 10000)
      this.ws.addEventListener('open', () => {clearTimeout(timer);resolve()}, { once: true })
      this.ws.addEventListener('error', error => {clearTimeout(timer);reject(error)}, { once: true })
    })
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data), p = this.pending.get(message.id)
      if (!p) return
      this.pending.delete(message.id)
      clearTimeout(p.timer)
      message.error ? p.reject(Error(JSON.stringify(message.error))) : p.resolve(message.result)
    })
    this.ws.addEventListener('close', () => {
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'))}
      this.pending.clear()
    })
  }
  async call(method, params = {}) {
    await this.ready
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)) }, 60000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  close() { this.ws.close() }
}
async function processes() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress'],
  { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout)
}
async function recordOwned() {
  const table = await processes(), ids = new Set([browser.pid])
  let count
  do { count = ids.size; for (const p of table) if (ids.has(p.ParentProcessId)) ids.add(p.ProcessId) } while (count !== ids.size)
  for (const p of table) if (ids.has(p.ProcessId) && !owned.some(old => old.ProcessId === p.ProcessId && old.CreationDate === p.CreationDate)) owned.push(p)
}

const probe = String.raw`
import { Terminal } from 'wraithterm/xterm'
import 'wraithterm/css/xterm.css'
import { applyFontStyle, fontStyleCssVariables } from '@/lib/fontStyles'
import { getTypographyWeights } from '@/lib/typography'
import { buildTerminalTheme } from '@/lib/theme'
applyFontStyle('anthropic')
const host = document.querySelector('#host')
let term
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const weights = getTypographyWeights()
const text = [
  'python -B -m unittest discover -s .skillshare/skills/dragoncore/tests -p test_measure_gui_fps.py -v',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789',
  'Re: xiaobing Win+D  [] {} () <> /\\ | :;., \'" !@#$%^&*_-+=~',
  'Ran 7 tests in 0.205s    + 9 lines (ctrl+t to expand)',
  '中文汉字：终端渲染检查，世界画面，文件路径，测试通过。',
  '中 A 文 B 测 C 试 D    xiaobing的窗口 已经最大化',
]
window.probe = {
  ready: true,
  async run(fallback = false, align = false) {
    window.probe.stage='font-loading'
    term?.dispose()
    host.replaceChildren()
    const vars = fallback ? fontStyleCssVariables('system-probe', [], [{id:'system-probe',name:'system-probe',roles:{}}]) : fontStyleCssVariables('anthropic')
    const fontFamily = vars['--font-mono']
    await Promise.all([weights.mono, weights.strong].map(w => document.fonts.load(w+' 14px '+fontFamily)))
    const theme = buildTerminalTheme('dark')
    term = new Terminal({ cols:100, rows:20, fontSize:14, fontFamily, fontWeight:weights.mono, fontWeightBold:weights.strong, theme, cursorBlink:false, allowProposedApi:true })
    term.open(host)
    window.probe.stage='webgpu-init'
    await term.webgpuReady
    if (term.renderer !== 'webgpu') throw Error(term.rendererFallbackReason)
    // The control uses the dependency's original fractional DOM dimensions.
    // The aligned case exercises the installed production patch unchanged.
    if (!align) {
      const renderer=term._core._renderService._renderer.value
      Object.defineProperty(renderer,'dimensions',{get(){return this.fallback.dimensions}})
    }
    const rows = [0, 1, 3].flatMap(style => text.map(line => ({line,style})))
    const scene = rows.map(({line,style})=>'\x1b['+(['0','1','','1;3'][style])+'m'+line+'\x1b[0m').join('\r\n')
    window.probe.stage='writing'
    await new Promise(resolve => term.write(scene+'\x1b[?25l',resolve))
    window.probe.stage='painting'
    await frames()
    const r = term._core._renderService._renderer.value
    await r.gpu.fence()
    window.probe.stage='reference'
    const d = r.dimensions, atlas = r.atlas
    const reference = document.createElement('canvas')
    reference.width=Math.round(d.device.canvas.width); reference.height=Math.round(d.device.canvas.height)
    const c=reference.getContext('2d')
    c.fillStyle=theme.background; c.fillRect(0,0,reference.width,reference.height)
    const tile=document.createElement('canvas');tile.width=atlas.width;tile.height=atlas.height
    const glyph=tile.getContext('2d')
    // Each cell uses the atlas' exact rasterization origin and baseline.
    for(let y=0;y<term.rows;y++) {
      const line=term.buffer.active.getLine(y)
      for(let x=0;x<term.cols;x++) {
        const cell=line.getCell(x)
        if(!cell.getWidth() || !cell.getChars()) continue
        glyph.clearRect(0,0,tile.width,tile.height)
        glyph.font=atlas.font(!!cell.isBold(),!!cell.isItalic())
        glyph.fillStyle=theme.foreground
        glyph.fillText(cell.getChars(),0,atlas.baseline)
        c.drawImage(tile,Math.round(x*d.device.cell.width),y*d.device.cell.height)
      }
    }
    window.reference=reference
    const rect=r.canvas.getBoundingClientRect()
    return { renderer:term.renderer, fontFamily, dpr:devicePixelRatio, dimensions:d, atlas:{width:atlas.width,height:atlas.height,baseline:atlas.baseline},
      clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1}, reference:reference.toDataURL('image/png') }
  },
  async compare(png) {
    const image=new Image(); image.src='data:image/png;base64,'+png; await image.decode()
    const c=document.createElement('canvas'); c.width=image.width;c.height=image.height
    const g=c.getContext('2d');g.drawImage(image,0,0)
    const a=g.getImageData(0,0,c.width,c.height).data,b=reference.getContext('2d').getImageData(0,0,c.width,c.height).data
    let different=0,maxDelta=0; const rows={}
    for(let i=0;i<a.length;i+=4){const delta=Math.max(...[0,1,2].map(k=>Math.abs(a[i+k]-b[i+k])));if(delta>2){different++;const y=Math.floor(i/4/c.width);rows[y]=(rows[y]??0)+1}maxDelta=Math.max(maxDelta,delta)}
    return {width:c.width,height:c.height,referenceWidth:reference.width,referenceHeight:reference.height,differentPixels:different,maxDelta,affectedScanlines:Object.keys(rows).length}
  },
  selection(){return term.getSelection()},
  async geometryChecks(){
    const r=term._core._renderService._renderer.value
    const check=()=>{
      const d=r.dimensions,rect=term._core.screenElement.getBoundingClientRect()
      const aligned=Number.isInteger(d.device.cell.width) && Number.isInteger(d.device.cell.height)
      const sized=Math.abs(d.css.canvas.width*devicePixelRatio-d.device.canvas.width)<0.001 && Math.abs(d.css.canvas.height*devicePixelRatio-d.device.canvas.height)<0.001
      const screen=Math.abs(rect.width-d.css.canvas.width)<0.02 && Math.abs(rect.height-d.css.canvas.height)<0.02
      if(!aligned||!sized||!screen)throw Error('Inconsistent terminal geometry '+JSON.stringify({aligned,sized,screen,d,rect}))
      return {fontSize:term.options.fontSize,cols:term.cols,rows:term.rows,cell:d.device.cell,screen:{width:rect.width,height:rect.height}}
    }
    const samples=[check()]
    term.resize(113,37);await frames();samples.push(check())
    term.options.fontSize=16;await frames();samples.push(check())
    term.options.fontSize=14;await frames();samples.push(check())
    const joiner=term.registerCharacterJoiner(()=>[])
    term.refresh(0,term.rows-1);await frames()
    const fallback=term.renderer==='dom' && r.dimensions===r.fallback.dimensions
    if(!fallback)throw Error('DOM fallback geometry changed')
    term.deregisterCharacterJoiner(joiner)
    term.refresh(0,term.rows-1);await frames();await r.gpu.fence()
    if(term.renderer!=='webgpu')throw Error('WebGPU did not recover')
    samples.push(check())
    return {samples,domFallback:fallback,webgpuRecovered:true}
  }
}
`
try {
  server = await createServer({ configFile: false, root, cacheDir:path.join(output,'vite-cache'), logLevel:'warn', publicDir:false,
    resolve:{alias:{'@':path.join(root,'src'),'@wraith-terminal/xterm-base':path.join(root,'node_modules/@xterm/xterm')}},
    optimizeDeps:{noDiscovery:true,include:[]}, server:{host:'127.0.0.1',port:Number(args.port),strictPort:true},
    plugins:[wraith(),{name:'glyph-probe',configureServer(s){s.middlewares.use(async(req,res,next)=>{
      if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/', '<!doctype html><html><head><style>body{margin:0;background:#181825;font-family:var(--font-mono)}#host{position:absolute;left:0;top:0}</style></head><body><div id="host"></div><script type="module" src="/__probe.ts"></script></body></html>'))}
      else next()
    })},resolveId(id){if(id==='/__probe.ts')return '\0glyph-probe'},load(id){if(id==='\0glyph-probe')return probe}}],
  })
  await server.listen()
  const browserArgs=['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',`--user-data-dir=${profile}`,`--remote-debugging-port=${Number(args['cdp-port'])}`,'--remote-debugging-address=127.0.0.1','--window-size=1500,1000',`--force-device-scale-factor=${scale}`,'about:blank']
  browser=spawn(args.browser,browserArgs,{windowsHide:true,stdio:'ignore'})
  await fs.writeFile(path.join(output,'processes.json'),JSON.stringify({startedAt:report.startedAt,nodePid:process.pid,browserPid:browser.pid,browserArgs,profile},null,2))
  let endpoint
  for(let i=0;i<100;i++){try{endpoint=await(await fetch(cdpOrigin+'/json/version',{signal:AbortSignal.timeout(500)})).json();break}catch{await pause(100)}}
  if(!endpoint)throw Error('CDP did not become ready')
  await recordOwned()
  browserCdp=new Cdp(endpoint.webSocketDebuggerUrl)
  report.gpu=(await browserCdp.call('SystemInfo.getInfo')).gpu
  const target=await browserCdp.call('Target.createTarget',{url:origin})
  const page=(await(await fetch(cdpOrigin+'/json/list')).json()).find(p=>p.id===target.targetId)
  pageCdp=new Cdp(page.webSocketDebuggerUrl)
  await pageCdp.call('Page.bringToFront')
  for(let i=0;i<100;i++){if(await pageCdp.evaluate('Boolean(window.probe?.ready)'))break;if(i===99)throw Error('Probe did not load');await pause(100)}
  console.log(JSON.stringify({stage:'ready',browserPid:browser.pid}))
  for(const [fallback,align] of [[false,false],[false,true],[true,false],[true,true]]){
    const name=(fallback?'fallback':'anthropic')+(align?'':'-raw')
    let result
    try{result=await pageCdp.evaluate(`probe.run(${fallback},${align})`)}catch(error){console.log(JSON.stringify({stage:await pageCdp.evaluate('window.probe.stage')}));throw error}
    await fs.writeFile(path.join(output,name+'-reference.png'),Buffer.from(result.reference.split(',')[1],'base64'))
    delete result.reference
    const png=await pageCdp.call('Page.captureScreenshot',{format:'png',clip:result.clip,captureBeyondViewport:true})
    await fs.writeFile(path.join(output,name+'-webgpu.png'),Buffer.from(png.data,'base64'))
    result.comparison=await pageCdp.evaluate(`probe.compare(${JSON.stringify(png.data)})`)
    if(align){
      const x=result.clip.x+result.dimensions.css.cell.width*0.1,y=result.clip.y+result.dimensions.css.cell.height*0.5
      await pageCdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1})
      await pageCdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+result.dimensions.css.cell.width*6,y,button:'left',buttons:1})
      await pageCdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+result.dimensions.css.cell.width*6,y,button:'left',buttons:0,clickCount:1})
      result.selection=await pageCdp.evaluate('probe.selection()')
      if(result.selection!=='python')throw Error('Selection coordinates do not match text: '+result.selection)
      result.geometryChecks=await pageCdp.evaluate('probe.geometryChecks()')
      if(result.comparison.differentPixels)throw Error('Aligned glyphs differ from the Canvas2D reference')
    }
    report.samples.push({name,...result})
    console.log(JSON.stringify({name,dpr:result.dpr,cell:result.dimensions.device.cell,comparison:result.comparison}))
  }
  report.complete=true
} finally {
  if(browser){await recordOwned();try{await browserCdp?.call('Browser.close')}catch{};pageCdp?.close();browserCdp?.close();await pause(700)}
  await server?.close()
  let remaining=(await processes()).filter(p=>owned.some(old=>old.ProcessId===p.ProcessId&&old.CreationDate===p.CreationDate))
  for(const p of remaining)try{process.kill(p.ProcessId)}catch{}
  if(remaining.length)await pause(300)
  remaining=(await processes()).filter(p=>owned.some(old=>old.ProcessId===p.ProcessId&&old.CreationDate===p.CreationDate))
  report.cleanup={owned,remaining}
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({cleanupRemaining:remaining.map(p=>p.ProcessId),output}))
  if(remaining.length)process.exitCode=1
}
