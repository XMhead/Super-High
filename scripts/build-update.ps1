[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$keyPath = Join-Path $env:USERPROFILE '.tauri/super-high-updater.key'
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
  throw "Update signing key is missing: $keyPath"
}
$previousKey = $env:TAURI_SIGNING_PRIVATE_KEY
Push-Location $repoRoot
try {
  node scripts/check-update-release.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Update release configuration is invalid.' }
  $env:TAURI_SIGNING_PRIVATE_KEY = $keyPath
  npm run tauri:build -- --bundles nsis --ci
  if ($LASTEXITCODE -ne 0) { throw 'Signed update build failed.' }
} finally {
  $env:TAURI_SIGNING_PRIVATE_KEY = $previousKey
  Pop-Location
}
