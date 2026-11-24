[CmdletBinding()]
param(
  [string]$SourceBranch = 'private',
  [string]$WorktreePath = '',
  [ValidateSet('None', 'Desktop', 'Mobile', 'Frontend', 'Rust', 'All')]
  [string]$Checks = 'None',
  [switch]$SkipBuild,
  [switch]$NoPush,
  # 默认保留完成后的工作树，由 agent-cleaner 核对并回收。
  # 仅显式 -KeepWorktree:$false 才执行下方永久清理分支。
  [switch]$KeepWorktree = $true,
  [switch]$Continue
)

$ErrorActionPreference = 'Stop'

if ($SkipBuild -and $Checks -ne 'None') {
  throw '-SkipBuild 不能与 -Checks 构建检查同时使用。'
}

function Assert-Inside {
  param([string]$Target, [string]$Root)
  $targetFull = [IO.Path]::GetFullPath($Target)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $targetFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside worktree: $Target"
  }
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $skillRoot 'references/private-manifest.json') | ConvertFrom-Json

$repoRoot = git -C $PSScriptRoot rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw '当前目录不在 git 仓库内。' }
$repoRoot = $repoRoot.Trim()

if (-not $WorktreePath) { $WorktreePath = Join-Path $repoRoot '.publish-worktree' }
$WorktreePath = [IO.Path]::GetFullPath($WorktreePath)
Assert-Inside -Target $WorktreePath -Root $repoRoot

# 串行化公开同步：后到者等待前一轮推送完成，再从最新 private 生成快照，避免互相覆盖 main。
$lockPath = Join-Path $repoRoot '.agent\tmp\publish-public.lock'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
$lockDeadline = (Get-Date).AddMinutes(30)
while ($true) {
  try { $publishLock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); break }
  catch {
    if ((Get-Date) -gt $lockDeadline) { throw '等待其他公开同步超过 30 分钟，已放弃' }
    if (-not $lockWaiting) { Write-Host '另一个公开同步正在进行，等待其完成…' -ForegroundColor Yellow; $lockWaiting = $true }
    Start-Sleep -Seconds 3
  }
}

$pushOnlyRetry = $false
try {
  if (-not $Continue) {
    if (Test-Path -LiteralPath $WorktreePath) {
      # 默认保留的上次工作树若干净且与已发布的本地 main 同树，说明已完成，移入回收站后继续。
      $leftTree = git -C $WorktreePath rev-parse 'HEAD^{tree}' 2>$null
      $mainTree = git -C $repoRoot rev-parse 'main^{tree}' 2>$null
      $leftDirty = git -C $WorktreePath status --porcelain 2>$null
      $worktreeItem = Get-Item -LiteralPath $WorktreePath -Force
      if (-not $leftTree -or $leftTree -ne $mainTree -or $leftDirty -or -not $worktreeItem.PSIsContainer -or $worktreeItem.LinkType) {
        throw "工作树已存在且不是已发布快照：$WorktreePath（用 -Continue 续跑，或核对后删除）。"
      }
      $leftNodeModules = Join-Path $WorktreePath 'node_modules'
      if ((Test-Path -LiteralPath $leftNodeModules) -and (Get-Item -LiteralPath $leftNodeModules -Force).LinkType -eq 'Junction') {
        [IO.Directory]::Delete($leftNodeModules, $false)  # 只删链接本身；Remove-Item 会停在交互确认
      }
      Add-Type -AssemblyName Microsoft.VisualBasic
      try {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($WorktreePath, 'OnlyErrorDialogs', 'SendToRecycleBin')
        git -C $repoRoot worktree prune
        Write-Host "已将上次已发布的工作树移入回收站：$WorktreePath"
      } catch {
        # 回收站不可用时，干净且与 main 同树的工作树可由 main 完整重建，直接移除不丢内容。
        git -C $repoRoot worktree remove $WorktreePath
        if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $WorktreePath)) { throw "移除上次已发布的工作树失败：$WorktreePath" }
        Write-Host "回收站不可用，已移除与 main 同树的上次工作树：$WorktreePath"
      }
    }

    $srcSha = git -C $repoRoot rev-parse --verify "$SourceBranch^{commit}"
    if ($LASTEXITCODE -ne 0) { throw "找不到源分支：$SourceBranch" }

    git -C $repoRoot worktree add --detach $WorktreePath $srcSha
    if ($LASTEXITCODE -ne 0) { throw '创建发布工作树失败。' }

    # 核对排除目标后再删除；目录链接只摘除链接本身。
    $excludedItems = @(
      foreach ($rel in $manifest.excludedPaths) {
        $target = [IO.Path]::GetFullPath((Join-Path $WorktreePath ($rel.Replace('/', '\'))))
        Assert-Inside -Target $target -Root $WorktreePath
        if (Test-Path -LiteralPath $target) {
          $item = Get-Item -LiteralPath $target -Force
          if ($item.LinkType) {
            Write-Host "排除链接：$($item.FullName) -> $($item.Target -join ', ')"
          }
          $item
        }
      }
    )
    foreach ($item in $excludedItems) {
      $removeOptions = @{ LiteralPath = $item.FullName }
      if ($item.PSIsContainer -and -not $item.LinkType) {
        $children = @(Get-ChildItem -LiteralPath $item.FullName -Force)
        if ($children.Count -gt 0) { $removeOptions.Recurse = $true }
        $removeOptions.Force = $true
      } elseif ($item.Attributes -band ([IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)) {
        $removeOptions.Force = $true
      }
      Remove-Item @removeOptions
    }
    foreach ($item in $excludedItems) {
      if (Test-Path -LiteralPath $item.FullName) { throw "排除项删除失败：$($item.FullName)" }
    }

  } else {
    if (-not (Test-Path -LiteralPath $WorktreePath)) { throw '-Continue 需要已存在的工作树。' }
  }

  # 脱敏扫描始终执行；构建仅补充尚未覆盖的验收。
  & (Join-Path $PSScriptRoot 'verify-public.ps1') -Path $WorktreePath
  if ($LASTEXITCODE -ne 0) { throw '敏感扫描未通过，修复后再发布。' }

  Write-Host "公开树构建检查：$Checks"
  if ($Checks -in @('Desktop', 'Mobile', 'Frontend', 'All')) {
    # 仅前端检查需要复用根目录依赖，续跑也使用同一入口。
    $worktreeNodeModules = Join-Path $WorktreePath 'node_modules'
    if (-not (Test-Path -LiteralPath $worktreeNodeModules)) {
      $repoNodeModules = Join-Path $repoRoot 'node_modules'
      if (Test-Path -LiteralPath $repoNodeModules) {
        New-Item -ItemType Junction -Path $worktreeNodeModules -Target $repoNodeModules | Out-Null
      }
    }
    Push-Location $WorktreePath
    try {
      if ($Checks -in @('Desktop', 'Frontend', 'All')) {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败。' }
      }
      if ($Checks -in @('Mobile', 'Frontend', 'All')) {
        npm run mobile:build
        if ($LASTEXITCODE -ne 0) { throw 'npm run mobile:build 失败。' }
      }
    } finally {
      Pop-Location
    }

  }

  if ($Checks -in @('Rust', 'All')) {
    $previousCargoTarget = $env:CARGO_TARGET_DIR
    Push-Location (Join-Path $WorktreePath 'src-tauri')
    try {
      $env:CARGO_TARGET_DIR = Join-Path $repoRoot 'src-tauri\target'
      cargo check
      if ($LASTEXITCODE -ne 0) { throw 'cargo check 失败。' }
    } finally {
      $env:CARGO_TARGET_DIR = $previousCargoTarget
      Pop-Location
    }
  }

  if ($Checks -ne 'None') {
    & (Join-Path $PSScriptRoot 'verify-public.ps1') -Path $WorktreePath
    if ($LASTEXITCODE -ne 0) { throw '构建后敏感扫描未通过，修复后再发布。' }
  }

  git -C $WorktreePath add -A
  # 工作树从 private 提交检出，提交统计会把脱敏排除项列为 delete mode；静默，改为下方对比上次公开快照。
  git -C $WorktreePath -c user.name="Super High Publish" -c user.email="publish@superhigh.local" commit --quiet -m "Publish public snapshot" --allow-empty
  if ($LASTEXITCODE -ne 0) { throw '快照提交失败。' }
  $snapshotSha = git -C $WorktreePath rev-parse HEAD

  # 生成孤儿根提交（同树、无父提交），保证推送到 GitHub 的历史不包含任何 private 提交。
  $snapshotTree = git -C $WorktreePath rev-parse "$snapshotSha^{tree}"
  git -C $repoRoot rev-parse --verify --quiet main | Out-Null
  $releaseMessage = if ($LASTEXITCODE -ne 0) { 'Initial public release' } else { 'Publish public snapshot' }
  $rootCommit = git -C $WorktreePath commit-tree $snapshotTree -m $releaseMessage
  if ($LASTEXITCODE -ne 0) { throw '公开根提交创建失败。' }
  $previousPublic = git -C $repoRoot rev-parse --verify --quiet 'refs/remotes/origin/main'
  if ($LASTEXITCODE -eq 0 -and $previousPublic) {
    Write-Host '相对上次公开快照的变更：'
    git -C $repoRoot diff --stat=120 --stat-count=40 $previousPublic $rootCommit
  }

  git -C $repoRoot branch -f main $rootCommit
  if ($LASTEXITCODE -ne 0) { throw '更新本地 main 分支失败。' }

  if (-not $NoPush) {
    # 每次都是无父根提交，普通推送必被拒绝；直接用 lease 推送，网络抖动时重试。
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      git -C $repoRoot push --force-with-lease origin main
      if ($LASTEXITCODE -eq 0) { break }
      if ($attempt -lt 3) { Write-Host "推送失败，5 秒后重试（$attempt/3）" -ForegroundColor Yellow; Start-Sleep -Seconds 5 }
    }
    if ($LASTEXITCODE -ne 0) { $pushOnlyRetry = $true; throw '推送到 origin/main 失败。' }
    Write-Host "已推送 $rootCommit 到 origin/main" -ForegroundColor Green
  } else {
    Write-Host "本地 main 已更新为 $rootCommit（未推送）" -ForegroundColor Green
  }
  # 同树切换：保留的工作树直接对应公开 main，可作为 publish-local-release 的 --source。
  git -C $WorktreePath checkout --quiet --detach $rootCommit
  if ($LASTEXITCODE -ne 0) { throw '工作树切换到公开根提交失败。' }

  if (-not $KeepWorktree) {
    # 先摘除 node_modules 软链，避免 git 遍历真实依赖目录导致删除失败/误删。
    $worktreeNodeModules = Join-Path $WorktreePath 'node_modules'
    if (Test-Path -LiteralPath $worktreeNodeModules) {
      $nodeModulesItem = Get-Item -LiteralPath $worktreeNodeModules -Force
      if ($nodeModulesItem.LinkType -eq 'Junction') {
        Assert-Inside -Target $nodeModulesItem.FullName -Root $WorktreePath
        [IO.Directory]::Delete($worktreeNodeModules, $false)
        if (Test-Path -LiteralPath $worktreeNodeModules) { throw '依赖目录链接清理失败。' }
      }
    }
    $worktreeFull = [IO.Path]::GetFullPath($WorktreePath)
    Assert-Inside -Target $worktreeFull -Root $repoRoot
    $worktreeItem = Get-Item -LiteralPath $worktreeFull -Force
    if (-not $worktreeItem.PSIsContainer -or $worktreeItem.LinkType) { throw '拒绝清理非普通目录工作树。' }
    Remove-Item -LiteralPath $worktreeFull -Recurse -Force
    if (Test-Path -LiteralPath $worktreeFull) { throw '工作树清理失败。' }
    git -C $repoRoot worktree prune
  }
  exit 0
} catch {
  Write-Host "发布失败：$_" -ForegroundColor Red
  Write-Host "工作树保留在：$WorktreePath" -ForegroundColor Yellow
  if ($pushOnlyRetry) {
    Write-Host "本地 main 已是本次快照，恢复网络后只需重推：git push --force-with-lease origin main" -ForegroundColor Yellow
  } else {
    $noPushHint = if ($NoPush) { ' -NoPush' } else { '' }
    Write-Host "修复后继续：publish-public.ps1 -Continue -Checks $Checks$noPushHint" -ForegroundColor Yellow
  }
  exit 1
} finally {
  $publishLock.Dispose()
}
