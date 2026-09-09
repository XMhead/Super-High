#!/usr/bin/env node
// Launch the real dsh-tui twice in an isolated home and verify that a
// multi-paragraph input becomes exactly one persisted user message.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceDshHome = join(homedir(), '.dsh')
const dshBin = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const message = [
  '1 /wait-what：AI 说人话神器',
  '2 /grill-me 多问题轮次',
  '3 /writing-for-agents 文档读者不只是人，还有 agent！',
  '4 wizard 技能',
  '5 two questionnaire 协作文档',
  '',
  '还有两个大改进：兼容 Codex 等工具。',
].join('\n')

function copyIfPresent(source, target) {
  if (existsSync(source)) cpSync(source, target, { recursive: true })
}

function copyProfileNodeModules(sourceProfile, targetProfile) {
  const sourceNodeModules = join(sourceProfile, 'node_modules')
  const targetNodeModules = join(targetProfile, 'node_modules')
  // Copy the package-link structure into the disposable profile. A junction
  // for the whole tree would make repairing @dsh-external mutate the real
  // profile's links through that junction.
  cpSync(sourceNodeModules, targetNodeModules, { recursive: true, verbatimSymlinks: true })

  // Rebuild only the external package entries in the copy with absolute links.
  // This handles pnpm's relative links without writing outside the test home.
  const targetExternal = join(targetNodeModules, '@dsh-external')
  rmSync(targetExternal, { recursive: true, force: true })
  mkdirSync(targetExternal, { recursive: true })
  for (const name of ['dsh-gpt-reconnect', 'dsh-resume-runner']) {
    const source = join(sourceDshHome, 'external-plugins', name)
    if (existsSync(source)) symlinkSync(source, join(targetExternal, name), 'junction')
  }
}

function prepareIsolatedHome(root) {
  const userHome = join(root, 'user')
  const dshHome = join(root, '.dsh')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(join(dshHome, 'profiles', 'dsh-tui'), { recursive: true })

  for (const name of ['settings.yaml', '.credentials.yaml', 'cordis.patch.yml', 'AGENTS.md']) {
    copyIfPresent(join(sourceDshHome, name), join(dshHome, name))
  }
  copyIfPresent(join(sourceDshHome, '.agent-presets'), join(dshHome, '.agent-presets'))

  const sourceProfile = join(sourceDshHome, 'profiles', 'dsh-tui')
  const targetProfile = join(dshHome, 'profiles', 'dsh-tui')
  for (const entry of readdirSync(sourceProfile, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    copyIfPresent(join(sourceProfile, entry.name), join(targetProfile, entry.name))
  }
  // The input test needs a real dsh-tui session, not the environment-specific
  // agent preset. Disable it only in this disposable DSH_HOME.
  appendFileSync(join(targetProfile, 'cordis.patch.yml'), '\n- id: agent-presets\n  disabled: true\n')
  copyProfileNodeModules(sourceProfile, targetProfile)
  return { userHome, dshHome }
}

function waitFor(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForHistory(historyPath, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(historyPath)) {
      const entries = readFileSync(historyPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap(line => {
          try {
            const value = JSON.parse(line)
            return typeof value.text === 'string' ? [value.text] : []
          } catch {
            return []
          }
        })
      if (entries.includes(message)) return entries
    }
    await waitFor(100)
  }
  return []
}

async function runCase(label, external, pastedLineBreak = '\n') {
  const root = mkdtempSync(join(tmpdir(), 'superhigh-dsh-multiline-'))
  try {
    const { userHome, dshHome } = prepareIsolatedHome(root)
    const env = {
      ...process.env,
      DSH_HOME: dshHome,
      USERPROFILE: userHome,
      HOME: userHome,
      APPDATA: join(userHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
      DSH_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(external
        ? { SUPERHIGH_EXTERNAL_CONSOLE: '1', TERM_PROGRAM: '', WT_SESSION: '' }
        : { SUPERHIGH_EXTERNAL_CONSOLE: '', TERM_PROGRAM: 'SuperHigh', WT_SESSION: 'SuperHigh' }),
    }
    const child = pty.spawn(process.execPath, [dshBin, '--profile', 'dsh-tui'], {
      name: 'xterm-256color',
      cols: 140,
      rows: 45,
      cwd: repoRoot,
      env,
    })
    let output = ''
    const outputDisposable = child.onData(data => {
      output += data
      if (output.length > 200_000) output = output.slice(-100_000)
    })
    await waitFor(3500)
    if (external) {
      // Classic conhost can send each pasted line break as LF or CRLF, while
      // the submit key arrives separately as CR. Exercise both forms.
      const lines = message.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) child.write(pastedLineBreak)
        child.write(lines[index])
        await waitFor(18)
      }
      await waitFor(120)
      child.write('\r')
    } else {
      child.write(`\x1b[200~${message}\x1b[201~`)
      await waitFor(120)
      child.write('\r')
    }

    const entries = await waitForHistory(join(userHome, '.dsh-tui', 'history.jsonl'))
    child.write('\x03')
    await waitFor(350)
    child.kill()
    outputDisposable.dispose()

    const exact = entries.filter(entry => entry === message)
    const fragments = entries.filter(entry => entry === message.split('\n')[0] || entry === message.split('\n')[1])
    if (exact.length !== 1 || fragments.length !== 0) {
      const diagnostic = output.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '').slice(-2000)
      throw new Error(`${label}: history did not contain one complete message (entries=${JSON.stringify(entries)}); output=${JSON.stringify(diagnostic)}`)
    }
    console.log(`${label}: PASS (one complete history entry, ${message.length} chars)`)
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await runCase('internal PTY', false)
await runCase('external CMD input (LF chunks)', true, '\n')
await runCase('external CMD input (CRLF chunks)', true, '\r\n')
