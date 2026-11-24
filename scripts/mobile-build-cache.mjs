import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const metadata = '.mobile-build-inputs.json'
const fixed = ['index.mobile.html', 'editor-ui-runtime.html', 'vite.mobile.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'package.json', 'package-lock.json', 'scripts/mobile-preview-host.ts', 'scripts/prepare-mobile-dist.mjs', 'scripts/mobile-build-cache.mjs', 'scripts/build-mobile-if-needed.mjs', '.env', '.env.local', '.env.production', '.env.production.local']

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
    const file = resolve(root, name)
    try { return [name, statSync(file).isFile() ? hash(readFileSync(file)) : null] }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error }
  }))
}
function environment(env) {
  const normalized = { ...env, NODE_ENV: env.NODE_ENV || 'production' }
  return hash(JSON.stringify(Object.fromEntries(Object.keys(normalized).filter(key => key === 'NODE_ENV' || key.startsWith('VITE_')).sort().map(key => [key, normalized[key]]))))
}
function snapshot(root, modules, env) {
  return {
    inputs: fileHashes(root, [...fixed, ...modules, ...filesUnder(root, 'src/mobile'), ...filesUnder(root, 'public')]),
    outputs: fileHashes(root, filesUnder(root, 'dist-mobile')),
    environment: environment(env),
  }
}

export function recordMobileBuild(root, env = process.env) {
  const temporary = join(root, 'dist-mobile', metadata)
  const path = join(root, 'node_modules', '.cache', 'superhigh-mobile-build.json')
  const { modules } = JSON.parse(readFileSync(temporary, 'utf8'))
  if (!Array.isArray(modules)) throw new Error('手机构建缺少依赖清单')
  unlinkSync(temporary)
  mkdirSync(dirname(path), { recursive: true })
  const state = { version: 1, modules, ...snapshot(root, modules, env) }
  writeFileSync(path, `${JSON.stringify(state)}\n`)
}

export function mobileBuildNeeded(root, env = process.env) {
  try {
    const previous = JSON.parse(readFileSync(join(root, 'node_modules', '.cache', 'superhigh-mobile-build.json'), 'utf8'))
    if (previous.version !== 1 || !Array.isArray(previous.modules) || !previous.outputs?.['dist-mobile/index.html'] || !previous.outputs?.['dist-mobile/index.mobile.html']) return true
    const current = snapshot(root, previous.modules, env)
    return JSON.stringify(current) !== JSON.stringify({ inputs: previous.inputs, outputs: previous.outputs, environment: previous.environment })
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return true
    throw error
  }
}
