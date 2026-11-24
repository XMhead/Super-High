import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { desktopBuildNeeded, recordDesktopBuild } from './desktop-build-cache.mjs'

test('desktop build is reused only while its dependencies, environment and outputs match', () => {
  const root = mkdtempSync(join(tmpdir(), 'superhigh-desktop-cache-'))
  const put = (name, text) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  try {
    assert.equal(desktopBuildNeeded(root, {}), true)
    put('src/main.ts', 'app'); put('src/shared.ts', 'shared'); put('CHANGELOG.md', 'notes')
    put('public/icon.png', 'icon'); put('node_modules/pdfjs-dist/wasm/a.wasm', 'pdf')
    put('dist/index.html', 'html'); put('dist/assets/main.js', 'bundle')
    put('dist/.desktop-build-inputs.json', JSON.stringify({ modules: ['src/main.ts', 'src/shared.ts'] }))
    recordDesktopBuild(root, { VITE_FOO: 'one', TAURI_ENV_PLATFORM: 'windows' })
    const env = { VITE_FOO: 'one', TAURI_ENV_PLATFORM: 'windows' }
    assert.equal(desktopBuildNeeded(root, env), false)
    assert.equal(desktopBuildNeeded(root, { ...env, NODE_ENV: 'production' }), false)
    assert.equal(desktopBuildNeeded(root, { ...env, NODE_ENV: 'development' }), true)
    put('src/mobile/only.vue', 'mobile'); put('src-tauri/src/main.rs', 'rust')
    assert.equal(desktopBuildNeeded(root, env), false)
    put('src/shared.ts', 'changed'); assert.equal(desktopBuildNeeded(root, env), true); put('src/shared.ts', 'shared')
    put('CHANGELOG.md', 'new notes'); assert.equal(desktopBuildNeeded(root, env), true); put('CHANGELOG.md', 'notes')
    put('node_modules/pdfjs-dist/wasm/b.wasm', 'new'); assert.equal(desktopBuildNeeded(root, env), true); rmSync(join(root, 'node_modules/pdfjs-dist/wasm/b.wasm'))
    assert.equal(desktopBuildNeeded(root, { ...env, TAURI_ENV_PLATFORM: 'linux' }), true)
    put('dist/assets/main.js', 'damaged'); assert.equal(desktopBuildNeeded(root, env), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
