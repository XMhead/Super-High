export interface TerminalGridLayout {
  columns: number
  rows: number
  /** 每个单元格跨越的网格列数，末行不满时拉伸铺满 */
  spans: number[]
}

/** 终端单元格的理想宽高比，按可容纳的最大该比例矩形挑选列数 */
const TERMINAL_ASPECT = 1.6

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

export function terminalGridLayout(count: number, width: number, height: number): TerminalGridLayout {
  if (count <= 0) return { columns: 1, rows: 1, spans: [] }
  let best = 1
  let bestScore = -1
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols)
    const score = Math.min(width / cols / TERMINAL_ASPECT, height / rows)
    if (score > bestScore + 0.5) {
      best = cols
      bestScore = score
    }
  }
  const rows = Math.ceil(count / best)
  const last = count - (rows - 1) * best
  const columns = best * last / gcd(best, last)
  const spans = Array.from({ length: count }, (_, index) => (index < count - last ? columns / best : columns / last))
  return { columns, rows, spans }
}
