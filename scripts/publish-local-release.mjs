import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getReleaseByTag, syncReleaseApks } from './sync-release-apk.mjs'

const repository = 'XMhead/Super-High'
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Public certificate of the Android packages already distributed to users.
const androidCertificate = '9c8a75a028147afa974f4da4c2811cbfb256c7eb26a5a55616b5df514fa5598d'
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const runCommand = (command, args, { cwd, env, inherit = false } = {}) => execFileSync(command, args, {
  cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
}) ?? ''

export function releaseNotes(changelog, version) {
  const escaped = version.replaceAll('.', '\\.')
  const section = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## |^\\[\\d|$(?![\\s\\S]))`, 'm').exec(changelog)
  assert(section?.[1]?.trim(), 'The release version is missing from CHANGELOG.md.')
  return section[1].trim()
}

export function updateManifest(version, notes, installerName, signature, date) {
  const platform = { signature: signature.trim(), url: `https://github.com/${repository}/releases/download/v${version}/${installerName}` }
  return { version, notes, pub_date: date, platforms: { 'windows-x86_64': platform, 'windows-x86_64-nsis': platform } }
}

export function verifySavedArtifacts(state, directory, { tag, commit, notes }) {
  assert(state?.schema === 1 && state.tag === tag && state.commit === commit && state.notes === notes, 'Saved artifacts belong to a different source, version or release description.')
  const version = tag.slice(1)
  const expected = [`SuperHigh-${version}-android.apk`, `Super.High_${version}_x64-setup.exe`, `Super.High_${version}_x64-setup.exe.sig`, 'latest.json']
  assert(state.complete && expected.length === Object.keys(state.assets ?? {}).length, 'The local build is incomplete; --resume never starts a build.')
  for (const name of expected) {
    assert(/^[a-f0-9]{64}$/.test(state.assets[name] ?? '') && existsSync(join(directory, name)) && hash(join(directory, name)) === state.assets[name], `Saved artifact is missing or changed: ${name}.`)
  }
}

export async function publishLocalRelease({ source, tag, title, resume = false }, {
  root = workspace, run = runCommand, env = process.env, log = console.log,
  download = async (url, destination) => {
    const response = await fetch(url)
    assert(response.ok, `Public asset download failed (${response.status}).`)
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
  },
} = {}) {
  assert(source && /^v\d+\.\d+\.\d+$/.test(tag ?? ''), 'Usage: node scripts/publish-local-release.mjs --source <clean-public-worktree> --tag v<version> [--title <release-title>] [--resume]')
  assert(title === undefined || (typeof title === 'string' && title.trim() && !/[\r\n]/.test(title)), 'Release title must be nonempty and on one line.')
  source = realpathSync(resolve(source))
  root = realpathSync(root)
  assert(source.toLowerCase() !== root.toLowerCase(), 'Use a separate public worktree, not the private development checkout.')
  const version = tag.slice(1)
  const git = args => run('git', args, { cwd: source }).trim()
  const gh = args => run('gh', args, { cwd: source })
  const release = value => getReleaseByTag(value, gh)
  const config = json(join(source, 'src-tauri/tauri.conf.json'))
  assert(config.version === version && json(join(source, 'package.json')).version === version, 'The public source must use the requested application version.')
  const notes = releaseNotes(readFileSync(join(source, 'CHANGELOG.md'), 'utf8'), version)
  const commit = git(['rev-parse', 'HEAD'])
  assert(/^[a-f0-9]{40}$/.test(commit), 'Invalid public source commit.')
  const refs = () => new Map(git(['ls-remote', 'origin', 'refs/heads/main', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/).reverse()))
  const checkSource = () => {
    assert(!git(['status', '--porcelain', '--untracked-files=all']), 'The public source worktree must be clean.')
    assert(git(['remote', 'get-url', 'origin']).replace(/\.git$/, '') === `https://github.com/${repository}`, 'Unexpected public repository remote.')
    const remote = refs()
    const existingTag = remote.get(`refs/tags/${tag}^{}`) ?? remote.get(`refs/tags/${tag}`)
    assert(git(['rev-parse', 'HEAD']) === commit, 'The public source HEAD changed during publishing.')
    if (!(resume && existingTag === commit)) {
      assert(remote.get('refs/heads/main') === commit && git(['rev-parse', 'origin/main']) === commit, 'Public HEAD and origin/main must match the current remote main. A saved build may resume against its unchanged remote tag.')
    }
    assert(!existingTag || existingTag === commit, 'The existing version tag points to different source; tags must never move.')
  }
  checkSource()
  run(process.execPath, ['scripts/check-update-release.mjs', tag], { cwd: source, inherit: true })
  const cache = join(root, '.agent/cache/public-release')
  const directory = join(root, '.agent/tmp/local-releases', tag)
  const statePath = join(directory, 'state.json')
  const existing = release(tag)
  if (resume) assert(existsSync(statePath), 'No saved build is available to resume.')
  else if (existsSync(directory)) {
    assert(existsSync(statePath), 'The artifact directory has no build record; preserve it and use a different version.')
    const unfinished = json(statePath)
    assert(unfinished.schema === 1 && unfinished.tag === tag && unfinished.commit === commit && unfinished.notes === notes && !unfinished.complete, 'Local artifacts already exist or belong to different source; use --resume for a complete saved build.')
    assert(!existing && !release(`android-${tag}`), 'An incomplete local build must not overwrite artifacts associated with an existing release.')
  }
  assert(resume || !existing, 'This release already exists; only --resume with its verified local artifacts may continue.')
  for (const target of [cache, directory]) {
    mkdirSync(target, { recursive: true })
    assert(realpathSync(target).toLowerCase() === resolve(target).toLowerCase(), 'Release cache and artifacts must not redirect through directory links.')
  }
  const notesPath = join(directory, 'release-notes.md')
  let state
  const save = () => {
    writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(`${statePath}.tmp`, statePath)
  }
  const buildEnv = { ...env, CARGO_TARGET_DIR: join(cache, 'cargo-target'), GRADLE_USER_HOME: join(cache, 'gradle') }
  const javaHome = join(env.LOCALAPPDATA ?? '', 'Programs/SuperHighAndroidEnv/jdk-21')
  const toolsRoot = join(env.LOCALAPPDATA ?? '', 'Android/Sdk/build-tools')
  const toolsVersion = readdirSync(toolsRoot).filter(value => /^\d+\.\d+\.\d+$/.test(value)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  assert(toolsVersion, 'Android build tools are missing.')
  const androidTools = join(toolsRoot, toolsVersion)
  const verifyApk = file => {
    const badging = run(join(androidTools, 'aapt.exe'), ['dump', 'badging', file], { cwd: source })
    const gradle = readFileSync(join(source, 'android/app/build.gradle'), 'utf8')
    const code = gradle.match(/\bversionCode\s+(\d+)/)?.[1]
    assert(code && badging.includes(`name='com.superhigh.mobile' versionCode='${code}' versionName='${version}'`), 'APK package, versionName or versionCode differs from the public source.')
    const cert = run(join(javaHome, 'bin/java.exe'), ['-jar', join(androidTools, 'lib/apksigner.jar'), 'verify', '--print-certs', file], { cwd: source })
    assert(cert.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase() === androidCertificate, 'APK signature differs from the Android packages already distributed to users.')
  }
  if (resume) {
    state = json(statePath)
    verifySavedArtifacts(state, directory, { tag, commit, notes })
    assert(readFileSync(notesPath, 'utf8').trim() === notes, 'Saved release notes changed.')
  } else {
    const dependencies = join(source, 'node_modules')
    if (!existsSync(dependencies)) symlinkSync(realpathSync(join(root, 'node_modules')), dependencies, 'junction')
    state = { schema: 1, tag, commit, notes, complete: false, assets: {} }
    save()
    writeFileSync(notesPath, `${notes}\n`)
    const publicKey = readFileSync(join(env.USERPROFILE ?? '', '.tauri/super-high-updater.key.pub'), 'utf8').trim()
    assert(publicKey === config.plugins.updater.pubkey.trim(), 'The local updater signing public key differs from this application.')
    // Capacitor rewrites only these generated Gradle files to locate node_modules.
    const generated = ['android/app/capacitor.build.gradle', 'android/capacitor.settings.gradle'].map(name => [join(source, name), readFileSync(join(source, name))])
    try {
      run(process.execPath, ['scripts/build-mobile-apk.mjs'], { cwd: source, env: buildEnv, inherit: true })
    } finally {
      for (const [file, bytes] of generated) writeFileSync(file, bytes)
    }
    const apkName = `SuperHigh-${version}-android.apk`
    const apk = join(source, 'android/app/build/outputs/apk/debug/app-debug.apk')
    verifyApk(apk)
    copyFileSync(apk, join(directory, apkName))
    state.assets[apkName] = hash(join(directory, apkName))
    save()
    checkSource()
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'scripts/build-update.ps1')], { cwd: source, env: buildEnv, inherit: true })
    const bundle = join(buildEnv.CARGO_TARGET_DIR, 'release/bundle/nsis')
    const installers = readdirSync(bundle).filter(name => name.endsWith(`_${version}_x64-setup.exe`))
    assert(installers.length === 1, 'Expected exactly one matching Windows x64 NSIS installer.')
    const installerName = `Super.High_${version}_x64-setup.exe`
    copyFileSync(join(bundle, installers[0]), join(directory, installerName))
    copyFileSync(join(bundle, `${installers[0]}.sig`), join(directory, `${installerName}.sig`))
    const manifest = updateManifest(version, notes, installerName, readFileSync(join(directory, `${installerName}.sig`), 'utf8'), new Date().toISOString())
    writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const name of [installerName, `${installerName}.sig`, 'latest.json']) state.assets[name] = hash(join(directory, name))
    state.complete = true
    save()
  }
  verifySavedArtifacts(state, directory, { tag, commit, notes })
  verifyApk(join(directory, `SuperHigh-${version}-android.apk`))
  run(process.execPath, ['scripts/check-update-release.mjs', tag, directory], { cwd: source, inherit: true })
  checkSource()
  const ensureTag = releaseTag => {
    const rows = git(['ls-remote', 'origin', `refs/tags/${releaseTag}`, `refs/tags/${releaseTag}^{}`]).split(/\r?\n/).filter(Boolean).map(row => row.split(/\s+/))
    const target = rows.find(row => row[1].endsWith('^{}'))?.[0] ?? rows[0]?.[0]
    assert(!target || target === commit, 'A release tag already points to different source; refusing to move it.')
    if (!target) git(['push', 'origin', `${commit}:refs/tags/${releaseTag}`])
  }
  const ensureRelease = (releaseTag, prerelease) => {
    ensureTag(releaseTag)
    const releaseTitle = prerelease ? `Super High Android ${releaseTag.replace(/^android-/, '')}` : (title ?? `Super High ${releaseTag} Alpha`)
    let current = release(releaseTag)
    if (!current) {
      gh(['release', 'create', releaseTag, '--repo', repository, '--verify-tag', '--target', commit, '--title', releaseTitle, '--notes-file', notesPath, '--draft', '--latest=false', ...(prerelease ? ['--prerelease'] : [])])
      current = release(releaseTag)
    }
    assert(current && current.target_commitish === commit && current.prerelease === prerelease, 'Release source or prerelease status differs from the saved build.')
    if (!prerelease && title) assert(current.name === releaseTitle, 'Existing release title differs from the requested title.')
    return current
  }
  const verifyRemote = (releaseTag, names) => {
    const current = release(releaseTag)
    assert(current && current.assets.length === names.length, 'Release assets are incomplete or unexpected.')
    for (const name of names) assert(current.assets.find(asset => asset.name === name)?.digest?.toLowerCase() === `sha256:${state.assets[name]}`, `Remote artifact differs from the saved build: ${name}.`)
    const downloaded = mkdtempSync(join(directory, 'verify-'))
    gh(['release', 'download', releaseTag, '--repo', repository, '--dir', downloaded, ...names.flatMap(name => ['--pattern', name])])
    for (const name of names) assert(hash(join(downloaded, name)) === state.assets[name], `Downloaded artifact digest differs: ${name}.`)
    if (names.includes('latest.json')) run(process.execPath, ['scripts/check-update-release.mjs', tag, downloaded], { cwd: source, inherit: true })
    return current
  }
  const upload = (releaseTag, names) => {
    for (const name of names) {
      const current = release(releaseTag)
      const asset = current.assets.find(item => item.name === name)
      if (asset) assert(asset.digest?.toLowerCase() === `sha256:${state.assets[name]}`, `Existing asset differs; refusing to overwrite ${name}.`)
      else {
        assert(current.draft, 'Published release assets must not be changed.')
        gh(['release', 'upload', releaseTag, join(directory, name), '--repo', repository])
      }
    }
  }
  // Anchor the verified local build before the first upload so even an early
  // Android transfer failure can resume after main advances to a script fix.
  ensureTag(tag)
  const androidTag = `android-${tag}`
  const apkNames = [`SuperHigh-${version}-android.apk`]
  ensureRelease(androidTag, true)
  upload(androidTag, apkNames)
  if (verifyRemote(androidTag, apkNames).draft) gh(['release', 'edit', androidTag, '--repo', repository, '--draft=false', '--latest=false'])
  const androidUrl = `https://github.com/${repository}/releases/download/${androidTag}/${apkNames[0]}`
  const androidPublicDownload = join(mkdtempSync(join(directory, 'android-public-verify-')), apkNames[0])
  await download(androidUrl, androidPublicDownload)
  assert(hash(androidPublicDownload) === state.assets[apkNames[0]], 'The public Android APK download differs from the verified local package.')
  log(`Android APK: ${androidUrl}`)
  const stable = ensureRelease(tag, false)
  const allNames = Object.keys(state.assets)
  if (stable.draft) {
    upload(tag, allNames.filter(name => !name.endsWith('.apk')))
    syncReleaseApks(tag, directory, { gh, allowDraft: true, requireApk: true })
  }
  const verified = verifyRemote(tag, allNames)
  checkSource()
  if (verified.draft) gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'])
  assert(release(tag)?.draft === false, 'The verified release has not been published.')
  const publicDownload = mkdtempSync(join(directory, 'public-verify-'))
  for (const name of allNames) {
    await download(`https://github.com/${repository}/releases/download/${tag}/${name}`, join(publicDownload, name))
    assert(hash(join(publicDownload, name)) === state.assets[name], `Public download digest differs: ${name}.`)
  }
  if (verified.draft) {
    const latest = join(publicDownload, 'latest-endpoint.json')
    await download(`https://github.com/${repository}/releases/latest/download/latest.json`, latest)
    assert(hash(latest) === state.assets['latest.json'], 'The latest update endpoint does not match this release.')
  }
  log(`Release verified: https://github.com/${repository}/releases/tag/${tag}`)
  return { tag, commit, directory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const options = {}
  while (args.length) {
    const name = args.shift()
    if (name === '--resume') options.resume = true
    else if (['--source', '--tag', '--title'].includes(name) && args[0] && !args[0].startsWith('--')) options[name.slice(2)] = args.shift()
    else throw new Error(`Unknown or incomplete argument: ${name}`)
  }
  await publishLocalRelease(options)
}
