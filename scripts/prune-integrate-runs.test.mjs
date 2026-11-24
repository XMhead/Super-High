import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(project, 'scripts', 'prune-integrate-runs.ps1')

test('retains renamed running executable and continues pruning unrelated runs', { skip: process.platform !== 'win32' }, async (t) => {
  const tmp = join(project, '.agent', 'tmp')
  mkdirSync(tmp, { recursive: true })
  const fixture = mkdtempSync(join(tmp, 'integrate-prune-test-'))
  assert.equal(dirname(realpathSync(fixture)), realpathSync(tmp))
  assert.match(basename(realpathSync(fixture)), /^integrate-prune-test-/)
  const root = join(fixture, 'integrate')
  const locked = join(root, '20260101-000001')
  const clean = join(root, '20260101-000002')
  mkdirSync(locked, { recursive: true })
  mkdirSync(clean, { recursive: true })
  writeFileSync(join(clean, 'old.txt'), 'old')
  for (let index = 3; index <= 7; index++) {
    const run = join(root, `20260101-00000${index}`)
    mkdirSync(run); writeFileSync(join(run, 'keep.txt'), 'keep')
  }
  const executable = join(fixture, 'launch.exe')
  copyFileSync(process.execPath, executable)
  const child = spawn(executable, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, 'exit')
      child.kill()
      await ended
    }
    assert.equal(dirname(realpathSync(fixture)), realpathSync(tmp))
    rmSync(fixture, { recursive: true })
  })
  const [chunk] = await once(child.stdout, 'data')
  assert.match(chunk.toString(), /ready/)
  mkdirSync(join(locked, 'replaced'))
  renameSync(executable, join(locked, 'replaced', 'superhigh-cli.exe'))
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${child.pid}").ExecutablePath`], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(query.status, 0, query.stderr)
  assert.equal(resolve(query.stdout.trim()).toLowerCase(), resolve(executable).toLowerCase())
  const copy = join(fixture, 'prune.ps1')
  copyFileSync(source, copy)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copy, '-TmpRoot', root, '-Keep', '5'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Run in use skipped/)
  assert.equal(existsSync(join(locked, 'replaced', 'superhigh-cli.exe')), true)
  assert.equal(existsSync(clean), false)
  assert.equal(existsSync(join(root, '20260101-000003', 'keep.txt')), true)
})

test('continues after an unrelated locked file prevents deleting a run', { skip: process.platform !== 'win32' }, async (t) => {
  const tmp = join(project, '.agent', 'tmp')
  mkdirSync(tmp, { recursive: true })
  const fixture = mkdtempSync(join(tmp, 'integrate-prune-test-'))
  assert.equal(dirname(realpathSync(fixture)), realpathSync(tmp))
  assert.match(basename(realpathSync(fixture)), /^integrate-prune-test-/)
  const root = join(fixture, 'integrate')
  const locked = join(root, '20260101-000001')
  const clean = join(root, '20260101-000002')
  mkdirSync(locked, { recursive: true }); mkdirSync(clean)
  const lockPath = join(locked, 'locked.dat')
  writeFileSync(lockPath, 'locked'); writeFileSync(join(clean, 'old.txt'), 'old')
  for (let index = 3; index <= 7; index++) mkdirSync(join(root, `20260101-00000${index}`))
  const script = '$f=[IO.File]::Open($env:PRUNE_FIXTURE_LOCK,"Open","ReadWrite","None"); [Console]::WriteLine("ready"); Start-Sleep -Seconds 30; $f.Dispose()'
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, PRUNE_FIXTURE_LOCK: lockPath }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, 'exit')
      child.kill(); await ended
    }
    assert.equal(dirname(realpathSync(fixture)), realpathSync(tmp))
    rmSync(fixture, { recursive: true })
  })
  const [chunk] = await once(child.stdout, 'data')
  assert.match(chunk.toString(), /ready/)
  const copy = join(fixture, 'prune.ps1')
  copyFileSync(source, copy)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copy, '-TmpRoot', root, '-Keep', '5'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Run cleanup failed/)
  assert.equal(existsSync(lockPath), true)
  assert.equal(existsSync(clean), false)
  assert.equal(existsSync(join(root, '20260101-000003')), true)
})
