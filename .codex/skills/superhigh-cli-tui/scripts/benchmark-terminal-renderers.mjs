import { parseArgs } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import { createServer } from 'vite'

export const FIELD_CONSUMERS = {
  complete: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Reject unfinished benchmark batches.' },
  cleanup: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Stop reporting while owned test processes remain.' },
  correctness: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Check paired output and sampled screenshot pixels.' },
  runs: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Compare paired throughput and CPU cost for identical input.' },
  replay: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Report public write latency separately from GPU-fenced stress.' },
  versions: { 'superhigh-cli-tui/references/renderer-benchmark.md': 'Check dependency versions before comparing batches.' },
  sourceHashes: { 'superhigh-cli-tui/references/renderer-benchmark.md': 'Identify the benchmark source used by each retained batch.' },
  scaling: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Label native scaling from the measured process setting.' },
  environment: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Identify the measured font and browser context.' },
  systemGpu: { 'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Attribute hardware-specific results to the measured GPU.' },
}

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/renderer-benchmark')
const { values: args } = parseArgs({ options: {
  deps: { type: 'string' }, capture: { type: 'string' }, output: { type: 'string' },
  browser: { type: 'string', default: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  rounds: { type: 'string', default: '5' }, updates: { type: 'string', default: '512' },
  port: { type: 'string', default: '1438' }, 'cdp-port': { type: 'string', default: '9348' },
  smoke: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  'checks-only': { type: 'boolean', default: false }, dprs: { type: 'string', default: '1' },
  'native-scale': { type: 'string' },
  'timing-only': { type: 'boolean', default: false }, scenes: { type: 'string', default: 'sparse,logs,dense' },
} })
if (args.help || !args.deps || !args.capture || !args.output) {
  console.log('Usage: node benchmark-terminal-renderers.mjs --deps <isolated npm project> --capture <record-codex-terminal JSON> --output <report directory> [--rounds 5] [--updates 512] [--smoke | --checks-only | --timing-only] [--scenes sparse,logs,dense] [--dprs 1,1.5] [--native-scale 1.5] [--browser <Edge executable>] [--port 1438] [--cdp-port 9348]')
  console.log('Requires pinned @xterm/xterm 6.0.0, addon-webgl 0.19.0, addon-fit 0.11.0, addon-serialize 0.14.0 and wraithterm 0.6.1. Uses an isolated hardware-verified Edge profile, never the running desktop instance. Public replay and private GPU-fenced pipeline are reported separately. All task processes are closed.')
  process.exit(args.help ? 0 : 2)
}
const deps = path.resolve(args.deps)
const capture = path.resolve(args.capture)
const output = path.resolve(args.output)
const rounds = Number(args.rounds)
const updates = Number(args.updates)
const dprs = args.dprs.split(',').map(Number)
if (dprs.some(value => ![1, 1.25, 1.5, 2].includes(value))) throw Error('Unsupported DPR')
const sceneNames = args.scenes.split(',')
if (sceneNames.some(scene => !['sparse', 'logs', 'dense'].includes(scene))) throw Error('Unsupported scene')
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 12 || !Number.isInteger(updates) || updates < 64 || updates > 8192) throw Error('Invalid rounds or updates')
if (!deps.startsWith(path.join(root, '.agent', 'tmp') + path.sep)) throw Error('--deps must be an isolated project inside this workspace .agent/tmp')
await fs.mkdir(output, { recursive: true })
const startedAt = new Date().toISOString()
const profile = path.join(deps, `edge-profile-${Date.now()}`)
const cdpOrigin = `http://127.0.0.1:${Number(args['cdp-port'])}`
const pageUrl = `http://127.0.0.1:${Number(args.port)}/`
const report = { schema: 'superhigh.terminal-renderer-benchmark.v1', startedAt,
  scope: 'Isolated Edge Chromium on this Windows machine; real Codex recording replay and synthetic Codex-style stress; no live Tauri IPC comparison',
  versions: {}, environment: null, browser: null, systemGpu: null, correctness: [], replay: [], lifecycle: [], runs: [],
  browserErrors: [], cleanup: null, complete: false,
  sources: ['https://github.com/betterclever/wraithterm/blob/main/demo/compare.js', 'https://github.com/betterclever/wraithterm/blob/main/docs/XTERM_API.md'],
}
report.hostCpu = cpus()[0]?.model ?? null
report.scaling = { processScale: Number(args['native-scale'] ?? '1'), emulatedDprs: dprs,
  emulationMismatchIsDiagnosticOnly: dprs.some(dpr => dpr !== Number(args['native-scale'] ?? '1')) }
report.sourceHashes = Object.fromEntries(await Promise.all(['app.ts', 'index.html'].map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(assets, file))).digest('hex')])))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = value => console.log(JSON.stringify(value))
const save = () => fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2), 'utf8')
let vite, browser, browserCdp, pageCdp
const owned = []

class Cdp {
  pending = new Map()
  sequence = 0
  listeners = []
  constructor(url) {
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(Error('CDP connection failed')), { once: true })
    })
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id)
        clearTimeout(request.timer)
        message.error ? request.reject(Error(`${request.method}: ${message.error.message}`)) : request.resolve(message.result)
      } else this.listeners.forEach(listener => listener(message))
    })
    this.ws.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('CDP closed')) }
      this.pending.clear()
    })
  }
  async call(method, params = {}, timeout = 120000) {
    await this.ready
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer, method })
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

async function processTable() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress'],
    { windowsHide: true, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}
async function recordOwnedTree() {
  if (!browser) return
  const table = await processTable()
  const ids = new Set([process.pid, browser.pid])
  let prior
  do { prior = ids.size; for (const p of table) if (ids.has(p.ParentProcessId)) ids.add(p.ProcessId) } while (ids.size !== prior)
  for (const p of table) if (p.ProcessId !== process.pid && ids.has(p.ProcessId) && !owned.some(old => old.ProcessId === p.ProcessId && old.CreationDate === p.CreationDate)) owned.push(p)
}
async function version(name, expected) {
  const json = JSON.parse(await fs.readFile(path.join(deps, 'node_modules', name, 'package.json'), 'utf8'))
  if (json.version !== expected) throw Error(`${name}: expected ${expected}, found ${json.version}`)
  report.versions[name] = json.version
  return json
}
async function screenshot(name, clip) {
  const result = await pageCdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
  await fs.writeFile(path.join(output, name), Buffer.from(result.data, 'base64'))
  return name
}
function checkPaired(a, b, label) {
  const checks = ['textSha256', 'visibleSha256', 'lineCount', 'cursorX', 'cursorY', 'baseY', 'viewportY', 'cols', 'rows']
  const mismatches = checks.filter(key => a[key] !== b[key])
  if (mismatches.length) throw Error(`${label}: paired terminal state differs: ${mismatches.join(', ')}`)
}
async function measured(expression) {
  const before = await browserCdp.call('SystemInfo.getProcessInfo')
  const started = performance.now()
  const result = await pageCdp.evaluate(expression)
  const wallMs = performance.now() - started
  const after = await browserCdp.call('SystemInfo.getProcessInfo')
  const cpu = after.processInfo.map(p => ({ type: p.type, pid: p.id,
    seconds: p.cpuTime - (before.processInfo.find(old => old.id === p.id)?.cpuTime ?? p.cpuTime) }))
  result.processSample = { wallMs, cpu, scope: 'Whole isolated call, including initialization/warmup/validation; CPU seconds across dedicated browser processes' }
  return result
}

try {
  for (const [name, expected] of Object.entries({ '@xterm/xterm': '6.0.0', '@xterm/addon-webgl': '0.19.0',
    '@xterm/addon-fit': '0.11.0', '@xterm/addon-serialize': '0.14.0', wraithterm: '0.6.1' })) await version(name, expected)
  const { wraith } = await import(pathToFileURL(path.join(deps, 'node_modules/wraithterm/dist/vite.js')).href)
  const modulePath = (name, filename) => path.join(deps, 'node_modules', name, filename).replaceAll('\\', '/')
  const appPath = path.join(assets, 'app.ts').replaceAll('\\', '/')
  vite = await createServer({ configFile: false, root: deps, cacheDir: path.join(deps, '.vite'), publicDir: false,
    logLevel: 'warn', resolve: { alias: [
      { find: '@bench/xterm.css', replacement: modulePath('@xterm/xterm', 'css/xterm.css') },
      { find: '@bench/xterm', replacement: modulePath('@xterm/xterm', 'lib/xterm.mjs') },
      { find: '@bench/webgl', replacement: modulePath('@xterm/addon-webgl', 'lib/addon-webgl.mjs') },
      { find: '@bench/fit', replacement: modulePath('@xterm/addon-fit', 'lib/addon-fit.mjs') },
      { find: '@bench/serialize', replacement: modulePath('@xterm/addon-serialize', 'lib/addon-serialize.mjs') },
      { find: 'wraithterm/xterm', replacement: modulePath('wraithterm', 'dist/xterm.js') },
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    optimizeDeps: { noDiscovery: true, include: [], exclude: ['@bench/xterm', '@bench/webgl', '@bench/fit', '@bench/serialize', 'wraithterm/xterm'] },
    server: { host: '127.0.0.1', port: Number(args.port), strictPort: true, fs: { allow: [root] } },
    plugins: [wraith(), { name: 'superhigh-renderer-benchmark', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url, pageUrl).pathname
        if (pathname === '/favicon.ico') {
          response.statusCode = 204
          response.end()
        } else if (pathname === '/__recording') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(await fs.readFile(capture, 'utf8'))
        } else if (pathname === '/' || pathname === '/index.html') {
          const source = (await fs.readFile(path.join(assets, 'index.html'), 'utf8')).replace('/__bench/app.ts', `/@fs/${appPath}`)
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(await server.transformIndexHtml('/', source))
        } else next()
      })
    } }],
  })
  await vite.listen()
  const browserArgs = ['--headless=new', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${Number(args['cdp-port'])}`,
    '--remote-debugging-address=127.0.0.1', '--window-size=2600,1900',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--force-device-scale-factor=${Number(args['native-scale'] ?? '1')}`,
    'about:blank']
  browser = spawn(args.browser, browserArgs, { windowsHide: true, stdio: 'ignore' })
  await fs.writeFile(path.join(output, 'processes.json'), JSON.stringify({ startedAt, nodePid: process.pid, browserPid: browser.pid,
    browserExecutable: args.browser, browserArgs, profile, pageUrl, cdpOrigin }, null, 2))
  log({ stage: 'browser-started', browserPid: browser.pid, profile, pageUrl })
  let endpoint
  for (let i = 0; i < 100; i++) {
    try { endpoint = await (await fetch(`${cdpOrigin}/json/version`, { signal: AbortSignal.timeout(500) })).json(); break } catch { await pause(100) }
  }
  if (!endpoint) throw Error('Isolated Edge CDP endpoint unavailable')
  await recordOwnedTree()
  browserCdp = new Cdp(endpoint.webSocketDebuggerUrl)
  report.browser = await browserCdp.call('Browser.getVersion')
  const info = await browserCdp.call('SystemInfo.getInfo')
  report.systemGpu = info.gpu
  const target = await browserCdp.call('Target.createTarget', { url: pageUrl })
  const targets = await (await fetch(`${cdpOrigin}/json/list`)).json()
  const page = targets.find(item => item.id === target.targetId)
  if (!page) throw Error('Benchmark target unavailable')
  pageCdp = new Cdp(page.webSocketDebuggerUrl)
  await pageCdp.call('Runtime.enable')
  await pageCdp.call('Log.enable')
  pageCdp.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      report.browserErrors.push(message.params)
      log({ stage: 'browser-error', error: message.params.exceptionDetails?.text ?? message.params.entry?.text })
    }
  })
  await pageCdp.call('Emulation.setDeviceMetricsOverride', { width: 2600, height: 1900, deviceScaleFactor: dprs[0], mobile: false })
  for (let i = 0; i < 150; i++) {
    if (await pageCdp.evaluate('Boolean(window.renderBench?.ready)')) break
    if (i === 149) throw Error('Benchmark page did not become ready')
    await pause(100)
  }
  report.environment = await pageCdp.evaluate('renderBench.environment()')
  log({ stage: 'hardware', browser: report.browser.product, gpu: report.environment.gpu, recording: report.environment.recording })
  if (!report.environment.gpu || report.environment.gpu.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(report.environment.gpu.description)) throw Error('Hardware WebGPU was not verified')
  const engines = ['xterm-webgl', 'wraith-webgpu']
  if (!args['timing-only']) {
  for (const dpr of dprs) {
    await pageCdp.call('Emulation.setDeviceMetricsOverride', { width: 2600, height: 1900, deviceScaleFactor: dpr, mobile: false })
    const pair = []
    for (const engine of engines) {
      log({ stage: 'correctness', engine, dpr })
      const result = await pageCdp.evaluate(`renderBench.correctness(${JSON.stringify(engine)})`)
      result.dpr = dpr
      if (args['checks-only']) {
        const fullImage = await pageCdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
        result.fullScreenshot = `${engine}-dpr-${dpr}-full.png`
        await fs.writeFile(path.join(output, result.fullScreenshot), Buffer.from(fullImage.data, 'base64'))
        result.afterFullScreenshot = await pageCdp.evaluate('renderBench.geometry()')
      }
      result.screenshot = await screenshot(`${engine}-dpr-${dpr}.png`, result.clip)
      result.afterScreenshot = await pageCdp.evaluate('renderBench.geometry()')
      if (args['checks-only'] && engine === 'xterm-webgl') {
        result.forcedResize = await pageCdp.evaluate('renderBench.forceResize()')
        result.forcedResizeScreenshot = await screenshot(`${engine}-dpr-${dpr}-forced-resize.png`, result.clip)
      }
      await pageCdp.evaluate('renderBench.focusInput()')
      await pageCdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', text: 'k', unmodifiedText: 'k', windowsVirtualKeyCode: 75 })
      await pageCdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 })
      result.keyboard = await pageCdp.evaluate('renderBench.readInput()')
      if (!result.keyboard.includes('k')) throw Error(`${engine} keyboard input failed`)
      report.correctness.push(result); pair.push(result)
      await save()
    }
    checkPaired(pair[0].original, pair[1].original, `fixture DPR ${dpr}`)
    checkPaired(pair[0].resized, pair[1].resized, `resize DPR ${dpr}`)
  }
  }
  if (!args['checks-only']) {
  await pageCdp.call('Emulation.setDeviceMetricsOverride', { width: 2600, height: 1900, deviceScaleFactor: 1, mobile: false })
  if (!args['timing-only']) {
  for (const engine of engines) {
    log({ stage: 'lifecycle', engine })
    report.lifecycle.push(await pageCdp.evaluate(`renderBench.lifecycle(${JSON.stringify(engine)})`))
    log({ stage: 'real-replay', engine })
    const replay = await measured(`renderBench.replay(${JSON.stringify(engine)}, ${args.smoke ? 2 : 7})`)
    replay.screenshot = await screenshot(`${engine}-codex-replay.png`, report.correctness.find(item => item.engine === engine && item.dpr === 1).clip)
    report.replay.push(replay)
    await save()
  }
  checkPaired(report.lifecycle[0].fingerprint, report.lifecycle[1].fingerprint, 'lifecycle')
  checkPaired(report.replay[0].fingerprint, report.replay[1].fingerprint, 'real Codex replay')
  }
  const scenes = args.smoke ? [['dense', 120, 40]] : [['sparse', 120, 40], ['logs', 120, 40], ['dense', 240, 80]].filter(item => sceneNames.includes(item[0]))
  for (let round = 0; round < (args.smoke ? 1 : rounds); round++) {
    for (const [scene, cols, rows] of scenes) {
      const order = (round + scenes.findIndex(s => s[0] === scene)) % 2 ? [...engines].reverse() : engines
      const pair = []
      for (const engine of order) {
        log({ stage: 'timing', round: round + 1, scene, engine, cols, rows })
        const result = await measured(`renderBench.pipeline(${JSON.stringify(engine)}, ${JSON.stringify(scene)}, ${cols}, ${rows}, ${args.smoke ? 64 : updates})`)
        result.round = round + 1
        if (round === 0 && scene === 'dense') result.screenshot = await screenshot(`${engine}-dense.png`, result.clip)
        report.runs.push(result); pair.push(result)
        log({ stage: 'measured', round: result.round, scene, engine, cpuP50: result.cpuMs.p50,
          cpuP95: result.cpuMs.p95, completedUpdatesPerSecond: result.completedUpdatesPerSecond })
        await save()
      }
      checkPaired(pair[0].fingerprint, pair[1].fingerprint, `round ${round + 1} ${scene}`)
      if (pair[0].payloadSha256 !== pair[1].payloadSha256 || pair[0].bytes !== pair[1].bytes) throw Error('Payload mismatch')
    }
  }
  if (!args.smoke && !args['timing-only']) {
    // Anthropic Mono 14px exposes xterm WebGL's floored cell width versus Wraith's fractional width.
    // Repeat at 15px as a separate, explicitly labeled equal-geometry control.
    for (let round = 0; round < 3; round++) {
      const pair = []
      for (const engine of round % 2 ? [...engines].reverse() : engines) {
        log({ stage: 'geometry-control', engine, round: round + 1, fontSize: 15 })
        const result = await measured(`renderBench.pipeline(${JSON.stringify(engine)}, "dense", 240, 80, ${updates}, 15)`)
        result.round = `geometry-${round + 1}`
        report.runs.push(result); pair.push(result)
        await save()
      }
      checkPaired(pair[0].fingerprint, pair[1].fingerprint, `geometry control ${round + 1}`)
    }
    for (const engine of [...engines].reverse()) {
      log({ stage: 'sustained', engine, updates: 4096 })
      const result = await measured(`renderBench.pipeline(${JSON.stringify(engine)}, "dense", 240, 80, 4096)`)
      result.round = 'sustained'
      report.runs.push(result)
      await save()
    }
    const pair = report.runs.filter(item => item.round === 'sustained')
    checkPaired(pair[0].fingerprint, pair[1].fingerprint, 'sustained')
  }
  }
  report.complete = true
} catch (error) {
  report.error = String(error.stack ?? error)
  log({ stage: 'failed', error: String(error.message ?? error) })
  process.exitCode = 1
} finally {
  if (pageCdp) {
    await pageCdp.evaluate('window.renderBench?.dispose()').catch(() => {})
    pageCdp.close()
  }
  await recordOwnedTree().catch(() => {})
  if (browserCdp) { await browserCdp.call('Browser.close', {}, 8000).catch(() => {}); browserCdp.close() }
  if (vite) await vite.close()
  const esbuild = await import('esbuild')
  esbuild.stop()
  await pause(1200)
  let remaining = (await processTable()).filter(current => owned.some(p => p.ProcessId === current.ProcessId && p.CreationDate === current.CreationDate))
  for (const item of remaining) await execFileAsync('taskkill.exe', ['/PID', String(item.ProcessId), '/F'], { windowsHide: true }).catch(() => {})
  if (remaining.length) {
    await pause(500)
    remaining = (await processTable()).filter(current => owned.some(p => p.ProcessId === current.ProcessId && p.CreationDate === current.CreationDate))
  }
  report.cleanup = { owned, remaining, browserProfile: profile, browserClosed: remaining.length === 0, viteClosed: true }
  if (remaining.length) { report.complete = false; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await save()
  log({ stage: 'finished', complete: report.complete, report: path.join(output, 'results.json'), remainingProcesses: remaining.length })
}
