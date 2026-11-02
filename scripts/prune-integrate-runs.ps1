# 集成留档只保留最近几轮：较早的 <时间> 目录（旧 EXE、dist-mobile.prev、构建指纹）永久删除。
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$TmpRoot,
  [ValidateRange(1, 100)][int]$Keep = 5
)

$ErrorActionPreference = 'Stop'
$root = Get-Item -LiteralPath $TmpRoot
if (-not $root.PSIsContainer -or $root.Attributes -band [IO.FileAttributes]::ReparsePoint -or $root.Name -ne 'integrate') {
  throw 'Prune requires the non-linked .agent\tmp\integrate directory.'
}
$runs = @(Get-ChildItem -LiteralPath $root.FullName -Directory | Where-Object Name -match '^\d{8}-\d{6}$' | Sort-Object Name)
if ($runs.Count -le $Keep) { return }
# 改名让位的旧进程仍从 replaced 目录运行，这些目录跳过到下次。
$running = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath)
foreach ($run in $runs[0..($runs.Count - $Keep - 1)]) {
  if ($run.Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Warning "Linked run skipped: $($run.FullName)"; continue }
  if ($running | Where-Object { $_.StartsWith($run.FullName + '\', [StringComparison]::OrdinalIgnoreCase) }) {
    Write-Warning "Run in use skipped: $($run.FullName)"
    continue
  }
  if ($PSCmdlet.ShouldProcess($run.FullName, 'Remove old integrate run')) {
    Remove-Item -LiteralPath $run.FullName -Recurse -Force
    if (Test-Path -LiteralPath $run.FullName) { throw "Run removal incomplete: $($run.FullName)" }
  }
}
