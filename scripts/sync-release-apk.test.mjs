import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { syncReleaseApks } from './sync-release-apk.mjs'

const name = 'SuperHigh-0.1.5.apk'
const bytes = Buffer.from('verified APK fixture')
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function fixture(t, { assets = [], draft = true, corrupt = false, missingAndroid = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-apk-test-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const destination = { draft, prerelease: false, assets }
  const calls = []
  const gh = args => {
    calls.push(args)
    if (args[0] === 'api') {
      if (args[1].endsWith('/android-v0.1.5')) {
        if (missingAndroid) throw Object.assign(new Error('not found'), { stderr: 'HTTP 404' })
        return JSON.stringify({ draft: false, assets: [{ name, digest }] })
      }
      return JSON.stringify(destination)
    }
    if (args[1] === 'download') writeFileSync(join(args.at(-1), name), corrupt ? 'corrupt' : bytes)
    if (args[1] === 'upload') destination.assets.push({ name, digest })
    return ''
  }
  return { directory, gh, calls }
}

test('copies verified APK to a Windows draft without overwrite flags', t => {
  const f = fixture(t)
  assert.match(syncReleaseApks('v0.1.5', f.directory, { gh: f.gh, allowDraft: true }), /verified/)
  assert.equal(f.calls.filter(call => call[1] === 'upload').length, 1)
  assert.ok(f.calls.every(call => !call.includes('--clobber')))
})

test('rejects corrupted downloads before upload', t => {
  const f = fixture(t, { corrupt: true })
  assert.throws(() => syncReleaseApks('v0.1.5', f.directory, { gh: f.gh, allowDraft: true }), /digest differs/)
  assert.ok(f.calls.every(call => call[1] !== 'upload'))
})

test('existing same APK is idempotent, differing APK is rejected', t => {
  const f = fixture(t, { draft: false, assets: [{ name, digest }] })
  syncReleaseApks('v0.1.5', f.directory, { gh: f.gh })
  assert.ok(f.calls.every(call => call[0] === 'api'))
  const mismatch = fixture(t, { draft: false, assets: [{ name, digest: `sha256:${'0'.repeat(64)}` }] })
  assert.throws(() => syncReleaseApks('v0.1.5', mismatch.directory, { gh: mismatch.gh }), /refusing to overwrite/)
})

test('missing Android release and unpublished Windows destination do not upload', t => {
  const missing = fixture(t, { missingAndroid: true })
  assert.match(syncReleaseApks('v0.1.5', missing.directory, { gh: missing.gh }), /No published Android/)
  const draft = fixture(t)
  assert.match(syncReleaseApks('v0.1.5', draft.directory, { gh: draft.gh }), /not public yet/)
  assert.ok([...missing.calls, ...draft.calls].every(call => call[1] !== 'upload'))
})
