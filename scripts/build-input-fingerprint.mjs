import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Inputs of the default desktop build, its mobile build, and the integration entry.
// Generated Tauri schemas and all compiler/frontend output stay outside this scope.
const inputPaths = [
  'src', 'public', 'src-tauri/src', 'src-tauri/icons', 'src-tauri/capabilities',
  'src-tauri/windows', 'src-tauri/prompt-spacing', 'src-tauri/build.rs',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri*.conf.json',
  'package.json', 'package-lock.json', 'tsconfig*.json', 'vite*.config.*', 'vitest.config.*',
  'index.html', 'index.mobile.html', 'CHANGELOG.md', 'rust-toolchain', 'rust-toolchain.toml',
  '.cargo/config', '.cargo/config.toml', 'src-tauri/.cargo/config', 'src-tauri/.cargo/config.toml',
  'scripts/build-desktop.mjs', 'scripts/prepare-mobile-dist.mjs', 'scripts/mobile-preview-host.ts',
  'scripts/retain-build-cache.ps1', 'scripts/integrate.ps1', 'scripts/build-input-fingerprint.mjs',
]

function fingerprint(root) {
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputPaths],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean)
  // Vite and npm also read these local configuration files when Git ignores them.
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.npmrc']) {
    if (existsSync(resolve(root, name))) paths.push(name)
  }
  const files = {}
  const digest = createHash('sha256')
  for (const name of [...new Set(paths)].sort()) {
    let bytes
    try { bytes = readFileSync(resolve(root, name)) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    files[name] = createHash('sha256').update(bytes).digest('hex')
    digest.update(name).update('\0').update(files[name]).update('\0')
  }
  return { fingerprint: digest.digest('hex'), files }
}

const [operation, rootArgument, snapshotArgument] = process.argv.slice(2)
try {
  if (!['snapshot', 'verify'].includes(operation) || !rootArgument || !snapshotArgument) {
    throw new Error('Usage: node build-input-fingerprint.mjs <snapshot|verify> <repo-root> <snapshot.json>')
  }
  const root = resolve(rootArgument)
  const snapshot = resolve(snapshotArgument)
  const current = fingerprint(root)
  if (operation === 'snapshot') writeFileSync(snapshot, `${JSON.stringify(current)}\n`)
  else {
    const before = JSON.parse(readFileSync(snapshot, 'utf8'))
    if (before.fingerprint !== current.fingerprint) {
      const changed = [...new Set([...Object.keys(before.files), ...Object.keys(current.files)])]
        .filter(name => before.files[name] !== current.files[name]).sort()
      throw new Error(`构建输入发生变化，已停止部署：${changed.slice(0, 8).join('、')}${changed.length > 8 ? ` 等 ${changed.length} 项` : ''}。冻结源码或从独立快照重新构建，不能沿用本次产物。`)
    }
  }
  process.stdout.write(`${JSON.stringify({ fingerprint: current.fingerprint, fileCount: Object.keys(current.files).length })}\n`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
