#Requires -Version 5.1
<#
.SYNOPSIS
  移除 register-windows-shell-menu.ps1 写入的 Super High 右键项。
#>
$ErrorActionPreference = "Stop"
$verbName = "OpenWithSuperHigh"
$paths = @(
  "HKCU:\Software\Classes\Directory\shell\$verbName",
  "HKCU:\Software\Classes\Directory\Background\shell\$verbName",
  "HKCU:\Software\Classes\*\shell\$verbName"
)
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Recurse -Force
    Write-Host "已删除：$p"
  }
}
Write-Host "完成。"
