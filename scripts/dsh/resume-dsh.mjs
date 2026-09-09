#!/usr/bin/env node
// resume-dsh.mjs — 一键恢复被中断的 dsh 持久化会话（后台运行）。
// 用法（在仓库根目录）：
//   node scripts/dsh/resume-dsh.mjs <sessionId> [--cwd <工作目录>] [--prompt <续跑指令>]
//     [--profile headless] [--preset minimal] [--out <日志文件>] [--err <错误日志文件>] [--wait]
//
// 它会写一个临时 overlay（禁用 headless-runner、激活 resume-runner 并带上
// sessionId/prompt），然后以 detached 子进程跑：
//   dsh --profile <profile> --patch <overlay> resume
// 默认在 --cwd 下写 .dsh-resume-out.log / .dsh-resume-err.log 并把 PID 存到
// %TEMP%\dsh-resume.pid。headless runner 只在终态把总结打到 stdout（out log）。
import { spawn } from 'node:child_process'
import { existsSync, openSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

function usage() {
  console.log(`用法: node scripts/dsh/resume-dsh.mjs <sessionId> [选项]
选项:
  --cwd <dir>        工作目录（默认：当前目录；建议填会话所在任务目录）
  --prompt <text>    续跑指令（默认：继续完成之前被中断的任务）
  --profile <name>   目标 profile（默认 headless）
  --preset <name>    恢复时注入的执行模式（minimal，默认 minimal）
  --out <path>       stdout 日志（默认 <cwd>\\.dsh-resume-out.log）
  --err <path>       stderr 日志（默认 <cwd>\\.dsh-resume-err.log）
  --wait             前台等待进程退出（默认后台返回 PID）
`)
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

function resolveDshBin() {
  const candidates = [
    join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : null,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'dsh'
}

function main() {
  const args = process.argv.slice(2)
  const sessionId = args[0]
  if (!sessionId || sessionId.startsWith('--')) {
    usage()
    process.exit(1)
  }
  const cwd = resolve(argValue(args, '--cwd', process.cwd()))
  const profile = argValue(args, '--profile', 'headless')
  const preset = argValue(args, '--preset', 'minimal')
  if (!['minimal'].includes(preset)) {
    throw new Error(`不支持的 preset：${preset}`)
  }
  const prompt = argValue(
    args,
    '--prompt',
    '继续完成之前被中断的任务。先检查是否有未完成的子进程/作业并获取其输出，再基于会话已有上下文继续执行，完成实际文件修改与验证后输出最终总结。'
  )
  const outPath = argValue(args, '--out', join(cwd, '.dsh-resume-out.log'))
  const errPath = argValue(args, '--err', join(cwd, '.dsh-resume-err.log'))
  const wait = args.includes('--wait')

  const overlayDir = mkdtempSync(join(tmpdir(), 'dsh-resume-overlay-'))
  const overlayPath = join(overlayDir, 'overlay.yml')
  const escapedPrompt = prompt.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const overlay = [
    '- id: headless-runner',
    '  disabled: true',
  ]
  overlay.push(
    '- id: resume-runner',
    '  disabled: false',
    '  config:',
    `    sessionId: ${sessionId}`,
    `    prompt: "${escapedPrompt}"`,
    '',
  )
  writeFileSync(overlayPath, overlay.join('\n'), 'utf8')

  const dshBin = resolveDshBin()
  const argsList =
    dshBin === 'dsh'
      ? ['--profile', profile, '--patch', overlayPath, 'resume']
      : [dshBin, '--profile', profile, '--patch', overlayPath, 'resume']
  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7897',
    HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7897',
    NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,::1',
  }
  const child = spawn(process.execPath, argsList, {
    cwd,
    env,
    detached: !wait,
    stdio: wait ? 'inherit' : ['ignore', openSync(outPath, 'w'), openSync(errPath, 'w')],
  })
  if (!wait) {
    child.unref()
    const pidPath = join(tmpdir(), 'dsh-resume.pid')
    writeFileSync(pidPath, `${child.pid}\n`, 'ascii')
    console.log(`已后台启动 resume：pid=${child.pid} profile=${profile}`)
    console.log(`overlay=${overlayPath}`)
    console.log(`stdout=${outPath}`)
    console.log(`stderr=${errPath}`)
    console.log(`pid 文件=${pidPath}`)
  } else {
    child.on('exit', (code) => process.exit(code ?? 1))
  }
}

main()
