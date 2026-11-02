[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$KeepTarget,
  [ValidateSet('debug', 'release')][string]$KeepProfile = 'release',
  [string]$BuildRoot
)

$ErrorActionPreference = 'Stop'
if (-not $BuildRoot) {
  $BuildRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri'
}
$root = Get-Item -LiteralPath $BuildRoot
$keep = Get-Item -LiteralPath $KeepTarget
if (-not $root.PSIsContainer -or -not $keep.PSIsContainer -or
    $root.Attributes -band [IO.FileAttributes]::ReparsePoint -or
    $keep.Attributes -band [IO.FileAttributes]::ReparsePoint -or
    $keep.Parent.FullName -ne $root.FullName -or $keep.Name -notmatch '^target(?:-.+)?$') {
  throw 'Cache retention requires a non-linked target directory directly inside the build root.'
}
if (-not (Test-Path -LiteralPath (Join-Path $keep.FullName "$KeepProfile\super-high.exe") -PathType Leaf)) {
  throw 'The retained build has no desktop executable.'
}
$processes = @(Get-CimInstance Win32_Process)
if ($processes | Where-Object { $_.Name -in @('cargo.exe', 'rustc.exe', 'rustdoc.exe') }) {
  Write-Warning 'Another Rust build is active; cache retention skipped.'
  return
}

# Only compiler-cache subdirectories are disposable. Keep executables, PDBs,
# bundles and other delivered files, even in a historical target directory.
$candidates = @()
foreach ($target in Get-ChildItem -LiteralPath $root.FullName -Directory) {
  if ($target.Name -notmatch '^target(?:-.+)?$' -or $target.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
  foreach ($profile in @('debug', 'release')) {
    if ($target.FullName -eq $keep.FullName -and $profile -eq $KeepProfile) { continue }
    $profilePath = Join-Path $target.FullName $profile
    if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) { continue }
    if ((Get-Item -LiteralPath $profilePath).Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    foreach ($name in @('deps', 'build', 'incremental', '.fingerprint', 'examples')) {
      $candidate = Join-Path $profilePath $name
      if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
      $item = Get-Item -LiteralPath $candidate
      if (-not $item.FullName.StartsWith($root.FullName + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Out-of-scope cache path.' }
      $links = @($item) + @(Get-ChildItem -LiteralPath $item.FullName -Recurse -Force)
      if ($links | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        Write-Warning "Linked cache skipped: $candidate"
        continue
      }
      if ($processes | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($item.FullName + '\', [StringComparison]::OrdinalIgnoreCase) }) {
        Write-Warning "Running executable cache skipped: $candidate"
        continue
      }
      $candidates += $item.FullName
    }
  }
}
foreach ($candidate in $candidates) {
  if ($PSCmdlet.ShouldProcess($candidate, 'Remove historical compiler cache')) {
    Remove-Item -LiteralPath $candidate -Recurse -Force
    if (Test-Path -LiteralPath $candidate) { throw "Cache removal incomplete: $candidate" }
    Write-Host "Removed historical compiler cache: $candidate"
  }
}
