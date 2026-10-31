import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Windows binaries linked by https://mpv.io/installation/ . Pin both the archive
// and its GitHub asset digest; a rebuild must not silently select another engine.
const root = fileURLToPath(new URL('../', import.meta.url))
const source = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-dev-x86_64-20261021-git-e471496c56.7z'
const sha256 = 'efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633'
const directory = path.join(root, '.superhigh/cache/native-media')
const dll = path.join(directory, 'libmpv-2.dll')

export async function prepareNativeMedia() {
  if (process.platform !== 'win32') return
  await mkdir(directory, { recursive: true })
  const notices = path.join(root, 'src-tauri/native-media-licenses')
  for (const name of await readdir(notices)) await copyFile(path.join(notices, name), path.join(directory, name))
  const receipt = path.join(directory, 'source.json')
  try {
    const saved = JSON.parse(await readFile(receipt, 'utf8'))
    const actual = createHash('sha256').update(await readFile(dll)).digest('hex')
    if (saved.archiveSha256 === sha256 && saved.dllSha256 === actual) return
  } catch { /* Fetch an absent or changed runtime. */ }
  const temporaryRoot = path.join(root, '.agent/tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const temporary = await mkdtemp(path.join(temporaryRoot, 'native-media-'))
  try {
    console.log('Preparing the pinned native video engine…')
    const response = await fetch(source, { signal: AbortSignal.timeout(900_000) })
    if (!response.ok) throw new Error(`Native video engine download: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Native video engine archive SHA256 mismatch')
    const archive = path.join(temporary, 'mpv.7z')
    await writeFile(archive, bytes)
    const listing = spawnSync('tar.exe', ['-tf', archive], { encoding: 'utf8', windowsHide: true })
    if (listing.status !== 0) throw new Error(listing.stderr || 'Cannot inspect the native video archive')
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
    const library = entries.find(entry => /^(?:\.\/)?libmpv-2\.dll$/.test(entry))
    const licenses = entries.filter(entry => /^(?:\.\/)?(?:copyright|license|copying)(?:[./_-]|$)/i.test(entry) && !entry.endsWith('/'))
    if (!library || entries.some(entry => entry.startsWith('/') || entry.split(/[\\/]/).includes('..'))) throw new Error('Unexpected native video archive layout')
    const extracted = spawnSync('tar.exe', ['-xf', archive, '-C', temporary, library, ...licenses], { encoding: 'utf8', windowsHide: true })
    if (extracted.status !== 0) throw new Error(extracted.stderr || 'Cannot extract the native video engine')
    await mkdir(directory, { recursive: true })
    // Stage replacement alongside the DLL. Running viewers keep their mapped
    // module; installing an unchanged runtime does not touch it.
    for (const entry of [library, ...licenses]) {
      const destination = path.join(directory, entry)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(`${destination}.next`, await readFile(path.join(temporary, entry)))
      await rename(`${destination}.next`, destination)
    }
    await writeFile(receipt, JSON.stringify({ source, archiveSha256: sha256, dllSha256: createHash('sha256').update(await readFile(dll)).digest('hex') }, null, 2) + '\n')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareNativeMedia()
