import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const integrateScript = join(projectRoot, 'scripts', 'integrate.ps1')

test('locked-entry fallback stops only an unprotected desktop and never launches before deployment', { skip: process.platform !== 'win32' }, () => {
  const script = String.raw`
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INTEGRATE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Parse error' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-SessionSafeRestart' }, $true)
. ([scriptblock]::Create($definition.Extent.Text))
$deployDir = 'D:\fixture'; $tmpRoot = 'D:\fixture-tmp'; $Restart = $true
$script:stopped = 0
function Get-Process { [CmdletBinding()] param($Name) [pscustomobject]@{Path='D:\fixture\super-high.exe'} }
function Stop-Process { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject) process { $script:stopped++ } }
function Wait-Process { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, $Timeout) process {} }
function Get-TerminalSessionList { param($CliPath)
  if ($script:mode -eq 'failed') { throw 'query failed' }
  return @{ok=$true; sessions=@(@{holdsPtyChild=($script:mode -eq 'held');providerKind='codex';title='fixture';cwd='D:\fixture'})}
}
$results = foreach ($script:mode in @('idle','held','failed')) {
  $summary = @{running=$false;restartBlockedBy=@()}; $script:stopped=0; $errorText=''
  try { Invoke-SessionSafeRestart -StopOnly } catch { $errorText=$_.Exception.Message }
  @{mode=$script:mode;stopped=$script:stopped;blocked=$summary.restartBlockedBy.Count;error=$errorText}
}
$results | ConvertTo-Json -Compress
`
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: projectRoot, env: { ...process.env, INTEGRATE_SCRIPT: integrateScript }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  })
  assert.equal(child.status, 0, child.stderr)
  const [idle, held, failed] = JSON.parse(child.stdout.trim())
  assert.equal(idle.stopped, 1)
  assert.equal(idle.error, '')
  assert.equal(held.stopped, 0)
  assert.equal(held.blocked, 1)
  assert.equal(failed.stopped, 0)
  assert.match(failed.error, /query failed/)
})
const expectedTitle = '示例游戏服务器'
const powershell = String.raw`
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INTEGRATE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Integration script failed to parse.' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-TerminalSessionList' }, $true)
if (!$definition) { throw 'Session listing helper missing.' }
. ([scriptblock]::Create($definition.Extent.Text))
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
$before = [Console]::OutputEncoding.CodePage
try {
  $result = Get-TerminalSessionList $env:INTEGRATE_FAKE_CLI
  $answer = @{ ok = $true; titleMatches = ($result.sessions[0].title -ceq $env:INTEGRATE_EXPECTED_TITLE) }
} catch {
  $answer = @{ ok = $false; message = $_.Exception.Message }
}
$answer.before = $before
$answer.after = [Console]::OutputEncoding.CodePage
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$answer | ConvertTo-Json -Compress
`

function runFixture(t, mode) {
  const tmpRoot = join(projectRoot, '.agent', 'tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const fixture = mkdtempSync(join(tmpRoot, 'integrate-encoding-'))
  const resolvedRoot = realpathSync(tmpRoot)
  const resolvedFixture = realpathSync(fixture)
  assert.equal(dirname(resolvedFixture), resolvedRoot)
  assert.match(basename(resolvedFixture), /^integrate-encoding-/)
  t.after(() => rmSync(resolvedFixture, { recursive: true }))
  const fakeCli = join(fixture, 'superhigh-cli.cmd')
  writeFileSync(fakeCli, `@echo off\r\n"${process.execPath}" "%~dp0fixture.cjs" %*\r\n`)
  writeFileSync(join(fixture, 'fixture.cjs'), `
    if (process.env.INTEGRATE_FIXTURE_MODE === 'fail') process.exit(9)
    if (process.env.INTEGRATE_FIXTURE_MODE === 'invalid') process.stdout.write('invalid json')
    else process.stdout.write(JSON.stringify({ ok: true, sessions: [{ title: process.env.INTEGRATE_EXPECTED_TITLE }] }))
  `)
  const child = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64'),
  ], {
    cwd: projectRoot,
    env: { ...process.env, INTEGRATE_SCRIPT: integrateScript, INTEGRATE_FAKE_CLI: fakeCli,
      INTEGRATE_EXPECTED_TITLE: expectedTitle, INTEGRATE_FIXTURE_MODE: mode },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  })
  assert.equal(child.status, 0, child.stderr)
  const answer = JSON.parse(child.stdout.trim())
  assert.equal(answer.before, 936)
  assert.equal(answer.after, 936)
  return answer
}

test('terminal session listing decodes UTF-8 under a legacy console code page', { skip: process.platform !== 'win32' }, t => {
  const answer = runFixture(t, 'ok')
  assert.equal(answer.ok, true)
  assert.equal(answer.titleMatches, true)
})

test('terminal session listing fails closed for invalid JSON or a failed CLI', { skip: process.platform !== 'win32' }, t => {
  assert.equal(runFixture(t, 'invalid').ok, false)
  const failed = runFixture(t, 'fail')
  assert.equal(failed.ok, false)
  assert.match(failed.message, /terminal list/)
})

test('restart entry blocks a running fixture session with a Chinese title', { skip: process.platform !== 'win32' }, async t => {
  const tmpRoot = join(projectRoot, '.agent', 'tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const fixture = realpathSync(mkdtempSync(join(tmpRoot, 'integrate-restart-')))
  assert.equal(dirname(fixture), realpathSync(tmpRoot))
  assert.notEqual(fixture, realpathSync(projectRoot))
  let fixtureProcess = null
  t.after(async () => {
    if (fixtureProcess && fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
      const exited = once(fixtureProcess, 'exit')
      fixtureProcess.kill()
      await exited
    }
    assert.equal(dirname(realpathSync(fixture)), realpathSync(tmpRoot))
    rmSync(fixture, { recursive: true })
  })
  const scriptsDir = join(fixture, 'scripts')
  const deployDir = join(fixture, 'deploy')
  mkdirSync(scriptsDir)
  mkdirSync(deployDir)
  copyFileSync(integrateScript, join(scriptsDir, 'integrate.ps1'))
  copyFileSync(join(projectRoot, 'scripts', 'prune-integrate-runs.ps1'), join(scriptsDir, 'prune-integrate-runs.ps1'))
  const reply = JSON.stringify({ ok: true, sessions: [{ holdsPtyChild: true, providerKind: 'test',
    title: expectedTitle, cwd: fixture }] })
  const source = join(fixture, 'stub.rs')
  writeFileSync(source, `fn main() {
    if std::env::args().nth(1).as_deref() == Some("terminal") {
      print!("{}", ${JSON.stringify(reply)});
    } else {
      std::thread::sleep(std::time::Duration::from_secs(20));
    }
  }\n`)
  const app = join(deployDir, 'super-high.exe')
  const compiler = spawnSync('rustc', ['--edition=2021', source, '-o', app], {
    cwd: fixture, encoding: 'utf8', timeout: 30000, windowsHide: true,
  })
  assert.equal(compiler.status, 0, compiler.stderr)
  copyFileSync(app, join(deployDir, 'superhigh-cli.exe'))
  fixtureProcess = spawn(app, [], { cwd: fixture, stdio: 'ignore', windowsHide: true })
  await once(fixtureProcess, 'spawn')
  const check = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($env:INTEGRATE_FIXTURE_LINK)
$link.TargetPath = $env:INTEGRATE_FIXTURE_APP
$link.Save()
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
$output = & $env:INTEGRATE_FIXTURE_SCRIPT -RestartOnly -Shortcut $env:INTEGRATE_FIXTURE_LINK | Out-String
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Write-Output $output
`
  const child = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64'),
  ], { cwd: fixture, env: { ...globalThis.process.env, INTEGRATE_FIXTURE_LINK: join(fixture, 'fixture.lnk'),
    INTEGRATE_FIXTURE_APP: app, INTEGRATE_FIXTURE_SCRIPT: join(scriptsDir, 'integrate.ps1') },
  encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  const summary = JSON.parse(child.stdout.trim())
  assert.equal(summary.running, true)
  assert.equal(summary.restarted, false)
  assert.equal(summary.restartBlockedBy.length, 1)
  assert.match(summary.restartBlockedBy[0], new RegExp(expectedTitle))
  assert.equal(fixtureProcess.exitCode, null)
})
