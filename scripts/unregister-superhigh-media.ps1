#Requires -Version 5.1
<#
.SYNOPSIS
  撤销 register-superhigh-media.ps1 写入的当前用户注册表项与 PATH 目录。

.PARAMETER ExePath
  用于确定应从用户 PATH 移除的 release 目录。默认使用本仓库 release 路径。
#>
param(
  [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repoRoot = Split-Path -Parent $scriptDir
if ([string]::IsNullOrWhiteSpace($ExePath)) {
  $ExePath = Join-Path $repoRoot "src-tauri\target\release\super-high.exe"
}
$ExePath = [IO.Path]::GetFullPath($ExePath)
$releaseDirKey = (Split-Path -Parent $ExePath).TrimEnd("\")
$applicationName = "Super High"
$imageProgId = "SuperHigh.Media"
$videoProgId = "SuperHigh.Video"
$wordProgId = "SuperHigh.Word"
$pdfProgId = "SuperHigh.Pdf"
$imageExtensions = @(".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif")
$videoExtensions = @(".mp4", ".webm", ".ogg", ".ogv", ".mov")
$documentExtensions = @(".doc", ".docx", ".pdf")

foreach ($extension in @($imageExtensions + $videoExtensions + $documentExtensions)) {
  $openWithKey = "HKCU:\Software\Classes\$Extension\OpenWithProgids"
  if (Test-Path -LiteralPath $openWithKey) {
    Remove-ItemProperty -LiteralPath $openWithKey -Name $imageProgId -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath $openWithKey -Name $videoProgId -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath $openWithKey -Name $wordProgId -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath $openWithKey -Name $pdfProgId -Force -ErrorAction SilentlyContinue
  }
  $openWithListKey = "HKCU:\Software\Classes\$Extension\OpenWithList"
  if (Test-Path -LiteralPath $openWithListKey) {
    Remove-ItemProperty -LiteralPath $openWithListKey -Name "super-high.exe" -Force -ErrorAction SilentlyContinue
    $applicationOpenWithKey = "$openWithListKey\super-high.exe"
    if (Test-Path -LiteralPath $applicationOpenWithKey) {
      Remove-Item -LiteralPath $applicationOpenWithKey -Recurse -Force
    }
  }
}

$registeredApplicationsKey = "HKCU:\Software\RegisteredApplications"
if (Test-Path -LiteralPath $registeredApplicationsKey) {
  Remove-ItemProperty -LiteralPath $registeredApplicationsKey -Name $applicationName -Force -ErrorAction SilentlyContinue
}

$keysToRemove = @(
  "HKCU:\Software\Classes\$imageProgId",
  "HKCU:\Software\Classes\$videoProgId",
  "HKCU:\Software\Classes\$wordProgId",
  "HKCU:\Software\Classes\$pdfProgId",
  "HKCU:\Software\Classes\Applications\super-high.exe",
  "HKCU:\Software\SuperHigh\Capabilities"
)
foreach ($registryKey in $keysToRemove) {
  if (Test-Path -LiteralPath $registryKey) {
    Remove-Item -LiteralPath $registryKey -Recurse -Force
  }
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$remainingEntries = @()
foreach ($entry in @($userPath -split ";")) {
  if ([string]::IsNullOrWhiteSpace($entry)) {
    continue
  }
  if ($entry.Trim().TrimEnd("\") -ine $releaseDirKey) {
    $remainingEntries += $entry.Trim()
  }
}
[Environment]::SetEnvironmentVariable("Path", ($remainingEntries -join ";"), "User")

$notifyMember = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);'
Add-Type -Namespace SuperHigh -Name AssociationNotifier -MemberDefinition $notifyMember -ErrorAction SilentlyContinue
[SuperHigh.AssociationNotifier]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host "Unregistered Super High image/video/document viewer and removed its PATH entry."
