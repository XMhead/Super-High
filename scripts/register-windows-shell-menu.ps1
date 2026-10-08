#Requires -Version 5.1
<#
.SYNOPSIS
  在「当前用户」下注册资源管理器右键：用 Super High 打开文件夹 / 当前目录 / 单个文件所在目录。

.DESCRIPTION
  写入 HKCU\Software\Classes\…（不需管理员）。请先构建 release：npm run tauri:build
  或使用 -ExePath 指向已有的 super-high.exe。

.PARAMETER ExePath
  super-high.exe 的绝对路径。默认：本仓库 src-tauri\target\release\super-high.exe
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
if (-not $ExePath) {
  $ExePath = Join-Path $repoRoot "src-tauri\target\release\super-high.exe"
}
$ExePath = (Resolve-Path -LiteralPath $ExePath).Path
if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Error "找不到可执行文件：$ExePath`n请先运行：npm run tauri:build"
}

$shellVerbKey = 'OpenWithSuperHigh'
$menuText = '通过 Super High 打开'
$icon = '"' + $ExePath + '",0'
$command = '"' + $ExePath + '" "%1"'
$commandBackground = '"' + $ExePath + '" "%V"'
function New-SuperHighRegKeyIfMissing([string]$regPath) {
  if ([string]::IsNullOrWhiteSpace($regPath)) {
    throw "New-SuperHighRegKeyIfMissing: path is empty"
  }
  if (-not (Test-Path -LiteralPath $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
  }
}

# 右键文件夹图标（路径一律内联 [string]::Format，避免个别环境下对特定变量名的赋值异常）
New-SuperHighRegKeyIfMissing -regPath ([string]::Format('HKCU:\Software\Classes\Directory\shell\{0}', $shellVerbKey))
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\Directory\shell\{0}', $shellVerbKey)) -Name '(default)' -Value $menuText
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\Directory\shell\{0}', $shellVerbKey)) -Name 'Icon' -Value $icon
New-SuperHighRegKeyIfMissing -regPath ([string]::Format('HKCU:\Software\Classes\Directory\shell\{0}\command', $shellVerbKey))
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\Directory\shell\{0}\command', $shellVerbKey)) -Name '(default)' -Value $command

# 在文件夹空白处右键：打开当前目录
New-SuperHighRegKeyIfMissing -regPath ([string]::Format('HKCU:\Software\Classes\Directory\Background\shell\{0}', $shellVerbKey))
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\Directory\Background\shell\{0}', $shellVerbKey)) -Name '(default)' -Value $menuText
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\Directory\Background\shell\{0}', $shellVerbKey)) -Name 'Icon' -Value $icon
New-SuperHighRegKeyIfMissing -regPath ([string]::Format('HKCU:\Software\Classes\Directory\Background\shell\{0}\command', $shellVerbKey))
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\Directory\Background\shell\{0}\command', $shellVerbKey)) -Name '(default)' -Value $commandBackground

# 右键单个文件：打开其所在文件夹作为工作区
New-SuperHighRegKeyIfMissing -regPath ([string]::Format('HKCU:\Software\Classes\*\shell\{0}', $shellVerbKey))
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\*\shell\{0}', $shellVerbKey)) -Name '(default)' -Value $menuText
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\*\shell\{0}', $shellVerbKey)) -Name 'Icon' -Value $icon
New-SuperHighRegKeyIfMissing -regPath ([string]::Format('HKCU:\Software\Classes\*\shell\{0}\command', $shellVerbKey))
Set-ItemProperty -LiteralPath ([string]::Format('HKCU:\Software\Classes\*\shell\{0}\command', $shellVerbKey)) -Name '(default)' -Value $command

Write-Host "已注册右键菜单（当前用户）。可执行文件：$ExePath"
Write-Host "卸载请运行：scripts\unregister-windows-shell-menu.ps1"
