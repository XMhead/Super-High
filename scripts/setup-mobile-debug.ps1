[CmdletBinding()]
param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'SuperHigh\android-tools'))
$ErrorActionPreference = 'Stop'
# Only the upstream Windows distribution; reused by the desktop's tool resolver.
$release = Invoke-RestMethod 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest'
$asset = @($release.assets | Where-Object name -Match '^scrcpy-win64-.*\.zip$')[0]
if (-not $asset) { throw 'Upstream scrcpy Windows archive not found' }
if ($asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Upstream archive SHA256 missing' }
$expected = $Matches[1]
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$archive = Join-Path $Destination $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'scrcpy SHA256 mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
$exe = Join-Path $Destination ($asset.name.Replace('.zip', '') + '\scrcpy.exe')
if (-not (Test-Path -LiteralPath $exe)) { throw 'scrcpy executable missing after extraction' }
Write-Output $exe
