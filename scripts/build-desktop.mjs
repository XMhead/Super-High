import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
// Use an explicit location so the build and retention script agree, including
// when the caller supplies CARGO_TARGET_DIR for an isolated build.
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || 'src-tauri/target')
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args], {
  cwd: root,
  env: { ...process.env, CARGO_TARGET_DIR: target },
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
