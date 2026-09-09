#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { ansiFg, createAnsiStatusPanel } from './ansi-status-panel.mjs'

const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_777_216
const MAX_ANSI_PREVIEW_PIXELS = 500_000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const AMPERSAND_COLORS = {
  '0': { r: 0, g: 0, b: 0, a: 255 },
  '1': { r: 0, g: 0, b: 170, a: 255 },
  '2': { r: 0, g: 170, b: 0, a: 255 },
  '3': { r: 0, g: 170, b: 170, a: 255 },
  '4': { r: 170, g: 0, b: 0, a: 255 },
  '5': { r: 170, g: 0, b: 170, a: 255 },
  '6': { r: 255, g: 170, b: 0, a: 255 },
  '7': { r: 170, g: 170, b: 170, a: 255 },
  '8': { r: 85, g: 85, b: 85, a: 255 },
  '9': { r: 85, g: 85, b: 255, a: 255 },
  a: { r: 85, g: 255, b: 85, a: 255 },
  b: { r: 85, g: 255, b: 255, a: 255 },
  c: { r: 255, g: 85, b: 85, a: 255 },
  d: { r: 255, g: 85, b: 255, a: 255 },
  e: { r: 255, g: 255, b: 85, a: 255 },
  f: { r: 255, g: 255, b: 255, a: 255 },
}
const CRC_TABLE = buildCrcTable()

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(scriptDir, '..')
const dragonCorePath = path.join(appRoot, 'DragonCore')

main()

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    printUsage()
    return
  }

  const panel = createAnsiStatusPanel({ title: 'DragonCore 生图' })
  try {
    fs.mkdirSync(dragonCorePath, { recursive: true })

    if (options.all) {
      const summaries = exportAllDragonFiles(panel)
      if (!summaries.length) {
        throw new Error(`DragonCore 里没有可转换的 .md 或 .dragon 文件：${dragonCorePath}`)
      }
      panel.finish({ status: '全部导出完成', detail: `${summaries.length} file(s)` })
      for (const summary of summaries) {
        console.log(`Exported ${path.basename(summary.inputPath)} -> ${summary.outputPath}`)
      }
      console.log(`Done. ${summaries.length} file(s) exported.`)
      return
    }

    const inputPath = resolveInputPath(options)
    const outputPath = resolveOutputPath(inputPath, options)
    const summary = exportDragonFile(inputPath, outputPath, {
      panel,
      progressStart: 0,
      progressEnd: 100,
    })
    panel.finish({
      status: '导出完成',
      detail: path.basename(outputPath),
      preview: summary.preview,
    })
    console.log(`Exported ${inputPath} -> ${outputPath}`)
  } catch (error) {
    panel.fail({
      status: '导出失败',
      detail: formatError(error),
    })
    console.error(formatError(error))
    process.exit(1)
  }
}

function parseArgs(args) {
  const options = {
    help: false,
    all: false,
    name: null,
    inputPath: null,
    outputPath: null,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--all') {
      options.all = true
      continue
    }
    if (arg === '--name') {
      const value = args[index + 1]
      if (!value) throw new Error('缺少 --name 的值')
      options.name = value
      index += 1
      continue
    }
    if (arg === '--out' || arg === '--output') {
      const value = args[index + 1]
      if (!value) throw new Error('缺少 --out 的值')
      options.outputPath = path.resolve(process.cwd(), value)
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`不支持的参数：${arg}`)
    }
    if (options.inputPath) {
      throw new Error(`多余的位置参数：${arg}`)
    }
    options.inputPath = path.resolve(process.cwd(), arg)
  }

  if (options.all && options.outputPath) {
    throw new Error('--all 不能和 --out 一起使用')
  }
  if (options.all && options.name) {
    throw new Error('--all 不能和 --name 一起使用')
  }
  if (options.inputPath && options.name) {
    throw new Error('位置参数和 --name 只能选一个')
  }

  return options
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/export-dragon-image.mjs',
    '  node scripts/export-dragon-image.mjs DragonCore\\gold-sword.md',
    '  node scripts/export-dragon-image.mjs --name gold-sword',
    '  node scripts/export-dragon-image.mjs --all',
    '  node scripts/export-dragon-image.mjs --name gold-sword --out DragonCore\\gold-sword.png',
    '',
    'Defaults:',
    '  no args      -> DragonCore/main.md 或 main.dragon -> DragonCore/output.png',
    '  --name <x>   -> DragonCore/<x>.md      -> DragonCore/<x>.png',
  ].join('\n'))
}

function resolveInputPath(options) {
  if (options.inputPath) return options.inputPath
  if (options.name) return path.join(dragonCorePath, `${sanitizeFileStem(options.name)}.md`)
  const mainMarkdownPath = path.join(dragonCorePath, 'main.md')
  if (fs.existsSync(mainMarkdownPath)) return mainMarkdownPath
  return path.join(dragonCorePath, 'main.dragon')
}

function resolveOutputPath(inputPath, options) {
  if (options.outputPath) return options.outputPath

  const inputName = path.basename(inputPath).toLowerCase()
  if (!options.name && !options.inputPath && (inputName === 'main.md' || inputName === 'main.dragon')) {
    return path.join(dragonCorePath, 'output.png')
  }

  const stem = sanitizeFileStem(path.basename(inputPath, path.extname(inputPath)))
  return path.join(dragonCorePath, `${stem || 'output'}.png`)
}

// 中文注释：批量导出时复用同一个 ANSI 面板，并把总进度按文件数均分。
function exportAllDragonFiles(panel) {
  const entries = fs.existsSync(dragonCorePath) ? fs.readdirSync(dragonCorePath, { withFileTypes: true }) : []
  const dragonFiles = entries
    .filter((entry) => entry.isFile() && isDragonConfigFile(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))

  return dragonFiles.map((fileName, index) => {
    const inputPath = path.join(dragonCorePath, fileName)
    const stem = sanitizeFileStem(path.basename(fileName, path.extname(fileName)))
    const lowerFileName = fileName.toLowerCase()
    const outputPath = path.join(dragonCorePath, lowerFileName === 'main.md' || lowerFileName === 'main.dragon' ? 'output.png' : `${stem}.png`)
    const progressStart = Math.round((index / Math.max(1, dragonFiles.length)) * 100)
    const progressEnd = Math.round(((index + 1) / Math.max(1, dragonFiles.length)) * 100)
    const summary = exportDragonFile(inputPath, outputPath, { panel, progressStart, progressEnd })
    return { inputPath, outputPath, preview: summary.preview }
  })
}

function isDragonConfigFile(fileName) {
  const lower = fileName.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.dragon')
}

// 中文注释：导出单个 Dragon 像素配置，并在关键阶段刷新终端 ANSI 状态块。
function exportDragonFile(inputPath, outputPath, options = {}) {
  const panel = options.panel
  const progressStart = Number.isFinite(options.progressStart) ? options.progressStart : 0
  const progressEnd = Number.isFinite(options.progressEnd) ? options.progressEnd : 100
  const progressAt = (ratio) => Math.round(progressStart + (progressEnd - progressStart) * ratio)
  const detail = path.basename(inputPath)

  panel?.update({ status: '读取配置', progress: progressAt(0.05), detail })
  if (!fs.existsSync(inputPath)) {
    throw new Error(`找不到像素配置文件：${inputPath}`)
  }

  panel?.update({ status: '解析像素', progress: progressAt(0.25), detail })
  const source = loadDragonPixelSource(inputPath)
  const document = parseDragonImageConfig(source)
  // 中文注释：超大像素图跳过终端低清预览，避免为了 ANSI 面板额外扫大数组。
  const preview = panel?.enabled && document.pixels.length <= MAX_ANSI_PREVIEW_PIXELS
    ? buildAnsiPixelPreview(document)
    : []

  panel?.update({ status: '编码 PNG', progress: progressAt(0.65), detail, preview })
  const png = encodePng(document.width, document.height, buildPixelBuffer(document))

  panel?.update({ status: '写入文件', progress: progressAt(0.9), detail: path.basename(outputPath), preview })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, png)
  panel?.update({ status: '完成', progress: progressAt(1), detail: path.basename(outputPath), preview })
  return { preview }
}

function loadDragonPixelSource(inputPath) {
  const source = fs.readFileSync(inputPath, 'utf8')
  const extension = path.extname(inputPath).toLowerCase()
  if (extension !== '.md') return source
  return extractDragonPixelFence(source, inputPath)
}

function extractDragonPixelFence(markdown, inputPath) {
  const lines = String(markdown).split(/\r?\n/)
  const blocks = []
  let inBlock = false
  let blockLines = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!inBlock && /^```[ \t]*dragon-pixel[ \t]*$/i.test(line)) {
      inBlock = true
      blockLines = []
      continue
    }

    if (inBlock && /^```[ \t]*$/.test(line)) {
      blocks.push(blockLines.join('\n'))
      inBlock = false
      blockLines = []
      continue
    }

    if (inBlock) blockLines.push(rawLine)
  }

  if (inBlock) {
    throw new Error(`dragon-pixel 代码块没有结束标记：${inputPath}`)
  }
  if (blocks.length === 0) {
    throw new Error(`缺少 dragon-pixel 代码块：${inputPath}`)
  }
  if (blocks.length > 1) {
    throw new Error(`只能包含一个 dragon-pixel 代码块：${inputPath}`)
  }
  return blocks[0]
}

function parseDragonImageConfig(source) {
  const issues = []
  const colors = {}
  const pixels = []
  let width = null
  let height = null

  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = (lineNumber === 1 ? lines[index].replace(/^\uFEFF/, '') : lines[index]).trim()

    if (!line || line.startsWith('//') || line.startsWith(';')) continue
    if (/^(colors|pixels)\s*:$/i.test(line)) continue

    const widthMatch = line.match(/^width\s*[:=]\s*(\d+)\s*$/i)
    if (widthMatch) {
      width = parseDimension(widthMatch[1], 'width', lineNumber, issues)
      continue
    }

    const heightMatch = line.match(/^height\s*[:=]\s*(\d+)\s*$/i)
    if (heightMatch) {
      height = parseDimension(heightMatch[1], 'height', lineNumber, issues)
      continue
    }

    const colorMatch = line.match(/^\[(\d+)]\s*[:=]\s*(.+)$/)
    if (colorMatch) {
      const colorIndex = Number(colorMatch[1])
      const color = parseColorValue(colorMatch[2].trim(), lineNumber, issues)
      if (color) colors[colorIndex] = color
      continue
    }

    const pixelMatch = line.match(/^x\s*:\s*(\d+(?:\s*~\s*\d+)?)\s*,\s*y\s*:\s*(\d+(?:\s*~\s*\d+)?)\s*\[(\d+)]\s*$/i)
    if (pixelMatch) {
      const xSpan = parseCoordinateSpan(pixelMatch[1], 'x', lineNumber, issues)
      const ySpan = parseCoordinateSpan(pixelMatch[2], 'y', lineNumber, issues)
      if (!xSpan || !ySpan) continue

      const pixelCount = spanLength(xSpan) * spanLength(ySpan)
      if (pixels.length + pixelCount > MAX_PIXELS) {
        issues.push(`第 ${lineNumber} 行像素范围太大：最多 ${MAX_PIXELS} 个像素`)
        continue
      }

      const colorIndex = Number(pixelMatch[3])
      forEachCoordinateInSpan(ySpan, (y) => {
        forEachCoordinateInSpan(xSpan, (x) => {
          pixels.push({ x, y, colorIndex, lineNumber })
        })
      })
      continue
    }

    issues.push(`第 ${lineNumber} 行无法识别：${line}`)
  }

  if (width == null) issues.push('缺少 width')
  if (height == null) issues.push('缺少 height')
  if (width != null && height != null && width * height > MAX_PIXELS) {
    issues.push(`图片太大：最多 ${MAX_PIXELS} 个像素`)
  }
  if (issues.length) {
    throw new Error(issues.join('\n'))
  }

  return { width, height, colors, pixels }
}

function buildPixelBuffer(document) {
  const buffer = Buffer.alloc(document.width * document.height * 4)
  const reportedOutOfRange = new Set()
  const reportedMissingColors = new Set()
  const issues = []

  for (const pixel of document.pixels) {
    if (pixel.x < 1 || pixel.x > document.width || pixel.y < 1 || pixel.y > document.height) {
      if (!reportedOutOfRange.has(pixel.lineNumber)) {
        reportedOutOfRange.add(pixel.lineNumber)
        issues.push(`第 ${pixel.lineNumber} 行像素坐标超出 ${document.width} x ${document.height}`)
      }
      continue
    }

    const color = document.colors[pixel.colorIndex]
    if (!color) {
      const key = `${pixel.lineNumber}:${pixel.colorIndex}`
      if (!reportedMissingColors.has(key)) {
        reportedMissingColors.add(key)
        issues.push(`第 ${pixel.lineNumber} 行引用了未定义颜色 [${pixel.colorIndex}]`)
      }
      continue
    }

    const offset = ((pixel.y - 1) * document.width + (pixel.x - 1)) * 4
    buffer[offset] = color.r
    buffer[offset + 1] = color.g
    buffer[offset + 2] = color.b
    buffer[offset + 3] = color.a
  }

  if (issues.length) {
    throw new Error(issues.join('\n'))
  }

  return buffer
}

// 中文注释：把像素配置压缩成终端低清色块预览，避免把真实图片数据塞进 terminal。
function buildAnsiPixelPreview(document) {
  const maxWidth = 24
  const maxHeight = 8
  const previewWidth = Math.min(maxWidth, document.width)
  const previewHeight = Math.min(maxHeight, document.height)
  const pixels = new Map()

  for (const pixel of document.pixels) {
    const px = Math.floor(((pixel.x - 1) / document.width) * previewWidth)
    const py = Math.floor(((pixel.y - 1) / document.height) * previewHeight)
    if (px < 0 || px >= previewWidth || py < 0 || py >= previewHeight) continue
    const color = document.colors[pixel.colorIndex]
    if (!color || color.a <= 0) continue
    pixels.set(`${px}:${py}`, color)
  }

  return Array.from({ length: previewHeight }, (_, y) => (
    Array.from({ length: previewWidth }, (_, x) => {
      const color = pixels.get(`${x}:${y}`)
      return color ? `${ansiFg(color.r, color.g, color.b)}█\x1b[0m` : ' '
    }).join('')
  ))
}

function parseDimension(raw, label, lineNumber, issues) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    issues.push(`第 ${lineNumber} 行 ${label} 必须是 1 到 ${MAX_DIMENSION} 的整数`)
    return null
  }
  return value
}

function parseCoordinateSpan(raw, axis, lineNumber, issues) {
  const parts = raw.split('~').map((part) => part.trim())
  const start = parseCoordinate(parts[0], axis, lineNumber, issues)
  const end = parseCoordinate(parts[1] ?? parts[0], axis, lineNumber, issues)
  if (start == null || end == null) return null
  return { start, end }
}

function parseCoordinate(raw, axis, lineNumber, issues) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    issues.push(`第 ${lineNumber} 行 ${axis} 坐标必须是 1 到 ${MAX_DIMENSION} 的整数`)
    return null
  }
  return value
}

function spanLength(span) {
  return Math.abs(span.end - span.start) + 1
}

function forEachCoordinateInSpan(span, visit) {
  const step = span.start <= span.end ? 1 : -1
  for (let value = span.start; ; value += step) {
    visit(value)
    if (value === span.end) break
  }
}

function parseColorValue(raw, lineNumber, issues) {
  const ampersandMatch = raw.match(/^&([0-9a-f])$/i)
  if (ampersandMatch) return { ...AMPERSAND_COLORS[ampersandMatch[1].toLowerCase()] }

  const hexMatch = raw.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hexMatch) {
    const value = hexMatch[1]
    return {
      r: Number.parseInt(value.slice(0, 2), 16),
      g: Number.parseInt(value.slice(2, 4), 16),
      b: Number.parseInt(value.slice(4, 6), 16),
      a: value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) : 255,
    }
  }

  const rgbaMatch = raw.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((part) => part.trim())
    if (parts.length === 3 || parts.length === 4) {
      const channels = parts.slice(0, 3).map(Number)
      const alpha = parts[3] == null ? 255 : parseAlpha(parts[3])
      if (channels.every(isByte) && isByte(alpha)) {
        return {
          r: channels[0],
          g: channels[1],
          b: channels[2],
          a: alpha,
        }
      }
    }
  }

  issues.push(`第 ${lineNumber} 行颜色格式无效：${raw}`)
  return null
}

function parseAlpha(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return Number.NaN
  if (value >= 0 && value <= 1) return Math.round(value * 255)
  return Math.round(value)
}

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255
}

function encodePng(width, height, rgbaBuffer) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1)
    raw[rowOffset] = 0
    rgbaBuffer.copy(raw, rowOffset + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = zlib.deflateSync(raw)

  return Buffer.concat([
    PNG_SIGNATURE,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', idat),
    createChunk('IEND', Buffer.alloc(0)),
  ])
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(data.length, 0)

  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
}

function crc32(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function sanitizeFileStem(raw) {
  const safe = String(raw ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[ .]+$/g, '')
  return safe || 'output'
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
