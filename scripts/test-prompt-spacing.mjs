import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const exeIndex = process.argv.indexOf('--exe')
const releaseCli = path.join(root, 'src-tauri', 'target', 'release', 'superhigh-cli.exe')
const debugCli = path.join(root, 'src-tauri', 'target', 'debug', 'superhigh-cli.exe')
const supportsSpacing = candidate => existsSync(candidate) && spawnSync(candidate, ['--help'], { encoding: 'utf8' }).stdout.includes('prompt spacing')
const cli = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1]) : supportsSpacing(releaseCli) ? releaseCli : debugCli
if (!existsSync(cli)) throw new Error(`Missing ${cli}; build superhigh-cli first.`)

const cases = [
  ['我其实是 奥特曼', '我其实是奥特曼'],
  ['我\t \u00a0 是  ', '我是'],
  ['沉淀好       更新源码肯定包括本机exe的', '沉淀好更新源码肯定包括本机exe的'],
  ['先保存       然后关闭窗口', '先保存 然后关闭窗口'],
  ['运行 npm   run build', '运行 npm run build'],
  ['git    status', 'git status'],
  ['- 我       是列表', '- 我是列表'],
  ['路径 "C:\\Program   Files\\App"', '路径 "C:\\Program   Files\\App"'],
  ['第一行       内容\n第二行       内容', '第一行内容\n第二行内容'],
]

let failed = 0
for (const [input, expected] of cases) {
  const result = spawnSync(cli, ['prompt', 'spacing', '--json'], { input, encoding: 'utf8' })
  const output = result.status === 0 ? JSON.parse(result.stdout) : null
  const ok = output?.text === expected
  console.log(`${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(output?.text ?? result.stderr.trim())}`)
  if (!ok) failed += 1
}

const timeout = spawnSync(cli, ['prompt', 'spacing', '--timeout-ms', '1', '--json'], {
  input: '我       是',
  encoding: 'utf8',
})
const timeoutOk = timeout.status !== 0 && timeout.stderr.includes('timed out after 1 ms')
console.log(`${timeoutOk ? 'PASS' : 'FAIL'} 1 ms timeout terminates the worker`)
if (!timeoutOk) failed += 1
process.exitCode = failed ? 1 : 0
