import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const command = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const jsonFile = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const hashFile = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const detail = error => String(error.stderr || error.message).trim().slice(0, 600)

function shortcutEntry() {
  if (process.platform !== 'win32') throw new Error('非 Windows 环境请传 --entry <实际 EXE 路径>')
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Super High.lnk')).TargetPath"])
}

export function inspectIntegration({ root = process.cwd(), entry, paths = [] } = {}) {
  root = resolve(root)
  const git = args => command('git', ['-C', root, ...args])
  const errors = []
  const sourcePaths = paths.map(path => {
    const name = relative(root, resolve(root, path)).replaceAll('\\', '/')
    if (!name || name === '..' || name.startsWith('../') || isAbsolute(name)) throw new Error('--path 必须位于项目根目录内')
    return name
  })
  const result = {
    scope: { sourcePaths: sourcePaths.slice(0, 8), sourcePathCount: sourcePaths.length, uiAndLiveProcesses: 'not_checked' },
    privateCommit: git(['rev-parse', 'private']),
    dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])),
    build: null,
    native: null,
    public: { localMain: null, remoteMain: null, headsMatch: null, sourceCoverage: 'not_checked' },
    errors,
  }

  // Restart-only and sync-only receipts have no build inputs. Keep looking for the last deployed build.
  const runs = resolve(root, '.agent/tmp/integrate')
  if (existsSync(runs)) {
    for (const run of readdirSync(runs).sort().reverse()) {
      const summaryPath = resolve(runs, run, 'summary.json')
      if (!existsSync(summaryPath)) continue
      let receipt
      try { receipt = jsonFile(summaryPath) }
      catch (error) { errors.push(`${run}: ${detail(error)}`); continue }
      if (receipt.error || !receipt.deployed?.['super-high.exe'] || !receipt.buildInputs?.fingerprint) continue
      result.build = { run, commit: receipt.commit, currentSource: null, restarted: receipt.restarted === true }
      const manifest = resolve(runs, run, 'build-inputs.json')
      if (!existsSync(manifest)) errors.push(`${run}: 缺少 build-inputs.json`)
      else {
        try {
          command(process.execPath, [resolve(root, 'scripts/build-input-fingerprint.mjs'), 'verify', root, manifest])
          result.build.currentSource = true
        } catch (error) {
          const message = detail(error)
          if (message.includes('构建输入发生变化')) result.build.currentSource = false
          else errors.push(message)
          result.build.detail = message
        }
      }
      try {
        const target = entry ? resolve(root, entry) : shortcutEntry()
        if (!target) throw new Error('桌面快捷方式没有 EXE 目标')
        result.native = Object.fromEntries(['super-high.exe', 'superhigh-cli.exe'].map(name => {
          const path = name === 'super-high.exe' ? target : resolve(dirname(target), name)
          const actual = hashFile(path)
          const built = hashFile(resolve(root, 'src-tauri/target/release', name))
          return [name, {
            path, sha256: actual,
            matchesReceipt: actual && receipt.deployed[name] ? actual.startsWith(receipt.deployed[name].toLowerCase()) : null,
            matchesBuiltBinary: actual && built ? actual === built : null,
          }]
        }))
      } catch (error) { errors.push(detail(error)) }
      break
    }
  }

  try {
    result.public.localMain = git(['rev-parse', 'main'])
    result.public.remoteMain = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0] || null
    result.public.headsMatch = result.public.remoteMain ? result.public.localMain === result.public.remoteMain : null
    if (sourcePaths.length && result.public.remoteMain) {
      const ref = result.public.remoteMain
      const pathspecs = sourcePaths.map(path => `:(literal)${path}`)
      for (let index = 0; index < sourcePaths.length; index++) {
        if (!existsSync(resolve(root, sourcePaths[index])) && !git(['ls-tree', '-r', '--name-only', ref, '--', pathspecs[index]])) {
          throw new Error(`--path 没有当前文件或公开文件：${sourcePaths[index]}`)
        }
      }
      const changed = git(['diff', '--name-only', ref, '--', ...pathspecs]).split('\n').filter(Boolean)
      const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...pathspecs]).split('\n').filter(Boolean)
      const differences = [...new Set([...changed, ...untracked])]
      result.public.sourceCoverage = differences.length ? 'differs' : 'current'
      result.public.changedPaths = differences.slice(0, 8)
      result.public.changedPathCount = differences.length
    }
  } catch (error) { errors.push(detail(error)) }
  result.complete = errors.length === 0
  return result
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node inspect-integration.mjs [--root <repo>] [--entry <actual-exe>] [--path <task-file-or-directory>]...\nRead-only: inspect the last deployed build, current source fingerprint, EXE hashes and remote main.\nWithout --path, public source coverage is not checked. UI behavior and live processes are never checked. No build, deploy, restart, fetch or push is performed.')
    return
  }
  const options = { paths: [] }
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2)
    if (!['--root', '--entry', '--path'].includes(flag) || !value || value.startsWith('--')) throw new Error(`无效参数：${flag}`)
    if (flag === '--path') options.paths.push(value)
    else options[flag.slice(2)] = value
  }
  const result = inspectIntegration(options)
  console.log(JSON.stringify(result))
  if (!result.complete) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(JSON.stringify({ complete: false, error: detail(error) })); process.exitCode = 1 }
}
