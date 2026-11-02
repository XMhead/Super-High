import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectIntegration } from './inspect-integration.mjs'

const project = fileURLToPath(new URL('../../../../', import.meta.url))
const temp = resolve(project, '.agent/tmp/updater-search-iui')
mkdirSync(temp, { recursive: true })

function fixture(run) {
  const root = mkdtempSync(resolve(temp, 'integration-fixture-'))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (name, content) => {
    const target = resolve(root, name)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, content)
    return target
  }
  try {
    git('init', '-b', 'private')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'user.name', 'Fixture')
    git('config', 'core.autocrlf', 'false')
    write('.gitignore', '.agent/\ndeployed/\nsrc-tauri/target/\n')
    write('src/feature.ts', 'export const feature = true\n')
    mkdirSync(resolve(root, 'scripts'), { recursive: true })
    copyFileSync(resolve(project, 'scripts/build-input-fingerprint.mjs'), resolve(root, 'scripts/build-input-fingerprint.mjs'))
    git('add', '.')
    git('commit', '-m', 'Fixture source')
    git('branch', 'main')
    git('remote', 'add', 'origin', root)
    const entry = write('deployed/super-high.exe', 'app fixture')
    const cli = write('deployed/superhigh-cli.exe', 'cli fixture')
    write('src-tauri/target/release/super-high.exe', 'app fixture')
    write('src-tauri/target/release/superhigh-cli.exe', 'cli fixture')
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12).toUpperCase()
    const manifest = write('.agent/tmp/integrate/20261030-100000/build-inputs.json', '')
    const fingerprint = JSON.parse(execFileSync(process.execPath, [resolve(root, 'scripts/build-input-fingerprint.mjs'), 'snapshot', root, manifest], { encoding: 'utf8' }))
    write('.agent/tmp/integrate/20261030-100000/summary.json', '\uFEFF' + JSON.stringify({
      commit: git('rev-parse', 'HEAD'), buildInputs: fingerprint, restarted: true,
      deployed: { 'super-high.exe': digest(entry), 'superhigh-cli.exe': digest(cli) },
    }))
    write('.agent/tmp/integrate/20261030-110000/summary.json', JSON.stringify({ publicSync: git('rev-parse', 'main') }))
    write('.agent/tmp/integrate/20261030-120000/summary.json', JSON.stringify({ restarted: true, deployed: {} }))
    run({ root, entry, write, git })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('reuses the last deployed build beneath newer restart/sync receipts and checks exact task coverage', () => fixture(({ root, entry }) => {
  const result = inspectIntegration({ root, entry, paths: ['src/feature.ts'] })
  assert.equal(result.complete, true)
  assert.equal(result.build.run, '20261030-100000')
  assert.equal(result.build.currentSource, true)
  assert.equal(result.native['super-high.exe'].matchesReceipt, true)
  assert.equal(result.native['superhigh-cli.exe'].matchesBuiltBinary, true)
  assert.equal(result.public.headsMatch, true)
  assert.equal(result.public.sourceCoverage, 'current')
  assert.equal(result.dirty, false)
}))

test('reports changed inputs, replaced EXEs and unpublished files without claiming source coverage', () => fixture(({ root, entry, write }) => {
  write('src/feature.ts', 'export const feature = false\n')
  write('src/new.ts', 'new source\n')
  write('deployed/super-high.exe', 'different app')
  const result = inspectIntegration({ root, entry, paths: ['src'] })
  assert.equal(result.complete, true)
  assert.equal(result.build.currentSource, false)
  assert.equal(result.native['super-high.exe'].matchesReceipt, false)
  assert.equal(result.native['super-high.exe'].matchesBuiltBinary, false)
  assert.equal(result.public.sourceCoverage, 'differs')
  assert.deepEqual(result.public.changedPaths, ['src/feature.ts', 'src/new.ts'])
  assert.equal(result.dirty, true)
  assert.equal(inspectIntegration({ root, entry }).public.sourceCoverage, 'not_checked')
  assert.throws(() => inspectIntegration({ root, entry, paths: ['../outside'] }), /项目根目录/)
  const missing = inspectIntegration({ root, entry, paths: ['src/missing.ts'] })
  assert.equal(missing.complete, false)
  assert.equal(missing.public.sourceCoverage, 'not_checked')
}))
