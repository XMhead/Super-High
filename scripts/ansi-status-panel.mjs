const ANSI_SYNC_START = '\x1b[?2026h'
const ANSI_SYNC_END = '\x1b[?2026l'
const ANSI_HIDE_CURSOR = '\x1b[?25l'
const ANSI_SHOW_CURSOR = '\x1b[?25h'
const ANSI_CLEAR_LINE = '\x1b[2K'
const ANSI_RESET = '\x1b[0m'

// 中文注释：创建一个只在交互式终端启用的 ANSI 原地刷新状态面板。
export function createAnsiStatusPanel(options = {}) {
  const stream = options.stream ?? process.stdout
  const enabled = options.enabled ?? Boolean(stream.isTTY)
  const width = clampInteger(options.width ?? 60, 36, 100)
  const title = String(options.title ?? '任务状态')
  let previousRowCount = 0
  let closed = false

  return {
    enabled,
    update(frame) {
      if (!enabled || closed) return
      const rows = buildPanelRows({ ...frame, title, width })
      stream.write(renderSynchronizedRows(rows, previousRowCount))
      previousRowCount = rows.length
    },
    finish(frame = {}) {
      if (closed) return
      if (enabled) {
        const rows = buildPanelRows({
          title,
          width,
          progress: 100,
          status: frame.status ?? '完成',
          detail: frame.detail ?? '',
          preview: frame.preview ?? [],
        })
        stream.write(renderSynchronizedRows(rows, previousRowCount))
        stream.write(`${ANSI_SHOW_CURSOR}\r\n`)
      }
      closed = true
    },
    fail(frame = {}) {
      if (closed) return
      if (enabled) {
        const rows = buildPanelRows({
          title,
          width,
          progress: frame.progress ?? 100,
          status: frame.status ?? '失败',
          detail: frame.detail ?? '',
          preview: frame.preview ?? [],
          tone: 'error',
        })
        stream.write(renderSynchronizedRows(rows, previousRowCount))
        stream.write(`${ANSI_SHOW_CURSOR}\r\n`)
      }
      closed = true
    },
  }
}

// 中文注释：把 RGB 颜色转换成 xterm 支持的 24 位前景色控制码。
export function ansiFg(r, g, b) {
  return `\x1b[38;2;${byte(r)};${byte(g)};${byte(b)}m`
}

// 中文注释：生成固定行数的状态块，便于后续帧移动光标并覆盖旧内容。
function buildPanelRows({ title, width, progress = 0, status = '', detail = '', preview = [], tone = 'normal' }) {
  const innerWidth = width - 2
  const barWidth = Math.max(10, Math.min(24, innerWidth - 14))
  const normalizedProgress = clampInteger(progress, 0, 100)
  const filled = Math.round((normalizedProgress / 100) * barWidth)
  const barColor = tone === 'error' ? ansiFg(239, 68, 68) : ansiFg(56, 189, 248)
  const bar = `${barColor}${'█'.repeat(filled)}${ANSI_RESET}${'░'.repeat(barWidth - filled)}`
  const rows = [
    `┌${fitText(`─ ${title} `, innerWidth, '─')}┐`,
    panelLine(`状态  ${status || '处理中'}`, innerWidth),
    panelLine(`进度  ${bar} ${String(normalizedProgress).padStart(3)}%`, innerWidth),
  ]
  if (detail) rows.push(panelLine(`文件  ${detail}`, innerWidth))
  const previewRows = normalizePreviewRows(preview, innerWidth)
  if (previewRows.length) {
    rows.push(panelLine('预览', innerWidth))
    rows.push(...previewRows.map((row) => panelLine(row, innerWidth)))
  }
  rows.push(`└${'─'.repeat(innerWidth)}┘`)
  return rows
}

// 中文注释：用 xterm synchronized update 包住一帧，减少终端局部重绘闪烁。
function renderSynchronizedRows(rows, previousRowCount) {
  const moveRows = Math.max(0, previousRowCount - 1)
  const moveToTop = moveRows > 0 ? `\x1b[${moveRows}A\r` : '\r'
  const body = rows
    .map((row, index) => `${ANSI_CLEAR_LINE}${row}${index === rows.length - 1 ? '' : '\r\n'}`)
    .join('')
  return `${ANSI_SYNC_START}${ANSI_HIDE_CURSOR}${moveToTop}${body}${ANSI_SYNC_END}`
}

// 中文注释：构造面板内的一行，ANSI 颜色码不计入可见长度。
function panelLine(content, width) {
  return `│${fitText(content, width)}│`
}

// 中文注释：把预览限制在面板宽度内，避免长行撑破终端布局。
function normalizePreviewRows(preview, width) {
  if (!Array.isArray(preview)) return []
  return preview
    .map((row) => fitText(String(row), width))
    .slice(0, 8)
}

// 中文注释：按可见字符长度补齐文本，忽略 ANSI escape code。
function fitText(value, width, fill = ' ') {
  const text = String(value)
  const visible = visibleLength(text)
  if (visible === width) return text
  if (visible < width) return `${text}${fill.repeat(width - visible)}`
  return `${sliceVisible(text, Math.max(0, width - 1))}…`
}

// 中文注释：计算去掉 ANSI 控制码后的粗略可见长度。
function visibleLength(value) {
  return stripAnsi(value).length
}

// 中文注释：按可见长度截断文本，保留已经出现的 ANSI 颜色控制码。
function sliceVisible(value, limit) {
  let output = ''
  let visible = 0
  for (let index = 0; index < value.length && visible < limit;) {
    if (value[index] === '\x1b') {
      const match = value.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/)
      if (match) {
        output += match[0]
        index += match[0].length
        continue
      }
    }
    output += value[index]
    visible += 1
    index += 1
  }
  return `${output}${ANSI_RESET}`
}

// 中文注释：移除 ANSI escape code，方便宽度计算和测试。
function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

// 中文注释：约束整数范围，避免进度或面板宽度异常。
function clampInteger(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.round(number)))
}

// 中文注释：约束颜色通道范围，保证 ANSI 真彩色参数合法。
function byte(value) {
  return clampInteger(value, 0, 255)
}
