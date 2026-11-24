import { Terminal as Xterm } from '@bench/xterm'
import { Terminal as Wraith } from 'wraithterm/xterm'
import { WebglAddon } from '@bench/webgl'
import { SerializeAddon } from '@bench/serialize'
import { FitAddon } from '@bench/fit'
import '@bench/xterm.css'
import { applyFontStyle } from '@/lib/fontStyles'
import { applyTheme, buildTerminalTheme } from '@/lib/theme'
import { getTypographyWeights } from '@/lib/typography'
import { TerminalColorAdapter } from '@/lib/terminalColors'
import { CodexTerminalRenderer } from '@/lib/codexTerminalRenderer'

type Engine = 'xterm-webgl' | 'wraith-webgpu'
const host = document.querySelector<HTMLDivElement>('#host')!
const status = document.querySelector<HTMLSpanElement>('#status')!
let active: any = null
let recording: any
const encoder = new TextEncoder()
const frameStart = '\x1b[?2026h'
const frameEnd = '\x1b[?2026l'
const frames = (count = 2) => new Promise<void>(resolve => {
  const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next)
  requestAnimationFrame(next)
})
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
  .map(n => n.toString(16).padStart(2, '0')).join('')
const timeout = <T>(promise: Promise<T>, ms: number, label: string) => {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function stats(samples: number[]) {
  const values = [...samples].sort((a, b) => a - b)
  const at = (percent: number) => values[Math.min(values.length - 1, Math.floor(values.length * percent))] ?? 0
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    p50: at(.5), p95: at(.95), p99: at(.99), max: values.at(-1) ?? 0 }
}
function rendererOf(term: any) { return term._core._renderService._renderer.value }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message) }

function geometry() {
  const renderer = rendererOf(active.term)
  const gl = renderer._gl
  const glyph = renderer._glyphRenderer?.value
  const resolution = gl && glyph?._program && glyph?._resolutionLocation
    ? gl.getUniform(glyph._program, glyph._resolutionLocation) : null
  return { dpr: devicePixelRatio, coreDpr: active.term._core._coreBrowserService.dpr,
    dimensions: structuredClone(renderer.dimensions),
    gl: gl ? { viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      canvas: [gl.canvas.width, gl.canvas.height], resolution: resolution ? Array.from(resolution) : null } : null }
}

async function fence(item = active) {
  const renderer = rendererOf(item.term)
  if (item.engine === 'wraith-webgpu') {
    assert(item.term.renderer === 'webgpu', `Wraith fallback: ${item.term.rendererFallbackReason}`)
    await timeout(renderer.gpu.fence(), 10000, 'Wraith GPU fence')
    return
  }
  const gl: WebGL2RenderingContext = renderer._gl
  assert(gl && !gl.isContextLost(), 'WebGL context unavailable')
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  assert(sync, 'WebGL fence unavailable')
  gl.flush()
  const start = performance.now()
  try {
    while (true) {
      const result = gl.clientWaitSync(sync, 0, 0)
      if (result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED) return
      assert(result !== gl.WAIT_FAILED, 'WebGL fence failed')
      assert(performance.now() - start < 10000, 'WebGL fence timed out')
      await sleep(0)
    }
  } finally { gl.deleteSync(sync) }
}

function dispose() {
  if (active) { active.term.dispose(); active = null }
  host.replaceChildren()
}

async function create(engine: Engine, cols = 120, rows = 40, theme = 'dark', fontSize = 14) {
  dispose()
  applyTheme(theme)
  await document.fonts.ready
  const style = getComputedStyle(document.documentElement)
  const weights = getTypographyWeights()
  const options = { cols, rows, fontFamily: style.getPropertyValue('--font-mono').trim(), fontSize,
    fontWeight: weights.mono, fontWeightBold: weights.strong, cursorBlink: false, minimumContrastRatio: 4.5,
    scrollback: 10000, convertEol: true, smoothScrollDuration: 0, allowTransparency: false,
    allowProposedApi: true, theme: buildTerminalTheme(theme),
    linkHandler: { activate: (_event: Event, url: string) => active?.links.push(url), allowNonHttpProtocols: true } }
  await document.fonts.load(`${options.fontWeight} ${options.fontSize}px ${options.fontFamily}`)
  const started = performance.now()
  const term: any = new (engine === 'xterm-webgl' ? Xterm : Wraith)(options)
  const serialize = new SerializeAddon()
  const fit = new FitAddon()
  term.loadAddon(serialize)
  term.loadAddon(fit)
  term.open(host)
  const contextLoss: string[] = []
  if (engine === 'xterm-webgl') {
    const addon = new WebglAddon()
    addon.onContextLoss(() => contextLoss.push('webglcontextlost'))
    term.loadAddon(addon)
  } else {
    assert(await timeout(term.webgpuReady, 15000, 'Wraith initialization'), `Wraith initialization failed: ${term.rendererFallbackReason}`)
    assert(term.renderer === 'webgpu', `Wraith is using ${term.renderer}`)
  }
  active = { term, engine, serialize, fit, contextLoss, input: [] as string[], links: [] as string[], options }
  term.onData((data: string) => active?.input.push(data))
  await frames(3)
  await fence()
  const renderer = rendererOf(term)
  const dims = renderer.dimensions ?? term._core._renderService.dimensions
  host.style.width = `${Math.ceil(dims.css.canvas.width) + 16}px`
  host.style.height = `${Math.ceil(dims.css.canvas.height) + 16}px`
  status.textContent = `${engine} · ${cols} × ${rows} · DPR ${devicePixelRatio}`
  return { coldReadyMs: performance.now() - started, dimensions: structuredClone(dims), options,
    renderer: engine === 'wraith-webgpu' ? term.renderer : 'webgl', fallback: term.rendererFallbackReason ?? null }
}

async function write(data: string) {
  const term = active.term
  await timeout(new Promise<void>(resolve => term.write(data, resolve)), 20000, 'Terminal.write')
}

async function painted() {
  await frames(2)
  await fence()
}

async function fingerprint() {
  const term = active.term
  const buffer = term.buffer.active
  const text: string[] = []
  const visible: string[] = []
  const attributes: unknown[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    text.push(`${line.isWrapped ? 1 : 0}:${line.translateToString(false)}`)
    if (i >= buffer.viewportY && i < buffer.viewportY + term.rows) {
      visible.push(line.translateToString(true))
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x)
        attributes.push([cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getFgColorMode(),
          cell.getBgColor(), cell.getBgColorMode(), cell.isBold(), cell.isItalic(), cell.isUnderline(),
          cell.isInverse(), cell.isInvisible(), cell.isDim(), cell.isStrikethrough()])
      }
    }
  }
  return { textSha256: await digest(text.join('\n')), visibleSha256: await digest(JSON.stringify(attributes)),
    lineCount: buffer.length, cursorX: buffer.cursorX, cursorY: buffer.cursorY, baseY: buffer.baseY,
    viewportY: buffer.viewportY, visible, cols: term.cols, rows: term.rows }
}

function fixture() {
  const put = (row: number, text: string) => `\x1b[${row};1H${text}\x1b[0m\x1b[K`
  return '\x1bc' + frameStart +
    put(1, '\x1b[1;36mCodex CLI / GPT-6.1-Terra / renderer verification') +
    put(3, '中文检查：终端、文件路径、日志滚动、代码差异。') +
    put(4, '宽字符与组合字符：测试中文 e\u0301 A\u0308 Ω → ✓ 🦀 🚀') +
    put(6, '\x1b[35mconst\x1b[0m message = \x1b[32m"中文与 ASCII 混排"\x1b[0m;') +
    put(7, '\x1b[31m- const retries = 2;\x1b[0m') +
    put(8, '\x1b[32m+ const retries = 3;\x1b[0m') +
    put(10, '╭' + '─'.repeat(26) + '╮') + put(11, '│' + ' Codex output: 42 / 64'.padEnd(26) + '│') +
    put(12, '╰' + '─'.repeat(26) + '╯') +
    put(14, '\x1b[48;2;220;40;60m          \x1b[48;2;30;180;70m          \x1b[48;2;40;90;230m          ') +
    put(16, '\x1b]8;;https://example.invalid/codex-test\x07可点击链接：Codex fixture\x1b]8;;\x07') +
    put(18, 'src/terminal.ts:42:7  D:\\workspace\\中文目录\\fixture.rs') +
    put(20, '\x1b[1m粗体\x1b[0m  \x1b[3mitalic\x1b[0m  \x1b[4munderline\x1b[0m  \x1b[2mdim\x1b[0m') +
    put(22, '输入与选择区：') + '\x1b[24;1H' + frameEnd
}

async function correctness(engine: Engine, theme = 'dark') {
  const creation = await create(engine, 120, 40, theme)
  await write(fixture())
  await painted()
  // Atlas growth can require a follow-up redraw, as in the upstream comparison harness.
  active.term.refresh(0, active.term.rows - 1)
  await painted()
  const original = await fingerprint()
  active.term.select(0, 0, 5)
  const selection = active.term.getSelection()
  active.term.clearSelection()
  assert(selection === 'Codex', `Selection mismatch: ${selection}`)
  const snapshot = active.serialize.serialize()
  active.term.reset()
  await write(snapshot)
  await painted()
  const restored = await fingerprint()
  const restoreMatches = original.visibleSha256 === restored.visibleSha256
  assert(restoreMatches, 'Serialize/restore changed visible cells')
  for (const [cols, rows] of [[80, 32], [140, 48], [120, 40]]) {
    active.term.resize(cols, rows)
    await painted()
  }
  const resized = await fingerprint()
  active.term.reset()
  await write(fixture())
  await painted()
  await write('\x1b[?2004h')
  active.term.paste('中文 paste 42')
  const paste = active.input.at(-1)
  assert(paste === '\x1b[200~中文 paste 42\x1b[201~', 'Bracketed paste mismatch')
  const term = active.term
  const rect = host.getBoundingClientRect()
  const canvas = host.querySelector('canvas')!
  const canvasRect = canvas.getBoundingClientRect()
  const dims = rendererOf(term).dimensions ?? term._core._renderService.dimensions
  const gl = engine === 'xterm-webgl' ? rendererOf(term)._gl : null
  const debug = gl?.getExtension('WEBGL_debug_renderer_info')
  return { engine, theme, creation, original, resized, restoreMatches, selection, paste,
    contextsLost: active.contextLoss, fitAvailable: Boolean(active.fit.proposeDimensions()),
    canvas: { width: canvas.width, height: canvas.height, cssWidth: canvasRect.width, cssHeight: canvasRect.height },
    hardware: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    clip: { x: rect.x, y: rect.y, width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 1 },
    pixelChecks: [
      { label: 'red', col: 4, row: 13, rgb: [220, 40, 60] },
      { label: 'green', col: 14, row: 13, rgb: [30, 180, 70] },
      { label: 'blue', col: 24, row: 13, rgb: [40, 90, 230] },
    ].map(check => ({ ...check,
      x: (canvasRect.x - rect.x + (check.col + .5) * dims.css.cell.width) * devicePixelRatio,
      y: (canvasRect.y - rect.y + (check.row + .5) * dims.css.cell.height) * devicePixelRatio })),
    geometry: geometry(), after: await fingerprint() }
}

function makePayloads(scene: string, cols: number, rows: number): string[] {
  const payloads: string[] = []
  for (let frame = 0; frame < 64; frame++) {
    let value = frameStart
    if (scene === 'sparse') {
      value += `\x1b[${rows - 2};1H\x1b[36mCodex working ${frame.toString().padStart(4, '0')} · ` +
        '⠋⠙⠹⠸⠼⠴⠦⠧'[frame % 8] + `\x1b[0m\x1b[K\x1b[${rows};1H› `
    } else if (scene === 'logs') {
      for (let line = 0; line < 32; line++) {
        value += `\x1b[${line % 4 === 0 ? 33 : 32}m[${String(frame * 32 + line).padStart(5, '0')}]\x1b[0m ` +
          `Codex fixture src/模块-${line}.ts:${frame + 1} checking output 中文日志 ${'abcdef0123456789'.repeat(3)}\r\n`
      }
    } else {
      for (let row = 0; row < rows; row++) {
        value += `\x1b[${row + 1};1H`
        for (let col = 0; col < cols; col += 5) {
          const color = 16 + (frame * 7 + row * 11 + col) % 216
          value += `\x1b[38;5;${color};48;5;${232 + (row + frame) % 20}m`
          value += Array.from({ length: Math.min(5, cols - col) }, (_, n) =>
            String.fromCharCode(33 + ((frame + row * 3 + col + n) % 90))).join('')
        }
      }
      value += '\x1b[0m'
    }
    payloads.push(value + frameEnd)
  }
  return payloads
}

async function pipeline(engine: Engine, scene: string, cols: number, rows: number, updates = 512, fontSize = 14) {
  const created = await create(engine, cols, rows, 'dark', fontSize)
  const term = active.term
  const renderer = rendererOf(term)
  const payloads = makePayloads(scene, cols, rows)
  const byteLengths = payloads.map(data => encoder.encode(data).byteLength)
  const payloadSha256 = await digest(payloads.join(''))
  if (scene === 'sparse') { await write(makePayloads('dense', cols, rows)[0]); await painted() }
  // Same isolated synchronous pipeline as upstream demo/compare.js; never reuse this terminal for public-API measurements.
  const service = term._core._renderService
  service._renderDebouncer.dispose()
  service._observerDisposable.clear()
  service.refreshRows = () => {}
  if (renderer.timer) clearInterval(renderer.timer)
  const parse = (data: string) => {
    const result = term._core._inputHandler.parse(data)
    assert(!result?.then, 'Async parser encountered in synchronous benchmark')
  }
  const draw = () => { renderer.renderRows(0, rows - 1); void host.offsetHeight }
  for (let i = 0; i < 64; i++) {
    parse(payloads[i]); draw()
    if ((i + 1) % 32 === 0) await fence()
  }
  await fence()
  const parseMs: number[] = []
  const drawMs: number[] = []
  const cpuMs: number[] = []
  const beforeFrames = renderer.gpu?.frames == null ? null : Number(renderer.gpu.frames)
  const started = performance.now()
  let bytes = 0
  for (let i = 0; i < updates; i++) {
    const data = payloads[i % payloads.length]
    const t0 = performance.now()
    parse(data)
    const t1 = performance.now()
    draw()
    const t2 = performance.now()
    parseMs.push(t1 - t0); drawMs.push(t2 - t1); cpuMs.push(t2 - t0)
    bytes += byteLengths[i % byteLengths.length]
    if ((i + 1) % 32 === 0) await fence()
  }
  await fence()
  const elapsedMs = performance.now() - started
  const submitted = beforeFrames == null ? null : Number(renderer.gpu.frames) - beforeFrames
  assert(submitted == null || submitted === updates, `Wraith submitted ${submitted}, expected ${updates}`)
  const rect = host.getBoundingClientRect()
  const canvas = engine === 'xterm-webgl' ? renderer._canvas : renderer.canvas
  const canvasRect = canvas.getBoundingClientRect()
  const dimensions = renderer.dimensions
  const finalFrame = (updates - 1) % 64
  const pixelChecks = scene === 'dense' ? [0, Math.floor(rows / 2), rows - 1].flatMap(row =>
    [1, Math.floor(cols / 2), cols - 2].map(col => {
      const gray = 8 + (row + finalFrame) % 20 * 10
      return { label: `row-${row}-col-${col}`, rgb: [gray, gray, gray],
        x: (canvasRect.x - rect.x + col * dimensions.css.cell.width + 1) * devicePixelRatio,
        y: (canvasRect.y - rect.y + (row + 1) * dimensions.css.cell.height - 1) * devicePixelRatio }
    })) : []
  const result = { engine, scene, cols, rows, fontSize, dpr: devicePixelRatio, updates, bytes, payloadSha256,
    elapsedMs, completedUpdatesPerSecond: updates * 1000 / elapsedMs, mibPerSecond: bytes / 1048576 * 1000 / elapsedMs,
    parseMs: stats(parseMs), drawMs: stats(drawMs), cpuMs: stats(cpuMs), submitted,
    renderer: engine === 'wraith-webgpu' ? term.renderer : 'webgl', contextLoss: active.contextLoss,
    fingerprint: await fingerprint(), dimensions: created.dimensions, pixelChecks,
    clip: { x: rect.x, y: rect.y, width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 1 },
    method: 'Private parse + renderRows; 64 warmup; GPU fence each 32 updates and at end; not physical display FPS' }
  return result
}

async function replay(engine: Engine, repeats = 5) {
  await create(engine, recording.cols, recording.rows)
  const source = recording.chunks.map((chunk: any) => chunk.data).join('')
  const colors = new TerminalColorAdapter()
  const codex = new CodexTerminalRenderer(recording.cols, recording.rows)
  const term = active.term
  let renders = 0
  const listener = term.onRender(() => renders++)
  const loopMs: number[] = []
  const prepareMs: number[] = []
  const parseCallbackMs: number[] = []
  const lagMs: number[] = []
  let heartbeatAt = performance.now()
  const heartbeat = setInterval(() => { const now = performance.now(); lagMs.push(Math.max(0, now - heartbeatAt - 16)); heartbeatAt = now }, 16)
  try {
    for (let i = 0; i <= repeats; i++) {
      const t0 = performance.now()
      term.reset(); colors.reset(); codex.reset()
      const output = colors.transform(codex.render(source), 'dark')
      const t1 = performance.now()
      await write(output)
      const t2 = performance.now()
      await painted()
      const t3 = performance.now()
      if (i) { prepareMs.push(t1 - t0); parseCallbackMs.push(t2 - t1); loopMs.push(t3 - t0) }
    }
  } finally { clearInterval(heartbeat); listener.dispose() }
  const result = { engine, scenario: 'real-codex-recording', model: recording.native.model, bytes: recording.bytes,
    recordingSha256: recording.sha256, repeats, dpr: devicePixelRatio, preprocessMs: stats(prepareMs),
    writeCallbackMs: stats(parseCallbackMs), completedReplayMs: stats(loopMs), heartbeatDelayMs: stats(lagMs),
    renderEvents: renders, fingerprint: await fingerprint(), contextLoss: active.contextLoss,
    method: 'Fresh terminal; public write with actual SuperHigh color/frame adapters; parse callback then two rAF + GPU fence; 1 warmup' }
  return result
}

async function lifecycle(engine: Engine) {
  await create(engine, 120, 40)
  const term = active.term
  const lines = Array.from({ length: 2500 }, (_, i) => `${String(i).padStart(5, '0')} Codex history 中文与滚动 ${'abcdefgh'.repeat(8)}\r\n`).join('')
  await write(lines)
  await painted()
  const bottom = await fingerprint()
  term.scrollLines(-1000)
  await painted()
  const scrolled = await fingerprint()
  assert(scrolled.viewportY < bottom.viewportY, 'History did not scroll')
  host.style.visibility = 'hidden'
  await write('后台输出 BUFFER_WHILE_HIDDEN\r\n')
  await frames(2)
  host.style.visibility = ''
  term.scrollToBottom()
  await painted()
  const returned = await fingerprint()
  assert(returned.visible.some(line => line.includes('BUFFER_WHILE_HIDDEN')), 'Hidden output missing after returning')
  const restore = active.serialize.serialize()
  const oldTerm = term
  await create(engine, 120, 40)
  await write(restore)
  await painted()
  const revived = await fingerprint()
  const result = { engine, historyLines: bottom.lineCount, scrollDelta: bottom.viewportY - scrolled.viewportY,
    hiddenOutputPreserved: true, recreatedSnapshotMatches: returned.visibleSha256 === revived.visibleSha256,
    fingerprint: revived, disposedPrevious: oldTerm !== active.term, contextLoss: active.contextLoss }
  assert(result.recreatedSnapshotMatches, 'Recreated terminal lost snapshot content')
  return result
}

async function environment() {
  const adapter = await (navigator as any).gpu?.requestAdapter()
  const info = adapter?.info
  return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
    gpu: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null,
    font: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    recording: { bytes: recording.bytes, chunks: recording.chunks.length, sha256: recording.sha256,
      model: recording.native.model, status: recording.status, tokens: recording.native.token_usage } }
}

applyFontStyle('anthropic')
applyTheme('dark')
recording = await (await fetch('/__recording')).json()
assert(recording.status === 'complete' && recording.requestedModel && recording.native?.model === recording.requestedModel, 'Require a completed recording of the requested Codex model')
assert(!recording.remainingProcesses?.length, 'Codex capture processes still require cleanup')
;(window as any).renderBench = {
  ready: true, environment, correctness, pipeline, replay, lifecycle, fingerprint, dispose, fence, geometry,
  forceResize: async () => { rendererOf(active.term).handleResize(active.term.cols, active.term.rows); active.term.refresh(0, active.term.rows - 1); await painted(); return geometry() },
  focusInput: () => { active.input.length = 0; active.term.focus(); return true },
  readInput: () => [...active.input],
  activateLinkResult: () => [...active.links],
  showSummary: (value: unknown) => { document.querySelector('#summary')!.textContent = JSON.stringify(value, null, 2) },
}
status.textContent = '已准备好：同一份 Codex 录制，两套 GPU 渲染器'
