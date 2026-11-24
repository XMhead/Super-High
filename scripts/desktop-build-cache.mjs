import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const generated = '.desktop-build-inputs.json'
const fixed = ['index.html', 'editor-ui-runtime.html', 'CHANGELOG.md', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'package.json', 'package-lock.json', 'scripts/desktop-build-cache.mjs', 'scripts/desktop-build-cache.d.mts', 'scripts/build-desktop-frontend-if-needed.mjs', '.env', '.env.local', '.env.production', '.env.production.local']
const directories = ['public', 'node_modules/pdfjs-dist/cmaps', 'node_modules/pdfjs-dist/standard_fonts', 'node_modules/pdfjs-dist/wasm', 'node_modules/highlight.js/es/languages']

function filesUnder(root, directory) {
  const base = join(root, directory)
  if (!existsSync(base)) return []
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.isFile() ? [relative(root, path).replaceAll('\\', '/')] : []
  })
  return walk(base).sort()
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function fileHashes(root, names) {
  return Object.fromEntries([...new Set(names)].sort().map(name => {
    try { const path = resolve(root, name); return [name, statSync(path).isFile() ? hash(readFileSync(path)) : null] }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error }
  }))
}
function environment(env) {
  const normalized = { ...env, NODE_ENV: env.NODE_ENV || 'production' }
  const values = Object.fromEntries(Object.keys(normalized).filter(key => key === 'NODE_ENV' || key.startsWith('VITE_') || key.startsWith('TAURI_ENV_')).sort().map(key => [key, normalized[key]]))
  return hash(JSON.stringify(values))
}
function snapshot(root, modules, env) {
  const typeDeclarations = filesUnder(root, 'src').filter(name => name.endsWith('.d.ts'))
  return { inputs: fileHashes(root, [...fixed, ...modules, ...typeDeclarations, ...directories.flatMap(dir => filesUnder(root, dir))]), outputs: fileHashes(root, filesUnder(root, 'dist')), environment: environment(env) }
}
export function recordDesktopBuild(root, env = process.env) {
  const temporary = join(root, 'dist', generated)
  const path = join(root, 'node_modules', '.cache', 'superhigh-desktop-build.json')
  const { modules } = JSON.parse(readFileSync(temporary, 'utf8'))
  if (!Array.isArray(modules)) throw new Error('桌面前端构建缺少依赖清单')
  unlinkSync(temporary); mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ version: 1, modules, ...snapshot(root, modules, env) })}\n`)
}
export function desktopBuildNeeded(root, env = process.env) {
  try {
    const previous = JSON.parse(readFileSync(join(root, 'node_modules', '.cache', 'superhigh-desktop-build.json'), 'utf8'))
    if (previous.version !== 1 || !Array.isArray(previous.modules) || !previous.outputs?.['dist/index.html']) return true
    return JSON.stringify(snapshot(root, previous.modules, env)) !== JSON.stringify({ inputs: previous.inputs, outputs: previous.outputs, environment: previous.environment })
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return true
    throw error
  }
}
