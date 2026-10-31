# 并行 Agent 的隔离工作树：每个 Agent 一个分支与目录，构建与部署统一交给 integrate.ps1。
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Name,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
# 放在仓库外，避免嵌套工作树干扰 Tauri 项目发现。
$worktreeRoot = Join-Path (Split-Path -Parent $repoRoot) 'SH-worktrees'
$worktree = Join-Path $worktreeRoot $Name
$branch = "agent/$Name"

function Invoke-Git { git -C $repoRoot @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') 失败" } }

if (-not $Remove) {
  if (Test-Path -LiteralPath $worktree) { throw "工作树已存在：$worktree" }
  New-Item -ItemType Directory -Force -Path $worktreeRoot | Out-Null
  # Cargo 向上查找配置：工作树根的 rustc-wrapper 让所有工作树共用 sccache，不影响公开仓库。
  $sccache = Get-Command sccache -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
  if (-not $sccache) { $sccache = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\sccache.exe' }
  $cargoConfig = Join-Path $worktreeRoot '.cargo\config.toml'
  if ((Test-Path -LiteralPath $sccache) -and -not (Test-Path -LiteralPath $cargoConfig)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cargoConfig) | Out-Null
    Set-Content -LiteralPath $cargoConfig -Encoding ascii -Value "[build]`r`nrustc-wrapper = '$sccache'"
  } elseif (-not (Test-Path -LiteralPath $sccache)) { Write-Warning '未找到 sccache，工作树将独立编译；可用 winget install Mozilla.sccache 安装' }
  Invoke-Git worktree add -b $branch $worktree private
  # 共用根依赖；junction 删除时只摘链接，不影响根 node_modules。
  New-Item -ItemType Junction -Path (Join-Path $worktree 'node_modules') -Target (Join-Path $repoRoot 'node_modules') | Out-Null
  # Tauri 构建脚本要求前端产物目录存在，cargo check 用空目录即可。
  foreach ($dist in 'dist', 'dist-mobile') { New-Item -ItemType Directory -Force -Path (Join-Path $worktree $dist) | Out-Null }
  [pscustomobject]@{ worktree = $worktree; branch = $branch } | ConvertTo-Json
  return
}

if (-not (Test-Path -LiteralPath $worktree)) { throw "工作树不存在：$worktree" }
$dirty = git -C $worktree status --porcelain
if ($dirty) { throw "工作树有未提交或未跟踪内容，未移除：$worktree" }
git -C $repoRoot merge-base --is-ancestor $branch private
if ($LASTEXITCODE -ne 0) { throw "$branch 尚未合入 private，未移除" }
$link = Join-Path $worktree 'node_modules'
if ((Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue).LinkType -eq 'Junction') { [System.IO.Directory]::Delete($link) }
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($worktree, 'OnlyErrorDialogs', 'SendToRecycleBin')
Invoke-Git worktree prune
Invoke-Git branch -d $branch | Out-Null
[pscustomobject]@{ recycled = $worktree; deletedBranch = $branch } | ConvertTo-Json
