import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { publishLocalRelease, releaseNotes, updateManifest } from './publish-local-release.mjs'

const tag = 'v0.1.15'
const commit = 'a'.repeat(40)
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value) }

function fixture(t) {
  mkdirSync('.agent/tmp', { recursive: true })
  const root = resolve(mkdtempSync('.agent/tmp/local-release-test-'))
  t.after(() => rmSync(root, { recursive: true }))
  const source = join(root, 'public')
  put(join(root, 'node_modules/pdfjs-dist/cmaps/fixture'), 'PDF build resource')
  const env = { LOCALAPPDATA: join(root, 'local'), USERPROFILE: join(root, 'profile') }
  mkdirSync(join(env.LOCALAPPDATA, 'Android/Sdk/build-tools/36.0.0'), { recursive: true })
  put(join(env.USERPROFILE, '.tauri/super-high-updater.key.pub'), `${Buffer.from('public-key').toString('base64')}\n`)
  put(join(source, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.15', plugins: { updater: { pubkey: Buffer.from('public-key').toString('base64') } } }))
  put(join(source, 'package.json'), JSON.stringify({ version: '0.1.15', scripts: { 'tauri:build': 'node scripts/build-desktop.mjs' } }))
  put(join(source, 'CHANGELOG.md'), '# Notes\n\n## [0.1.15] - 2026-09-10\n\nNew release notes.\n\n## [0.1.14]\n\nOld notes.\n')
  put(join(source, 'android/app/build.gradle'), 'versionCode 11\nversionName "0.1.15"\n')
  for (const name of ['android/app/capacitor.build.gradle', 'android/capacitor.settings.gradle']) put(join(source, name), 'generated original\n')
  const f = { root, source, env, calls: [], builds: [], logs: [], releases: new Map(), contents: new Map(), tags: new Map(), main: commit, head: commit, failUpload: null, corruptDownload: null }
  const notFound = () => { throw Object.assign(new Error('not found'), { stderr: 'HTTP 404' }) }
  const run = (command, args, options = {}) => {
    f.calls.push({ command, args })
    if (command === 'git') {
      if (args[0] === 'status') return f.dirty ? ' M source.txt' : ''
      if (args[0] === 'remote') return 'https://github.com/XMhead/Super-High.git'
      if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? f.head : f.main
      if (args[0] === 'ls-remote') return args.slice(2).flatMap(ref => ref === 'refs/heads/main' ? [`${f.main}\t${ref}`] : f.tags.has(ref) ? [`${f.tags.get(ref)}\t${ref}`] : []).join('\n')
      if (args[0] === 'push') { const [sha, ref] = args[2].split(':'); assert.ok(!f.tags.has(ref)); f.tags.set(ref, sha); return '' }
    }
    if (command === process.execPath && args[0] === 'scripts/build-mobile-apk.mjs') {
      f.builds.push({ type: 'apk', env: options.env })
      put(join(source, 'android/app/build/outputs/apk/debug/app-debug.apk'), 'signed apk fixture')
      put(join(source, 'android/capacitor.settings.gradle'), 'generated changed path\n')
      return ''
    }
    if (command === 'powershell.exe') {
      assert.equal(readFileSync(join(source, 'node_modules/pdfjs-dist/cmaps/fixture'), 'utf8'), 'PDF build resource')
      f.builds.push({ type: 'windows', env: options.env })
      if (f.failWindowsBuild) { f.failWindowsBuild = false; throw new Error('simulated local build failure') }
      const installer = join(options.env.CARGO_TARGET_DIR, 'release/bundle/nsis/Super High_0.1.15_x64-setup.exe')
      put(installer, 'signed windows fixture'); put(`${installer}.sig`, 'signature\n')
      return ''
    }
    if (command === process.execPath && args[0] === 'scripts/check-update-release.mjs') {
      if (args[2]) {
        const manifest = JSON.parse(readFileSync(join(args[2], 'latest.json'), 'utf8'))
        assert.equal(manifest.version, '0.1.15')
        assert.equal(manifest.platforms['windows-x86_64'].signature, readFileSync(join(args[2], 'Super.High_0.1.15_x64-setup.exe.sig'), 'utf8').trim())
      }
      return ''
    }
    if (basename(command) === 'aapt.exe') return "package: name='com.superhigh.mobile' versionCode='11' versionName='0.1.15'"
    if (basename(command) === 'java.exe') return `Signer #1 certificate SHA-256 digest: ${f.badCertificate ? '0'.repeat(64) : '9c8a75a028147afa974f4da4c2811cbfb256c7eb26a5a55616b5df514fa5598d'}`
    if (command === 'gh') {
      if (args[0] === 'api') {
        if (args[1].includes('?per_page')) return JSON.stringify([[...f.releases.values()].flat()])
        if (args[1].includes('/tags/')) { const item = f.releases.get(args[1].split('/tags/')[1]); if (!item || item.draft) return notFound(); return JSON.stringify(item) }
        const item = [...f.releases.values()].find(value => String(value.id) === args[1].split('/').at(-1))
        return item ? JSON.stringify(item) : notFound()
      }
      const releaseTag = args[2]
      if (args[1] === 'create') {
        assert.ok(!f.releases.has(releaseTag))
        f.releases.set(releaseTag, { id: f.releases.size + 1, name: args[args.indexOf('--title') + 1], tag_name: releaseTag, target_commitish: commit, draft: true, prerelease: args.includes('--prerelease'), assets: [] })
        return ''
      }
      if (args[1] === 'upload') {
        const name = basename(args[3])
        if (f.failUpload === name) { f.failUpload = null; throw new Error('simulated network upload failure') }
        const bytes = readFileSync(args[3])
        f.releases.get(releaseTag).assets.push({ name, digest: digest(bytes) })
        f.contents.set(`${releaseTag}/${name}`, bytes)
        return ''
      }
      if (args[1] === 'download') {
        const destination = args[args.indexOf('--dir') + 1]
        for (let index = 0; index < args.length; index++) if (args[index] === '--pattern') {
          const name = args[index + 1]
          put(join(destination, name), f.corruptDownload === name ? 'corrupt' : f.contents.get(`${releaseTag}/${name}`))
        }
        return ''
      }
      if (args[1] === 'edit') { assert.equal(f.releases.get(releaseTag).draft, true); f.releases.get(releaseTag).draft = false; return '' }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  }
  const download = async (url, file) => {
    const path = new URL(url).pathname
    const releaseTag = path.includes('/latest/download/') ? tag : path.split('/download/')[1].split('/')[0]
    put(file, f.corruptPublic === basename(path) ? 'corrupt public download' : f.contents.get(`${releaseTag}/${basename(path)}`))
  }
  f.publish = resume => publishLocalRelease({ source, tag, resume, title: f.title }, { root, env, run, download, log: message => f.logs.push(message) })
  return f
}

test('builds both packages in persistent public caches and verifies drafts before publishing', async t => {
  const f = fixture(t)
  await f.publish(false)
  assert.deepEqual(f.builds.map(item => item.type), ['apk', 'windows'])
  for (const build of f.builds) {
    assert.equal(build.env.CARGO_TARGET_DIR, join(f.root, '.agent/cache/public-release/cargo-target'))
    assert.equal(build.env.GRADLE_USER_HOME, join(f.root, '.agent/cache/public-release/gradle'))
  }
  assert.equal(readFileSync(join(f.source, 'android/capacitor.settings.gradle'), 'utf8'), 'generated original\n')
  assert.equal(f.releases.get(tag).draft, false)
  assert.equal(f.releases.get(tag).assets.length, 4)
  assert.ok(f.calls.every(call => !call.args.includes('--clobber') && !call.args.includes('workflow')))
})

test('upload failure resumes original signed artifacts without rebuilding even after main advances', async t => {
  const f = fixture(t)
  f.failUpload = 'Super.High_0.1.15_x64-setup.exe'
  await assert.rejects(f.publish(false), /network upload failure/)
  assert.equal(f.releases.get(tag).draft, true)
  f.main = 'b'.repeat(40)
  await f.publish(true)
  assert.equal(f.builds.length, 2)
  assert.equal(f.releases.get(tag).draft, false)
  const before = f.calls.length
  await f.publish(true)
  assert.ok(f.calls.slice(before).every(call => !['create', 'upload', 'edit'].includes(call.args[1])))
  assert.equal(f.tags.get(`refs/tags/${tag}`), commit)
})

test('a Windows Beta title survives upload resume without changing tags or Android titles', async t => {
  const f = fixture(t)
  f.title = `Super High ${tag} Beta 1`
  f.failUpload = 'Super.High_0.1.15_x64-setup.exe'
  await assert.rejects(f.publish(false), /network upload failure/)
  await f.publish(true)
  assert.equal(f.releases.get(tag).name, f.title)
  assert.equal(f.releases.get(`android-${tag}`).name, `Super High Android ${tag}`)
  assert.equal(f.builds.length, 2)
  f.title = `Super High ${tag} Beta 2`
  await assert.rejects(f.publish(true), /release title differs/)
})

test('changed saved artifacts or a moved tag prevent resuming before any upload', async t => {
  const f = fixture(t)
  f.failUpload = 'Super.High_0.1.15_x64-setup.exe'
  await assert.rejects(f.publish(false), /network upload failure/)
  const apk = join(f.root, '.agent/tmp/local-releases', tag, 'SuperHigh-0.1.15-android.apk')
  put(apk, 'changed local artifact')
  await assert.rejects(f.publish(true), /Saved artifact is missing or changed/)
  assert.equal(f.builds.length, 2)
  f.tags.set(`refs/tags/${tag}`, 'c'.repeat(40))
  await assert.rejects(f.publish(true), /tag points to different source/)
})

test('dirty or non-main source and an incompatible APK signature never publish', async t => {
  const dirty = fixture(t); dirty.dirty = true
  await assert.rejects(dirty.publish(false), /must be clean/)
  assert.equal(dirty.builds.length, 0)
  const stale = fixture(t); stale.main = 'b'.repeat(40)
  await assert.rejects(stale.publish(false), /must match the current remote main/)
  const wrongKey = fixture(t); wrongKey.badCertificate = true
  await assert.rejects(wrongKey.publish(false), /APK signature differs/)
  assert.equal(wrongKey.releases.size, 0)
})

test('a corrupted downloaded asset keeps the formal release as a draft', async t => {
  const f = fixture(t); f.corruptDownload = 'latest.json'
  await assert.rejects(f.publish(false), /Downloaded artifact digest differs/)
  assert.equal(f.releases.get(tag).draft, true)
})

test('an unpublished incomplete build can be retried normally, while resume never builds', async t => {
  const f = fixture(t); f.failWindowsBuild = true
  await assert.rejects(f.publish(false), /local build failure/)
  assert.equal(f.releases.size, 0)
  await assert.rejects(f.publish(true), /local build is incomplete/)
  assert.equal(f.builds.length, 2)
  await f.publish(false)
  assert.equal(f.releases.get(tag).draft, false)
})

test('the encoded local updater public key must match the application config', async t => {
  const f = fixture(t)
  put(join(f.env.USERPROFILE, '.tauri/super-high-updater.key.pub'), 'different-key')
  await assert.rejects(f.publish(false), /local updater signing public key differs/)
  assert.equal(f.builds.length, 0)
})

test('an existing Android tag must match the recorded source when resuming', async t => {
  const f = fixture(t); f.failUpload = 'Super.High_0.1.15_x64-setup.exe'
  await assert.rejects(f.publish(false), /network upload failure/)
  f.tags.set(`refs/tags/android-${tag}`, 'd'.repeat(40))
  await assert.rejects(f.publish(true), /release tag already points to different source/)
})

test('Android public download is verified before reporting its link or creating a stable release', async t => {
  const f = fixture(t); f.corruptPublic = 'SuperHigh-0.1.15-android.apk'
  await assert.rejects(f.publish(false), /public Android APK download differs/)
  assert.equal(f.logs.length, 0)
  assert.equal(f.releases.has(tag), false)
  assert.equal(f.tags.get(`refs/tags/${tag}`), commit)
  f.main = 'b'.repeat(40)
  f.corruptPublic = null
  await f.publish(true)
  assert.equal(f.builds.length, 2)
  assert.equal(f.releases.get(tag).draft, false)
})

test('release notes and updater manifest retain the selected version and signature', () => {
  assert.equal(releaseNotes('## [1.2.3]\r\n\r\nSelected\r\n\r\n## [1.2.2]\r\nOld', '1.2.3'), 'Selected')
  assert.equal(releaseNotes('## [1.2.3]\nLast section\n', '1.2.3'), 'Last section')
  const manifest = updateManifest('1.2.3', 'notes', 'Super.High_1.2.3_x64-setup.exe', 'signed\n', '2026-09-10T00:00:00Z')
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'signed')
  assert.match(manifest.platforms['windows-x86_64-nsis'].url, /releases\/download\/v1\.2\.3\//)
})
