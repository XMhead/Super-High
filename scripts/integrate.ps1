# 唯一集成入口：加锁 → 合并 Agent 分支 → 正式构建 → 改名替换在用 EXE → 会话保护下可选重启 → 可选公开同步；-SyncOnly 只做公开同步。
[CmdletBinding()]
param(
  [string[]]$Merge = @(),
  [switch]$Restart,
  [switch]$SyncPublic,
  # 只做会话保护下的重启，不构建、不部署。
  [switch]$RestartOnly,
  # 重启时带 --webview2-automation 启动实际入口，供桌面 CDP 验收。
  [switch]$Automation,
  # 只同步已提交源码：桌面验收通过后补同步，不构建、不部署、不重启。
  [switch]$SyncOnly,
  [ValidateSet('None', 'Desktop', 'Mobile', 'Frontend', 'Rust', 'All')][string]$Checks = 'None',
  [string]$Shortcut = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Super High.lnk')
)

$ErrorActionPreference = 'Stop'
if ($RestartOnly -and ($Merge -or $SyncPublic)) { throw '-RestartOnly 不能与 -Merge/-SyncPublic 同时使用' }
if ($SyncOnly -and ($Merge -or $Restart -or $RestartOnly -or $SyncPublic)) { throw '-SyncOnly 不能与 -Merge/-Restart/-RestartOnly/-SyncPublic 同时使用' }
if ($RestartOnly) { $Restart = [switch]$true }
if ($Automation -and -not $Restart) { throw '-Automation 需要配合 -Restart 或 -RestartOnly' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$tmpRoot = Join-Path $repoRoot '.agent\tmp\integrate'
$runDir = Join-Path $tmpRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

function Invoke-Git { git -C $repoRoot @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') 失败" } }
function Get-Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

# 进程退出时系统自动释放该锁，异常中断不会留下死锁。
$lockPath = Join-Path $tmpRoot 'integrate.lock'
$lockDeadline = (Get-Date).AddMinutes(30)
while ($true) {
  try { $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); break }
  catch {
    if ((Get-Date) -gt $lockDeadline) { throw "等待其他集成超过 30 分钟（$lockPath 被占用），已放弃" }
    if (-not $lockWaiting) { Write-Host '另一个集成正在进行，等待其完成…' -ForegroundColor Yellow; $lockWaiting = $true }
    Start-Sleep -Seconds 3
  }
}
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
# 持锁后清理旧留档；失败只警告，不影响本轮集成。
try { & (Join-Path $PSScriptRoot 'prune-integrate-runs.ps1') -TmpRoot $tmpRoot -Keep 5 }
catch { Write-Warning "旧集成留档清理未完成：$($_.Exception.Message)" }

$summary = [ordered]@{ merged = @(); commit = $null; buildSeconds = $null; deployed = @{}; running = $false; restarted = $false; automation = [bool]$Automation; restartBlockedBy = @(); publicSync = $null }

function Invoke-PublicSync {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot '.codex\skills\superhigh-public-publish\scripts\publish-public.ps1') -KeepWorktree -Checks $Checks
  if ($LASTEXITCODE -ne 0) { throw '公开源码同步失败；本机部署（若有）已完成' }
  $summary.publicSync = (git -C $repoRoot ls-remote origin refs/heads/main).Split()[0].Substring(0, 12)
}

# 改名后旧进程路径会跟随到 replaced 目录，两处都算在用实例。持有 PTY 的内部会话存在时只报告不重启。
function Invoke-SessionSafeRestart {
  $procs = @(Get-Process super-high -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path -like "$deployDir\*" -or $_.Path -like "$tmpRoot\*")
  })
  $summary.running = $procs.Count -gt 0
  if (-not $Restart) { return }
  if ($procs) {
    $listing = & (Join-Path $deployDir 'superhigh-cli.exe') terminal list --json | Out-String | ConvertFrom-Json
    if (-not $listing.ok) { throw "terminal list 失败，按会话保护不重启：$($listing.error)" }
    $held = @($listing.sessions | Where-Object holdsPtyChild)
    if ($held) {
      $summary.restartBlockedBy = @($held | ForEach-Object { "$($_.providerKind) $($_.title) @ $($_.cwd)" })
      return
    }
    $procs | Stop-Process
    $procs | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue
  }
  if ($Automation) {
    # 桌面自动化须首次启动即带参数；验收后用不带 -Automation 的 -RestartOnly 关闭调试端口。
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
    $workDir = if ($link.WorkingDirectory) { $link.WorkingDirectory } else { $deployDir }
    Start-Process -FilePath $entry -ArgumentList '--webview2-automation' -WorkingDirectory $workDir
  } else {
    Start-Process -FilePath $Shortcut
  }
  $deadline = (Get-Date).AddSeconds(30)
  do { Start-Sleep -Milliseconds 500; $live = Get-Process super-high -ErrorAction SilentlyContinue | Where-Object Path -eq $entry }
  while (-not $live -and (Get-Date) -lt $deadline)
  if (-not $live) { throw '启动后 30 秒内未检测到新进程' }
  $summary.restarted = $true
}

try {
  $entry = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut).TargetPath
  if (-not $entry -or -not (Test-Path -LiteralPath $entry)) { throw "无法从快捷方式定位实际入口：$Shortcut" }
  $deployDir = Split-Path -Parent $entry
  if ($RestartOnly) {
    Invoke-SessionSafeRestart
    [pscustomobject]$summary | ConvertTo-Json -Depth 3
    return
  }

  if ((git -C $repoRoot branch --show-current) -ne 'private') { throw '主工作区必须位于 private 分支' }
  # 单 Agent 直接构建工作区现状；合并与公开同步只取提交，须先提交。
  if (($Merge -or $SyncPublic -or $SyncOnly) -and (git -C $repoRoot status --porcelain --untracked-files=no)) { throw '-Merge/-SyncPublic/-SyncOnly 需要主工作区无未提交改动；先提交' }
  if ($SyncOnly) {
    $summary.commit = (git -C $repoRoot rev-parse --short HEAD)
    Invoke-PublicSync
    [pscustomobject]$summary | ConvertTo-Json -Depth 3
    return
  }

  foreach ($branch in $Merge) {
    git -C $repoRoot merge --no-edit $branch
    if ($LASTEXITCODE -ne 0) {
      git -C $repoRoot merge --abort
      throw "$branch 与 private 冲突，已撤销合并；让该 Agent 在其工作树执行 git rebase private 解决后重试"
    }
    $summary.merged += $branch
  }
  $summary.commit = (git -C $repoRoot rev-parse --short HEAD)
  if (git -C $repoRoot status --porcelain --untracked-files=no) { $summary.commit += '+uncommitted' }

  # vite 清空 dist-mobile 会触发本机批量删除守卫，先移开。
  $mobileDist = Join-Path $repoRoot 'dist-mobile'
  if (Test-Path -LiteralPath $mobileDist) { Move-Item -LiteralPath $mobileDist (Join-Path $runDir 'dist-mobile.prev') }
  # 与 agent-worktree.ps1 的工作树共用 sccache 依赖缓存；未安装时照常独立编译。
  $sccache = Get-Command sccache -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
  if (-not $sccache) { $sccache = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\sccache.exe' }
  if (-not $env:RUSTC_WRAPPER -and (Test-Path -LiteralPath $sccache)) { $env:RUSTC_WRAPPER = $sccache }
  $fingerprintScript = Join-Path $PSScriptRoot 'build-input-fingerprint.mjs'
  $inputManifest = Join-Path $runDir 'build-inputs.json'
  $sourceFingerprint = & node $fingerprintScript snapshot $repoRoot $inputManifest
  if ($LASTEXITCODE -ne 0) { throw '记录构建输入失败，已停止构建' }
  $summary.buildInputs = ($sourceFingerprint | ConvertFrom-Json)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  Push-Location $repoRoot
  try { npm run tauri:build -- --no-bundle; if ($LASTEXITCODE -ne 0) { throw '正式构建失败' } }
  finally { Pop-Location }
  $summary.buildSeconds = [int]$watch.Elapsed.TotalSeconds
  & node $fingerprintScript verify $repoRoot $inputManifest | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '构建输入复核失败，已停止部署；冻结源码或使用独立快照重新构建' }

  # Windows 允许改名正在运行的 EXE：旧文件让位后复制新文件，无需先关闭应用。
  $replaced = Join-Path $runDir 'replaced'
  New-Item -ItemType Directory -Force -Path $replaced | Out-Null
  foreach ($name in 'super-high.exe', 'superhigh-cli.exe') {
    $built = Join-Path $repoRoot "src-tauri\target\release\$name"
    $dest = Join-Path $deployDir $name
    if (Test-Path -LiteralPath $dest) {
      $aside = "$dest.replaced-$(Split-Path -Leaf $runDir)"
      Rename-Item -LiteralPath $dest (Split-Path -Leaf $aside)
      try { Move-Item -LiteralPath $aside (Join-Path $replaced $name) } catch { Write-Warning "旧文件留在 $aside：$($_.Exception.Message)" }
    }
    Copy-Item -LiteralPath $built $dest
    if ((Get-Hash $built) -ne (Get-Hash $dest)) { throw "$name 部署后哈希不一致" }
    $summary.deployed[$name] = (Get-Hash $dest).Substring(0, 12)
  }
  $destMobile = Join-Path $deployDir 'dist-mobile'
  if (Test-Path -LiteralPath $destMobile) { Move-Item -LiteralPath $destMobile (Join-Path $replaced 'dist-mobile') }
  Copy-Item -LiteralPath $mobileDist $destMobile -Recurse

  Invoke-SessionSafeRestart

  if ($SyncPublic) { Invoke-PublicSync }
} catch {
  $summary.error = $_.Exception.Message
  throw
} finally {
  $lock.Dispose()
  # 留档供其他 Agent 判断上一轮集成停在哪一步。
  [pscustomobject]$summary | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $runDir 'summary.json') -Encoding utf8
}
[pscustomobject]$summary | ConvertTo-Json -Depth 3
