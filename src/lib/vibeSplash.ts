// SuperHigh Vibe 启动场景：画布负责星流、聚能、冲击波、电弧与退场光圈，DOM 负责标志、标题与充能条。
// 时间轴以 impactMs 为冲击帧；AppSplash 把它写入 CSS 变量 --impact，两侧共用同一时刻。
export const VIBE_SPLASH = {
  focusY: 0.44,
  impactMs: 1000,
  minVisibleMs: 2300,
  exitMs: 680,
} as const

export interface VibeSplashScene {
  leave(onDone: () => void): void
  dispose(): void
}

type Rgb = readonly [number, number, number]
type Point = [number, number]

interface Star { x: number; y: number; z: number; color: number }
interface Mote { a0: number; r0: number; spin: number; born: number; life: number; color: number; px: number; py: number }
interface Spark { x: number; y: number; vx: number; vy: number; age: number; life: number; color: number }
interface Ring { born: number; life: number; color: number; width: number; reach: number; inward?: boolean }
interface Arc { main: Point[]; branch: Point[] | null; born: number; life: number; color: number }

const STAR_COUNT = 280
const SPARK_COUNT = 220
const MARK_RADIUS_CSS = 60

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInCubic = (t: number) => t ** 3
const easeInOutQuart = (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2)

// 中点位移生成锯齿电弧。
function lightning(from: Point, to: Point, spread: number, depth: number): Point[] {
  let points: Point[] = [from, to]
  let offset = spread
  for (let level = 0; level < depth; level += 1) {
    const next: Point[] = [points[0]]
    for (let index = 1; index < points.length; index += 1) {
      const [ax, ay] = points[index - 1]
      const [bx, by] = points[index]
      const length = Math.hypot(bx - ax, by - ay) || 1
      const shift = (Math.random() - 0.5) * offset
      next.push([(ax + bx) / 2 + (-(by - ay) / length) * shift, (ay + by) / 2 + ((bx - ax) / length) * shift], points[index])
    }
    points = next
    offset /= 2
  }
  return points
}

export function startVibeSplash(host: HTMLElement, canvas: HTMLCanvasElement, palette: readonly string[], coreHex: string): VibeSplashScene {
  const ctx = canvas.getContext('2d')
  const colors = palette.map(hexToRgb)
  const core = hexToRgb(coreHex)
  const startedAt = performance.now()
  let width = 0
  let height = 0
  let dpr = 1
  let cx = 0
  let cy = 0
  let unit = 0
  let frame = 0
  let lastTime = startedAt
  let impacted = false
  let imploded = false
  let absorbed = 0
  let nextMoteAt = 380
  let nextArcAt = VIBE_SPLASH.impactMs
  let nextPulseAt = VIBE_SPLASH.impactMs + 900
  let exitStart: number | null = null
  let exitDone: (() => void) | null = null
  let exitFallback: number | undefined
  let finished = false

  const stars: Star[] = Array.from({ length: STAR_COUNT }, () => spawnStar(Math.random()))
  const motes: Mote[] = []
  const sparks: Spark[] = []
  const rings: Ring[] = []
  const arcs: Arc[] = []

  function spawnStar(z = 1): Star {
    const z0 = 0.08 + z * 0.92
    return { x: (Math.random() * 2 - 1) * 0.9, y: (Math.random() * 2 - 1) * 0.9, z: z0, color: Math.floor(Math.random() * colors.length) }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    const nextWidth = Math.max(1, Math.round(host.clientWidth * dpr))
    const nextHeight = Math.max(1, Math.round(host.clientHeight * dpr))
    // 重设画布尺寸会清空画面，尺寸未变时跳过。
    if (nextWidth === width && nextHeight === height) return
    width = nextWidth
    height = nextHeight
    canvas.width = width
    canvas.height = height
    cx = width / 2
    cy = height * VIBE_SPLASH.focusY
    unit = Math.min(width, height)
  }

  // 起步加速冲进星流，聚能前刹停；冲击把星尘推开，退场时再次跃迁。
  function warpSpeed(t: number, exitProgress: number): number {
    let speed: number
    if (t < 600) speed = 0.06 + 1.7 * (t / 600) ** 2
    else if (t < 900) speed = 0.03 + 1.73 * (1 - easeOutCubic((t - 600) / 300))
    else speed = 0.03
    if (t >= VIBE_SPLASH.impactMs) speed += 0.85 * Math.exp(-(t - VIBE_SPLASH.impactMs) / 150)
    return speed + 3.4 * easeInCubic(exitProgress)
  }

  function project(x: number, y: number, z: number): Point {
    const focal = Math.max(width, height) * 0.5
    return [cx + (x / z) * focal, cy + (y / z) * focal]
  }

  function triggerImpact(t: number) {
    impacted = true
    for (let index = 0; index < SPARK_COUNT; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = unit * (0.5 + Math.random() ** 2 * 2.6)
      sparks.push({ x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, age: 0, life: 0.5 + Math.random() * 0.9, color: index % colors.length })
    }
    const reach = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))
    rings.push(
      { born: t, life: 900, color: 0, width: 18, reach },
      { born: t + 70, life: 1000, color: 1, width: 11, reach: reach * 0.85 },
      { born: t + 150, life: 1100, color: 2, width: 6, reach: reach * 0.7 },
    )
  }

  function spawnArc(t: number) {
    const angle = Math.random() * Math.PI * 2
    const start = (MARK_RADIUS_CSS + Math.random() * 6) * dpr
    const end = start + (36 + Math.random() * 130) * dpr
    const bend = angle + (Math.random() - 0.5) * 0.55
    const from: Point = [cx + Math.cos(angle) * start, cy + Math.sin(angle) * start]
    const to: Point = [cx + Math.cos(bend) * end, cy + Math.sin(bend) * end]
    const main = lightning(from, to, (end - start) * 0.5, 5)
    let branch: Point[] | null = null
    if (Math.random() < 0.45) {
      const root = main[Math.floor(main.length * (0.3 + Math.random() * 0.3))]
      const turn = bend + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5)
      const length = (end - start) * 0.45
      branch = lightning(root, [root[0] + Math.cos(turn) * length, root[1] + Math.sin(turn) * length], length * 0.5, 4)
    }
    arcs.push({ main, branch, born: t, life: 90 + Math.random() * 90, color: Math.random() < 0.5 ? 0 : 2 })
  }

  function strokePath(points: Point[]) {
    if (!ctx) return
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index][0], points[index][1])
    ctx.stroke()
  }

  function drawStars(t: number, dt: number, exitProgress: number) {
    if (!ctx) return
    const speed = warpSpeed(t, exitProgress)
    const fadeIn = clamp01(t / 320)
    for (let index = 0; index < stars.length; index += 1) {
      const star = stars[index]
      star.z -= speed * dt
      if (star.z <= 0.02) {
        stars[index] = spawnStar()
        continue
      }
      const [x, y] = project(star.x, star.y, star.z)
      if (x < -40 || x > width + 40 || y < -40 || y > height + 40) {
        stars[index] = spawnStar()
        continue
      }
      // 尾迹长度按当前速度取，不随帧间隔变化，高速时拉成光带。
      const [px, py] = project(star.x, star.y, Math.min(1.2, star.z + speed * 0.09))
      const near = 1 - star.z
      ctx.strokeStyle = rgba(colors[star.color], (0.25 + near * 0.75) * fadeIn)
      ctx.lineWidth = (0.5 + near * 2.2) * dpr
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(x + (x === px ? dpr : 0), y)
      ctx.stroke()
    }
  }

  function drawCharge(t: number) {
    if (!ctx || impacted) return
    if (t >= 380 && t < 920) {
      while (nextMoteAt <= t) {
        motes.push({
          a0: Math.random() * Math.PI * 2,
          r0: unit * (0.32 + Math.random() * 0.4),
          spin: 1.6 + Math.random() * 1.4,
          born: nextMoteAt,
          life: 300 + Math.random() * 220,
          color: Math.floor(Math.random() * colors.length),
          px: Number.NaN,
          py: Number.NaN,
        })
        nextMoteAt += 4
      }
    }
    ctx.lineCap = 'round'
    for (let index = motes.length - 1; index >= 0; index -= 1) {
      const mote = motes[index]
      const progress = (t - mote.born) / mote.life
      if (progress >= 1) {
        absorbed += 1
        motes.splice(index, 1)
        continue
      }
      const radius = mote.r0 * (1 - easeInCubic(progress))
      const angle = mote.a0 + mote.spin * progress * progress
      const x = cx + Math.cos(angle) * radius
      const y = cy + Math.sin(angle) * radius
      if (!Number.isNaN(mote.px)) {
        ctx.strokeStyle = rgba(colors[mote.color], clamp01(progress * 4))
        ctx.lineWidth = (1 + progress * 1.6) * dpr
        ctx.beginPath()
        ctx.moveTo(mote.px, mote.py)
        ctx.lineTo(x, y)
        ctx.stroke()
      }
      mote.px = x
      mote.py = y
    }
    ctx.lineCap = 'butt'

    // 聚能核心随吸收量膨胀，冲击前最后 80ms 坍缩成一个亮点。
    const collapse = t > 920 ? 1 - easeInCubic(clamp01((t - 920) / 80)) : 1
    const radius = (unit * 0.018 + Math.min(absorbed, 160) * unit * 0.00045) * collapse + 2 * dpr
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 3.2)
    glow.addColorStop(0, rgba(core, 0.95))
    glow.addColorStop(0.18, rgba(colors[0], 0.8))
    glow.addColorStop(0.5, rgba(colors[1], 0.32))
    glow.addColorStop(1, rgba(colors[2], 0))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, radius * 3.2, 0, Math.PI * 2)
    ctx.fill()

    if (t >= 780 && !imploded) {
      imploded = true
      rings.push({ born: 780, life: 220, color: 1, width: 3, reach: unit * 0.42, inward: true })
    }
  }

  function drawRings(t: number) {
    if (!ctx) return
    for (let index = rings.length - 1; index >= 0; index -= 1) {
      const ring = rings[index]
      const progress = (t - ring.born) / ring.life
      if (progress < 0) continue
      if (progress >= 1) {
        rings.splice(index, 1)
        continue
      }
      const radius = ring.inward ? ring.reach * (1 - easeInCubic(progress)) : ring.reach * easeOutCubic(progress)
      const fade = ring.inward ? clamp01(progress * 3) : (1 - progress) ** 1.5
      const color = colors[ring.color]
      ctx.strokeStyle = rgba(color, fade)
      ctx.lineWidth = (ring.width * (ring.inward ? 1 : 1 - progress) + 1) * dpr
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(radius, 0.1), 0, Math.PI * 2)
      ctx.stroke()
      if (!ring.inward && ring.width >= 10 && radius > 40 * dpr) {
        const band = ctx.createRadialGradient(cx, cy, radius - 40 * dpr, cx, cy, radius)
        band.addColorStop(0, rgba(color, 0))
        band.addColorStop(1, rgba(color, fade * 0.22))
        ctx.fillStyle = band
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  function drawSparks(dt: number) {
    if (!ctx) return
    const drag = Math.exp(-2.6 * dt)
    for (let index = sparks.length - 1; index >= 0; index -= 1) {
      const spark = sparks[index]
      spark.age += dt
      if (spark.age >= spark.life) {
        sparks.splice(index, 1)
        continue
      }
      spark.vx *= drag
      spark.vy *= drag
      spark.x += spark.vx * dt
      spark.y += spark.vy * dt
      const remain = 1 - spark.age / spark.life
      ctx.strokeStyle = rgba(colors[spark.color], remain ** 1.3)
      ctx.lineWidth = (0.4 + remain * 2) * dpr
      ctx.beginPath()
      ctx.moveTo(spark.x, spark.y)
      ctx.lineTo(spark.x - spark.vx * 0.035, spark.y - spark.vy * 0.035)
      ctx.stroke()
    }
  }

  function drawArcs(t: number, leaving: boolean) {
    if (!ctx || !impacted) return
    if (!leaving) {
      while (nextArcAt <= t) {
        spawnArc(t)
        if (Math.random() < 0.35) spawnArc(t)
        nextArcAt += t < VIBE_SPLASH.impactMs + 360 ? 35 + Math.random() * 35 : 150 + Math.random() * 130
      }
    }
    ctx.lineJoin = 'round'
    for (let index = arcs.length - 1; index >= 0; index -= 1) {
      const arc = arcs[index]
      const progress = (t - arc.born) / arc.life
      if (progress >= 1) {
        arcs.splice(index, 1)
        continue
      }
      const flicker = (1 - progress) * (0.55 + Math.random() * 0.45)
      const color = colors[arc.color]
      ctx.shadowColor = rgba(color, 0.9)
      ctx.shadowBlur = 14 * dpr
      ctx.strokeStyle = rgba(color, flicker * 0.6)
      ctx.lineWidth = 4 * dpr
      strokePath(arc.main)
      if (arc.branch) strokePath(arc.branch)
      ctx.shadowBlur = 0
      ctx.strokeStyle = rgba(core, flicker)
      ctx.lineWidth = 1.2 * dpr
      strokePath(arc.main)
      if (arc.branch) {
        ctx.lineWidth = 0.8 * dpr
        strokePath(arc.branch)
      }
    }
    ctx.lineJoin = 'miter'
  }

  // 等待数据期间核心按节奏外放光波，避免慢启动时画面静止。
  function drawPulses(t: number, leaving: boolean) {
    if (leaving || !impacted) return
    while (nextPulseAt <= t) {
      rings.push({ born: nextPulseAt, life: 1500, color: Math.floor(nextPulseAt / 1100) % colors.length, width: 3, reach: unit * 0.55 })
      nextPulseAt += 1100
    }
  }

  function drawIrisRim(radius: number, t: number) {
    if (!ctx || radius <= 0) return
    const gradient = ctx.createConicGradient(t / 260, cx, cy)
    colors.forEach((color, index) => gradient.addColorStop(index / colors.length, rgba(color, 1)))
    gradient.addColorStop(1, rgba(colors[0], 1))
    ctx.strokeStyle = gradient
    ctx.globalAlpha = 0.28
    ctx.lineWidth = 16 * dpr
    ctx.beginPath()
    ctx.arc(cx, cy, radius + 8 * dpr, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 3 * dpr
    ctx.beginPath()
    ctx.arc(cx, cy, radius + 1.5 * dpr, 0, Math.PI * 2)
    ctx.stroke()
  }

  function finish() {
    if (finished) return
    finished = true
    window.clearTimeout(exitFallback)
    cancelAnimationFrame(frame)
    const done = exitDone
    exitDone = null
    done?.()
  }

  function render(now: number) {
    const t = now - startedAt
    const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000))
    lastTime = now
    const exitProgress = exitStart == null ? 0 : clamp01((now - exitStart) / VIBE_SPLASH.exitMs)
    const leaving = exitStart != null

    if (!impacted && t >= VIBE_SPLASH.impactMs) triggerImpact(t)
    if (ctx) {
      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'lighter'
      drawStars(t, dt, exitProgress)
      drawCharge(t)
      drawPulses(t, leaving)
      drawRings(t)
      drawSparks(dt)
      drawArcs(t, leaving)
    }

    if (leaving) {
      // 光圈从核心打开露出工作区，画布与 CSS 遮罩共用同一半径。
      const reach = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) + 24 * dpr
      const radius = reach * easeInOutQuart(exitProgress)
      host.style.setProperty('--iris', `${radius / dpr}px`)
      if (ctx) drawIrisRim(radius, t)
      if (exitProgress >= 1) {
        finish()
        return
      }
    }
    frame = requestAnimationFrame(render)
  }

  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  frame = requestAnimationFrame(render)

  return {
    leave(onDone) {
      if (exitStart != null || finished) return
      exitStart = performance.now()
      exitDone = onDone
      // 窗口在后台时 rAF 会暂停，按时长兜底结束。
      exitFallback = window.setTimeout(finish, VIBE_SPLASH.exitMs + 260)
    },
    dispose() {
      finished = true
      window.clearTimeout(exitFallback)
      cancelAnimationFrame(frame)
      observer.disconnect()
    },
  }
}
