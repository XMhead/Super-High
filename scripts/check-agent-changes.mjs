import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const help = `node scripts/check-agent-changes.mjs --project <实际工作区> [--target-dir <已有正式构建缓存>] [--rustc <同缓存的rustc>] [--shell <原版CLI实际PowerShell路径>] [--command-file <原生命令文本或单条事件JSON>]
Windows 构建前检查：复用正式构建依赖，直接编译当前三个采集模块；检查真实工作区基线、默认PowerShell写入、撤销归零及下一轮。--command-file 只解析文本、argv数组或含command的原生事件，不执行输入命令。仅创建并清理本轮 .agent/tmp 文件，不启动或重启桌面应用。JSON 返回可用性、计数、耗时与失败阶段。`

function run() {
  const options = new Map()
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index]
    if (key === '--help') { console.log(help); return }
    if (!['--project', '--target-dir', '--rustc', '--shell', '--command-file'].includes(key) || options.has(key)) throw new Error(`未知或重复参数：${key}`)
    const value = process.argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`缺少参数值：${key}`)
    options.set(key, value)
  }
  if (process.platform !== 'win32') throw new Error('此入口验证 Windows PowerShell 采集')
  if (!options.has('--project')) throw new Error('必须指定 --project 实际工作区')
  const project = realpathSync(options.get('--project'))
  if (!statSync(project).isDirectory()) throw new Error('--project 必须是目录')
  const target = path.resolve(sourceRoot, options.get('--target-dir') || process.env.CARGO_TARGET_DIR || 'src-tauri/target')
  const deps = path.join(target, 'release', 'deps')
  if (!existsSync(deps)) throw new Error('缺少正式构建依赖缓存；指定已有 --target-dir')
  const rustc = options.get('--rustc') || 'rustc'
  const shell = options.get('--shell') || [
    path.join(process.env.ProgramFiles || '', 'PowerShell/7/pwsh.exe'),
    path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ].find(candidate => path.isAbsolute(candidate) && existsSync(candidate))
  if (!shell || !path.isAbsolute(shell)) throw new Error('--shell 必须是实际 PowerShell 的绝对路径')
  const runId = randomUUID()
  const outputDir = path.join(sourceRoot, '.agent', 'tmp', 'agent-changes-preflight', runId)
  mkdirSync(outputDir, { recursive: true })
  const binary = path.join(outputDir, 'probe.exe')
  const names = readdirSync(deps)
  const externs = ['anyhow', 'ignore', 'once_cell', 'serde', 'serde_json', 'sha2', 'shlex', 'similar'].flatMap(crate => {
    const candidates = names.filter(name => new RegExp(`^lib${crate}-[a-f0-9]+\\.rlib$`).test(name))
      .map(name => path.join(deps, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    if (!candidates.length) throw new Error(`依赖缓存缺少 ${crate}`)
    return ['--extern', `${crate}=${candidates[0]}`]
  })
  const compile = spawnSync(rustc, [
    '--edition=2021', '-O', '--crate-name', 'agent_changes_preflight',
    '-L', `dependency=${deps}`, ...externs,
    path.join(sourceRoot, 'scripts/check-agent-changes.rs'), '-o', binary,
  ], { cwd: sourceRoot, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 })
  if (compile.error || compile.status !== 0) {
    const detail = path.join(outputDir, 'compile.log')
    writeFileSync(detail, compile.stderr || compile.error?.message || '', 'utf8')
    console.log(JSON.stringify({ available: false, stage: 'compile', reason: compile.error?.message || compile.stderr.split(/\r?\n/).find(line => line.startsWith('error')) || '编译失败', detail, artifacts: outputDir }))
    process.exitCode = 1
    return
  }
  const args = [project, realpathSync(shell), runId]
  if (options.has('--command-file')) args.push(realpathSync(options.get('--command-file')))
  const probe = spawnSync(binary, args, { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 })
  if (probe.error) {
    console.log(JSON.stringify({ available: false, stage: 'runtime', reason: probe.error.message, cleaned: false, artifacts: outputDir }))
    process.exitCode = 1
    return
  }
  let result
  try { result = JSON.parse(probe.stdout) } catch { throw new Error(`采集检查未返回完整 JSON；${probe.stderr.trim().slice(-1000)}`) }
  console.log(JSON.stringify({ kind: 'backend_preflight', ...result, artifacts: outputDir }))
  process.exitCode = probe.status === 0 && result.available ? 0 : 1
}

try { run() } catch (error) {
  console.log(JSON.stringify({ available: false, stage: 'setup', reason: error.message }))
  process.exitCode = 1
}
