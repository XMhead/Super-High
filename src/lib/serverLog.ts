export function buildServerLogGbkHelperCommand(tailLines = 50): string {
  const tail = Number.isFinite(tailLines)
    ? Math.max(1, Math.min(Math.trunc(tailLines), 2000))
    : 50

  // Single-line PowerShell keeps paste/submit reliable in the embedded local PTY.
  // Prefer a Minecraft server root (server.properties / spigot jar) over client-side
  // plugins/logs when the workspace is opened at .../plugins.
  return [
    'function Get-ServerLog {',
    'param([int]$Tail = 50);',
    "$roots = @((Get-Location).Path, (Split-Path -Path (Get-Location).Path -Parent)) | Where-Object { $_ -and $_.Trim() };",
    '$scored = foreach ($root in $roots) {',
    "$log = Join-Path -Path $root -ChildPath 'logs\\latest.log';",
    'if (-not (Test-Path -LiteralPath $log)) { continue };',
    "$score = 0;",
    "if (Test-Path -LiteralPath (Join-Path -Path $root -ChildPath 'server.properties')) { $score += 100 };",
    "if (Test-Path -LiteralPath (Join-Path -Path $root -ChildPath 'spigot-1.12.2.jar')) { $score += 50 };",
    "if (Test-Path -LiteralPath (Join-Path -Path $root -ChildPath 'spigot.yml')) { $score += 20 };",
    "if ((Split-Path -Path $root -Leaf) -ieq 'plugins') { $score -= 80 };",
    '[pscustomobject]@{ Log = $log; Score = $score; Root = $root }',
    '};',
    '$pick = $scored | Sort-Object -Property Score -Descending | Select-Object -First 1;',
    "if (-not $pick) { Write-Host '未找到服务端 logs/latest.log（请先 cd 到服务端目录或其 plugins 目录）' -ForegroundColor Yellow; return };",
    'Write-Host ("读取: $($pick.Log)  [GBK/CP936]  Tail=$Tail  root=$($pick.Root) score=$($pick.Score)") -ForegroundColor Cyan;',
    'Get-Content -LiteralPath $pick.Log -Tail $Tail -Encoding ([System.Text.Encoding]::GetEncoding(936))',
    '};',
    `Get-ServerLog -Tail ${tail}`,
  ].join(' ')
}

export function buildServerLogGbkTailCommand(tailLines = 50): string {
  return buildServerLogGbkHelperCommand(tailLines)
}
