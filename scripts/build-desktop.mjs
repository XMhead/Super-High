import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
// Use an explicit location so the build and retention script agree, including
// when the caller supplies CARGO_TARGET_DIR for an isolated build.
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || 'src-tauri/target')

// %USERPROFILE%\.cargo\bin\cargo.exe is a symlink to rustup.exe; when rustup is
// gone the link dangles and cargo cannot start, which tauri reports as
// "failed to run 'cargo metadata' ... os error 2". Prepend a toolchain bin that
// still ships cargo, since a wildcard path never resolves through PATH.
function resolveCargoEnv(env) {
  const usable = candidate => spawnSync('cargo', ['--version'], { env: candidate, shell: false }).status === 0
  if (usable(env)) return env
  const toolchains = path.join(env.USERPROFILE || os.homedir(), '.rustup', 'toolchains')
  if (!existsSync(toolchains)) return env
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const names = readdirSync(toolchains).sort((a, b) => Number(b.startsWith('stable')) - Number(a.startsWith('stable')))
  for (const name of names) {
    const bin = path.join(toolchains, name, 'bin')
    if (!existsSync(path.join(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) continue
    const patched = { ...env, [pathKey]: `${bin}${path.delimiter}${env[pathKey] || ''}` }
    if (!usable(patched)) continue
    console.log(`cargo from PATH is unusable; building with the ${name} toolchain. Reinstall rustup to repair the shims.`)
    return patched
  }
  console.warn('No usable cargo toolchain found; reinstall rustup before building.')
  return env
}

const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args], {
  cwd: root,
  env: { ...resolveCargoEnv(process.env), CARGO_TARGET_DIR: target },
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

// Special CLI modes can change the output layout or skip compilation entirely.
// Only the standard Windows release/debug build has a known retention scope.
const special = args.some(arg => /^(--target|--config|--runner|--profile|--help|--version|--no-build|--)(=|$)/.test(arg) || ['-t', '-c', '-r', '-h', '-V'].includes(arg))
const standardTarget = path.dirname(target) === path.join(root, 'src-tauri') && /^target(?:-.+)?$/.test(path.basename(target))
if (process.platform === 'win32' && !special && standardTarget) {
  const cleanup = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/retain-build-cache.ps1'),
    '-KeepTarget', target, '-KeepProfile', args.includes('--debug') || args.includes('-d') ? 'debug' : 'release',
  ], { cwd: root, stdio: 'inherit' })
  if (cleanup.error || cleanup.status !== 0) console.warn('Build succeeded; cache cleanup was skipped or incomplete.')
} else {
  console.log('Cache retention skipped for a custom build layout or non-Windows host.')
}
