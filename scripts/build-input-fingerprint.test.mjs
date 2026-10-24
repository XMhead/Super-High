import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const helper = fileURLToPath(new URL('./build-input-fingerprint.mjs', import.meta.url))
const tmp = fileURLToPath(new URL('../.agent/tmp/', import.meta.url))
const put = (file, contents) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents) }

function fixture(t) {
  mkdirSync(tmp, { recursive: true })
  const directory = mkdtempSync(join(tmp, 'build-input-test-'))
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmp) + (process.platform === 'win32' ? '\\' : '/')))
    rmSync(directory, { recursive: true, force: true })
  })
  const root = join(directory, 'repo')
  const snapshot = join(directory, 'inputs.json')
  mkdirSync(root)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Build input fixture')
  git('config', 'user.email', 'build-input-fixture@example.invalid')
  git('config', 'core.autocrlf', 'false')
  put(join(root, '.gitignore'), 'dist/\ndist-mobile/\nnode_modules/\n.agent/\nsrc-tauri/target/\n.env*\n')
  put(join(root, 'src/main.ts'), 'export const value = 1\n')
  put(join(root, 'src-tauri/src/main.rs'), 'fn main() {}\n')
  put(join(root, 'src-tauri/tauri.conf.json'), '{}\n')
  put(join(root, 'public/icon.svg'), '<svg/>\n')
  put(join(root, 'scripts/build-desktop.mjs'), 'console.log("build")\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  const run = operation => spawnSync(process.execPath, [helper, operation, root, snapshot], { encoding: 'utf8' })
  assert.equal(run('snapshot').status, 0)
  return { root, snapshot, git, run }
}

test('unchanged source passes and modified source fails before deployment', t => {
  const f = fixture(t)
  assert.equal(f.run('verify').status, 0)
  put(join(f.root, 'src/main.ts'), 'export const value = 2\n')
  const changed = f.run('verify')
  assert.equal(changed.status, 1)
  assert.match(changed.stderr, /已停止部署.*src\/main\.ts/)
})

test('new untracked source is included in the build input set', t => {
  const f = fixture(t)
  put(join(f.root, 'src/新 模块.ts'), 'export const added = true\n')
  const changed = f.run('verify')
  assert.equal(changed.status, 1)
  assert.match(changed.stderr, /src\/新 模块\.ts/)
})

test('generated output and unrelated documentation do not change the fingerprint', t => {
  const f = fixture(t)
  for (const name of ['dist/index.html', 'dist-mobile/index.html', 'node_modules/package/index.js',
    '.agent/run.txt', 'src-tauri/target/release/super-high.exe', 'src-tauri/gen/schemas/windows-schema.json', 'README.md']) {
    put(join(f.root, name), 'generated or unrelated contents\n')
  }
  assert.equal(f.run('verify').status, 0)
})

test('legitimate source directories named like build outputs remain inputs', t => {
  const f = fixture(t)
  for (const name of ['src/target-tools/new.ts', 'src/dist-format/new.ts']) {
    put(join(f.root, name), 'export const source = true\n')
    const changed = f.run('verify')
    assert.equal(changed.status, 1)
    assert.ok(changed.stderr.includes(name), changed.stderr)
    rmSync(join(f.root, name))
  }
})

test('a different commit with the same working files preserves the fingerprint', t => {
  const f = fixture(t)
  put(join(f.root, 'src/new.ts'), 'export const stagedLater = true\n')
  assert.equal(f.run('snapshot').status, 0)
  const before = f.git('rev-parse', 'HEAD')
  f.git('add', 'src/new.ts')
  f.git('commit', '-qm', 'different commit, same input')
  assert.notEqual(f.git('rev-parse', 'HEAD'), before)
  assert.equal(f.run('verify').status, 0)
})

test('native configuration, resources, build scripts and ignored Vite configuration are inputs', t => {
  const f = fixture(t)
  for (const name of ['src-tauri/tauri.conf.json', 'public/icon.svg', 'scripts/build-desktop.mjs', '.env.production']) {
    const file = join(f.root, name)
    const before = name === '.env.production' ? null : readFileSync(file)
    put(file, 'changed build input\n')
    const changed = f.run('verify')
    assert.equal(changed.status, 1, name)
    assert.ok(changed.stderr.includes(name), changed.stderr)
    if (before) writeFileSync(file, before)
    else rmSync(file)
  }
  assert.equal(f.run('verify').status, 0)
})
