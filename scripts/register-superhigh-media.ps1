#Requires -Version 5.1
<#
.SYNOPSIS
  为当前用户注册 Super High 图片、视频和文档查看器，并把 release 目录加入用户 PATH。

.DESCRIPTION
  不修改 Windows 11 受保护的 UserChoice。Windows 11 当前版本要求在“设置 > 应用 > 默认应用”
  页面确认默认程序；旧“打开方式”窗口中的“始终”可能只显示系统提示而不保存。

.PARAMETER ExePath
  super-high.exe 的绝对路径。默认使用本仓库 src-tauri\target\release\super-high.exe。

.PARAMETER OpenSettings
  注册完成后打开 Windows 11 的 Super High 默认应用设置页。
#>
param(
  [string]$ExePath = "",
  [switch]$OpenSettings
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
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
  throw "找不到可执行文件：$ExePath`n请先运行：npm run tauri:build"
}
$ExePath = (Resolve-Path -LiteralPath $ExePath).Path
$releaseDir = Split-Path -Parent $ExePath
$applicationName = "Super High"
$applicationExeName = "super-high.exe"
$applicationKey = "HKCU:\Software\Classes\Applications\$applicationExeName"
$capabilitiesKey = "HKCU:\Software\SuperHigh\Capabilities"
$registeredApplicationsKey = "HKCU:\Software\RegisteredApplications"
$imageProgId = "SuperHigh.Media"
$videoProgId = "SuperHigh.Video"
$wordProgId = "SuperHigh.Word"
$pdfProgId = "SuperHigh.Pdf"
$imageExtensions = @(".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif")
$videoExtensions = @(".mp4", ".webm", ".ogg", ".ogv", ".mov")
$wordExtensions = @(".doc", ".docx")
$pdfExtensions = @(".pdf")
$iconValue = '"' + $ExePath + '",0'
$mediaOpenCommand = '"' + $ExePath + '" --media-viewer "%1"'

function Ensure-RegistryKey([string]$RegistryPath) {
  if (-not (Test-Path -LiteralPath $RegistryPath)) {
    New-Item -Path $RegistryPath -Force | Out-Null
  }
}

function Remove-AssociationCreateSubKeyDeny([string]$Extension) {
  # Some image extensions on this machine had an extra Everyone/CreateSubKey
  # deny rule. It prevents Windows Settings from creating UserChoice; remove
  # only that non-inherited rule and leave the protected UserChoice key alone.
  $subKeyPath = "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$Extension"
  $key = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
      $subKeyPath,
      [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
      [System.Security.AccessControl.RegistryRights]::ChangePermissions
    )
    if ($null -eq $key) {
      return
    }
    $security = $key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
    $changed = $false
    foreach ($rule in @($security.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
      if ($rule.IdentityReference.Value -eq "S-1-1-0" -and
          $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and
          (($rule.RegistryRights -band [System.Security.AccessControl.RegistryRights]::CreateSubKey) -ne 0)) {
        $security.RemoveAccessRuleSpecific($rule)
        $changed = $true
      }
    }
    if ($changed) {
      $key.SetAccessControl($security)
    }
  } catch {
    Write-Warning "Could not update association ACL for $Extension`: $($_.Exception.Message)"
  } finally {
    if ($null -ne $key) {
      $key.Close()
    }
  }
}

function Register-ProgId([string]$ProgId, [string]$Description) {
  $progIdKey = "HKCU:\Software\Classes\$ProgId"
  Ensure-RegistryKey $progIdKey
  Set-ItemProperty -LiteralPath $progIdKey -Name "(default)" -Value $Description
  Set-ItemProperty -LiteralPath $progIdKey -Name "FriendlyTypeName" -Value $Description
  Ensure-RegistryKey "$progIdKey\DefaultIcon"
  Set-ItemProperty -LiteralPath "$progIdKey\DefaultIcon" -Name "(default)" -Value $iconValue
  Ensure-RegistryKey "$progIdKey\shell\open\command"
  Set-ItemProperty -LiteralPath "$progIdKey\shell\open\command" -Name "(default)" -Value $mediaOpenCommand
}

function Register-Extension([string]$Extension, [string]$ProgId) {
  Remove-AssociationCreateSubKeyDeny $Extension
  $openWithKey = "HKCU:\Software\Classes\$Extension\OpenWithProgids"
  Ensure-RegistryKey $openWithKey
  # Windows 11 expects OpenWithProgids entries as empty REG_NONE values.
  Remove-ItemProperty -LiteralPath $openWithKey -Name $ProgId -Force -ErrorAction SilentlyContinue
  New-ItemProperty -LiteralPath $openWithKey -Name $ProgId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null

  $openWithListKey = "HKCU:\Software\Classes\$Extension\OpenWithList"
  Ensure-RegistryKey $openWithListKey
  # OpenWithList stores executable names as child keys, not string values.
  Remove-ItemProperty -LiteralPath $openWithListKey -Name $applicationExeName -Force -ErrorAction SilentlyContinue
  Ensure-RegistryKey "$openWithListKey\$applicationExeName"

  $supportedTypesKey = "$applicationKey\SupportedTypes"
  Ensure-RegistryKey $supportedTypesKey
  New-ItemProperty -LiteralPath $supportedTypesKey -Name $Extension -PropertyType String -Value "" -Force | Out-Null

  $associationsKey = "$capabilitiesKey\FileAssociations"
  Ensure-RegistryKey $associationsKey
  New-ItemProperty -LiteralPath $associationsKey -Name $Extension -PropertyType String -Value $ProgId -Force | Out-Null
}

Register-ProgId $imageProgId "Super High Image"
Register-ProgId $videoProgId "Super High Video"
Register-ProgId $wordProgId "Super High Word Document"
Register-ProgId $pdfProgId "Super High PDF Document"

Ensure-RegistryKey $applicationKey
Set-ItemProperty -LiteralPath $applicationKey -Name "FriendlyAppName" -Value $applicationName
Ensure-RegistryKey "$applicationKey\DefaultIcon"
Set-ItemProperty -LiteralPath "$applicationKey\DefaultIcon" -Name "(default)" -Value $iconValue
Ensure-RegistryKey "$applicationKey\shell\open\command"
Set-ItemProperty -LiteralPath "$applicationKey\shell\open\command" -Name "(default)" -Value $mediaOpenCommand

Ensure-RegistryKey $capabilitiesKey
Set-ItemProperty -LiteralPath $capabilitiesKey -Name "ApplicationName" -Value $applicationName
Set-ItemProperty -LiteralPath $capabilitiesKey -Name "ApplicationDescription" -Value "Super High image, video and document viewer"
Ensure-RegistryKey $registeredApplicationsKey
New-ItemProperty -LiteralPath $registeredApplicationsKey -Name $applicationName -PropertyType String -Value "Software\SuperHigh\Capabilities" -Force | Out-Null

foreach ($extension in $imageExtensions) {
  Register-Extension $extension $imageProgId
}
foreach ($extension in $videoExtensions) {
  Register-Extension $extension $videoProgId
}
foreach ($extension in $wordExtensions) {
  Register-Extension $extension $wordProgId
}
foreach ($extension in $pdfExtensions) {
  Register-Extension $extension $pdfProgId
}

$notifyMember = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);'
Add-Type -Namespace SuperHigh -Name AssociationNotifier -MemberDefinition $notifyMember -ErrorAction SilentlyContinue
[SuperHigh.AssociationNotifier]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$releaseDirKey = $releaseDir.TrimEnd("\")
$pathAlreadyPresent = $false
foreach ($entry in $pathEntries) {
  if ($entry.Trim().TrimEnd("\") -ieq $releaseDirKey) {
    $pathAlreadyPresent = $true
    break
  }
}
if (-not $pathAlreadyPresent) {
  $nextUserPath = (@($pathEntries) + $releaseDir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $nextUserPath, "User")
}

Write-Host "Registered Super High image/video/document viewer for the current user."
Write-Host "Executable: $ExePath"
Write-Host "Windows 11: use Settings > Apps > Default apps to persist defaults."
Write-Host "The Open With dialog cannot persist defaults on this build."
Write-Host "Use: powershell -ExecutionPolicy Bypass -File scripts\register-superhigh-media.ps1 -OpenSettings"
if ($OpenSettings) {
  Start-Process -FilePath "explorer.exe" -ArgumentList "ms-settings:defaultapps?registeredAppUser=Super%20High"
}
Write-Host "Unregister: scripts\unregister-superhigh-media.ps1"
