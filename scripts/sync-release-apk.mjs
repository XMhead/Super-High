import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'XMhead/Super-High'
const runGh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function syncReleaseApks(tag, artifactDirectory, { allowDraft = false, requireApk = false, sourceOnly = false, gh = runGh } = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Expected a stable version tag.')
  if (!artifactDirectory) throw new Error('An artifact directory is required.')
  const sourceTag = `android-${tag}`
  const release = (releaseTag) => {
    try {
      return JSON.parse(gh(['api', `repos/${repository}/releases/tags/${releaseTag}`]))
    } catch (error) {
      if (/HTTP 404/.test(String(error.stderr ?? ''))) return null
      throw error
    }
  }
  const digest = (asset) => {
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) {
      throw new Error(`Missing SHA256 digest for ${asset.name}.`)
    }
    return asset.digest.slice(7).toLowerCase()
  }
  const source = release(sourceTag)
  const apks = source?.draft ? [] : (source?.assets ?? []).filter(asset => asset.name.endsWith('.apk'))
  if (!apks.length) {
    if (requireApk || sourceOnly) throw new Error(`Missing published APK on ${sourceTag}; build and verify this version from the public release source first.`)
    return 'No published Android APK yet; synchronization is pending.'
  }
  for (const asset of apks) {
    if (basename(asset.name) !== asset.name || !/^[a-z0-9._-]+\.apk$/i.test(asset.name)) throw new Error('Unsafe APK asset name.')
    if ((requireApk || sourceOnly) && ![`-${tag.slice(1)}.apk`, `-${tag.slice(1)}-android.apk`].some(suffix => asset.name.endsWith(suffix))) {
      throw new Error(`APK filename must end with -${tag.slice(1)}.apk or -${tag.slice(1)}-android.apk: ${asset.name}.`)
    }
    digest(asset)
  }
  if (sourceOnly) return `Published Android APK source verified for ${tag}.`
  const destination = release(tag)
  if (!destination || (destination.draft && !allowDraft)) {
    if (requireApk) throw new Error('The destination release is unavailable for required APK synchronization.')
    return 'Windows release is not public yet; keep the Android download available.'
  }
  if (destination.prerelease) throw new Error('The Windows destination must be a stable release.')

  for (const asset of apks) {
    if (basename(asset.name) !== asset.name || !/^[a-z0-9._-]+\.apk$/i.test(asset.name)) {
      throw new Error('Unsafe APK asset name.')
    }
    const expected = digest(asset)
    const existing = destination.assets.find(item => item.name === asset.name)
    if (existing) {
      if (digest(existing) !== expected) throw new Error(`Existing APK differs: ${asset.name}; refusing to overwrite.`)
      continue
    }
    mkdirSync(artifactDirectory, { recursive: true })
    const downloadDirectory = mkdtempSync(join(artifactDirectory, 'android-apk-'))
    gh(['release', 'download', sourceTag, '--repo', repository, '--pattern', asset.name, '--dir', downloadDirectory])
    const apk = join(downloadDirectory, asset.name)
    if (createHash('sha256').update(readFileSync(apk)).digest('hex') !== expected) {
      throw new Error(`Downloaded APK digest differs: ${asset.name}.`)
    }
    try {
      gh(['release', 'upload', tag, apk, '--repo', repository])
    } catch (error) {
      // The Android and Windows flows may attach the same APK concurrently.
      let concurrent
      try {
        concurrent = release(tag)?.assets.find(item => item.name === asset.name)
      } catch {
        throw error
      }
      if (concurrent?.digest?.toLowerCase() !== `sha256:${expected}`) throw error
    }
    const uploaded = release(tag)?.assets.find(item => item.name === asset.name)
    if (!uploaded || digest(uploaded) !== expected) throw new Error(`Uploaded APK verification failed: ${asset.name}.`)
  }
  return `Android APKs verified on ${tag}; existing release assets were preserved.`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(syncReleaseApks(process.argv[2], process.argv[3], { allowDraft: process.argv.includes('--allow-draft'), requireApk: process.argv.includes('--require-apk'), sourceOnly: process.argv.includes('--check-source') }))
}
