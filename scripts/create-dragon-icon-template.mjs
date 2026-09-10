#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VALID_SIZES = new Set([32, 64])

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(scriptDir, '..')
const dragonCorePath = path.join(appRoot, 'DragonCore')
const defaultOutputPath = path.join(dragonCorePath, 'main.md')

const options = parseArgs(process.argv.slice(2))
const content = buildIconTemplate(options.size, options.markdown)

if (options.stdout) {
  process.stdout.write(content)
} else {
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
  fs.writeFileSync(options.outputPath, content, 'utf8')
  console.log(`Wrote ${options.size}x${options.size} icon template to ${options.outputPath}`)
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const sizeArg = args.find((arg) => /^\d+$/.test(arg)) ?? '32'
  const size = Number(sizeArg)
  if (!VALID_SIZES.has(size)) {
    console.error('Size must be 32 or 64.')
    printUsage()
    process.exit(1)
  }

  const outputIndex = args.indexOf('--output')
  const nameIndex = args.indexOf('--name')
  if (nameIndex >= 0 && !args[nameIndex + 1]) {
    console.error('Missing value for --name.')
    printUsage()
    process.exit(1)
  }

  const outputPath = outputIndex >= 0
    ? path.resolve(process.cwd(), args[outputIndex + 1] ?? '')
    : nameIndex >= 0
      ? path.join(dragonCorePath, `${sanitizeDragonFileStem(args[nameIndex + 1])}.md`)
    : defaultOutputPath
  if (outputIndex >= 0 && !args[outputIndex + 1]) {
    console.error('Missing value for --output.')
    printUsage()
    process.exit(1)
  }

  return {
    size,
    outputPath,
    stdout: args.includes('--stdout'),
    markdown: !args.includes('--raw') && path.extname(outputPath).toLowerCase() !== '.dragon',
  }
}

function printUsage() {
  console.log([
    'Usage: node scripts/create-dragon-icon-template.mjs [32|64] [--name file-stem] [--output path] [--stdout] [--raw]',
    '',
    'Default output: DragonCore/main.md',
    'Named output:  DragonCore/<file-stem>.md',
    'Use --raw or an .dragon output path only for legacy raw config output.',
  ].join('\n'))
}

function sanitizeDragonFileStem(raw) {
  const safe = String(raw ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[ .]+$/g, '')
  return safe || 'icon'
}

function buildIconTemplate(size, markdown) {
  const pixelLines = buildPixelLines(size)
  const config = [
    `width: ${size}`,
    `height: ${size}`,
    '',
    'colors:',
    '[0]=rgba(0,0,0,0)',
    '[1]=#111827ff',
    '[2]=#1f2937ff',
    '[3]=#374151ff',
    '[4]=#64748bff',
    '[5]=#cbd5e1ff',
    '[6]=#f6c343ff',
    '[7]=#a66b12ff',
    '[8]=#f8fafcff',
    '',
    'pixels:',
    ...pixelLines,
    '',
  ].join('\n')
  if (!markdown) return config
  return [
    '```dragon-pixel',
    config.trimEnd(),
    '```',
    '',
  ].join('\n')
}

function buildPixelLines(size) {
  const scale = size / 32
  const lines = []
  const addRect = (x1, y1, x2, y2, colorIndex) => {
    const scaledX1 = scaleStart(x1, scale)
    const scaledY1 = scaleStart(y1, scale)
    const scaledX2 = scaleEnd(x2, scale)
    const scaledY2 = scaleEnd(y2, scale)
    lines.push(`x:${formatSpan(scaledX1, scaledX2)},y:${formatSpan(scaledY1, scaledY2)}[${colorIndex}]`)
  }

  addRect(9, 27, 24, 28, 2)
  addRect(10, 5, 23, 5, 1)
  addRect(8, 6, 25, 6, 1)
  addRect(6, 7, 27, 8, 1)
  addRect(5, 9, 28, 24, 1)
  addRect(6, 25, 27, 26, 1)
  addRect(8, 27, 25, 27, 1)

  addRect(10, 6, 23, 6, 3)
  addRect(8, 7, 25, 8, 3)
  addRect(7, 9, 26, 16, 3)
  addRect(8, 17, 25, 23, 3)
  addRect(10, 24, 23, 25, 3)

  addRect(10, 8, 22, 8, 4)
  addRect(9, 9, 21, 10, 4)
  addRect(8, 11, 18, 15, 4)
  addRect(9, 16, 16, 17, 4)

  addRect(24, 10, 26, 22, 2)
  addRect(10, 23, 24, 24, 2)
  addRect(12, 25, 22, 25, 2)

  addRect(21, 11, 23, 12, 7)
  addRect(19, 13, 22, 14, 7)
  addRect(17, 15, 20, 16, 7)
  addRect(15, 17, 18, 18, 7)
  addRect(13, 19, 16, 20, 7)
  addRect(11, 21, 14, 22, 7)

  addRect(20, 10, 22, 11, 6)
  addRect(18, 12, 21, 13, 6)
  addRect(16, 14, 19, 15, 6)
  addRect(14, 16, 17, 17, 6)
  addRect(12, 18, 15, 19, 6)
  addRect(10, 20, 13, 21, 6)

  addRect(11, 10, 14, 10, 5)
  addRect(10, 11, 12, 11, 8)
  addRect(9, 12, 9, 12, 8)

  return lines
}

function scaleStart(value, scale) {
  return (value - 1) * scale + 1
}

function scaleEnd(value, scale) {
  return value * scale
}

function formatSpan(start, end) {
  return start === end ? String(start) : `${start}~${end}`
}
