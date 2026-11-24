import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mobileBuildNeeded, recordMobileBuild } from './mobile-build-cache.mjs'

test('reuses a complete mobile build until a dependency, public asset, environment or output changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'superhigh-mobile-cache-'))
  const put = (name, contents) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents) }
  try {
    assert.equal(mobileBuildNeeded(root, {}), true)
    put('src/mobile/main.ts', 'mobile')
    put('src/shared.ts', 'shared')
    put('public/icon.png', 'icon')
    put('dist-mobile/index.html', 'html')
    put('dist-mobile/index.mobile.html', 'html')
    put('dist-mobile/assets/main.js', 'bundle')
    put('dist-mobile/.mobile-build-inputs.json', JSON.stringify({ modules: ['src/mobile/main.ts', 'src/shared.ts'] }))
    recordMobileBuild(root, { VITE_FOO: 'one' })
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one' }), false)
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one', NODE_ENV: 'development' }), true)
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'two' }), true)
    put('src/unrelated-desktop.ts', 'change')
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one' }), false)
    put('src/mobile/new.ts', 'new')
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one' }), true)
    rmSync(join(root, 'src/mobile/new.ts'))
    put('src/shared.ts', 'changed')
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one' }), true)
    put('src/shared.ts', 'shared')
    put('public/new.png', 'new')
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one' }), true)
    rmSync(join(root, 'public/new.png'))
    put('dist-mobile/assets/main.js', 'damaged')
    assert.equal(mobileBuildNeeded(root, { VITE_FOO: 'one' }), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
