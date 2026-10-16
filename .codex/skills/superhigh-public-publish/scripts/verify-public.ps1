[CmdletBinding()]
param(
  [string]$Path = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$skillRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $skillRoot 'references/private-manifest.json') | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($Path).TrimEnd('\')

$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

$hasRg = [bool](Get-Command rg -ErrorAction SilentlyContinue)
$scanTargets = @('-g', '!.git', '-g', '!.git/**', '-g', '!node_modules/**', '-g', '!dist/**', '-g', '!src-tauri/target*/**', '-g', '!logs/**', $root)

$publishedManifestPath = Join-Path $root '.codex/skills/superhigh-public-publish/references/private-manifest.json'
$publishedManifestText = ''
foreach ($pattern in @($manifest.scan.hardFail) + @($manifest.scan.warn)) {
  if ($pattern -isnot [string]) { throw '扫描规则必须是正则表达式字符串。' }
  [regex]::new($pattern) | Out-Null
}
if (Test-Path -LiteralPath $publishedManifestPath) {
  $publishedManifest = Get-Content -LiteralPath $publishedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($group in @('hardFail', 'warn')) {
    foreach ($pattern in @($publishedManifest.scan.$group)) {
      if ($pattern -isnot [string]) { throw '公开扫描规则必须是正则表达式字符串。' }
      [regex]::new($pattern) | Out-Null
    }
    $publishedManifest.scan.PSObject.Properties.Remove($group)
  }
  # 规则数组是检测表达式；清单其余字段仍按普通内容检查。
  $publishedManifestText = $publishedManifest | ConvertTo-Json -Depth 100
}

function Find-ContentHits {
  param([string]$Pattern)
  if ($hasRg) {
    $hits = @(& rg -l -i --hidden @scanTargets -e $Pattern 2>$null)
    if ($LASTEXITCODE -gt 1) { throw "内容扫描失败：$Pattern" }
  } else {
    $hits = @(Select-String -LiteralPath $allFiles -Pattern $Pattern -List | ForEach-Object { $_.Path })
  }
  $hits | Where-Object { $_ -and [IO.Path]::GetFullPath($_) -ne $publishedManifestPath }
  if ($publishedManifestText -match $Pattern) { $publishedManifestPath }
}

# 1) 路径级检查：排除项不得残留，路径不得含敏感关键词（rg 不会跟随 node_modules 软链）
if ($hasRg) {
  $allFiles = & rg --files --hidden -g '!.git' -g '!.git/**' -g '!node_modules/**' -g '!dist/**' -g '!src-tauri/target*/**' -g '!logs/**' $root 2>$null
} else {
  $allFiles = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.git\\|\\node_modules\\' } |
    ForEach-Object { $_.FullName }
}
foreach ($file in @($allFiles)) {
  if (-not $file) { continue }
  $rel = $file.Substring($root.Length).TrimStart('\').Replace('\', '/')
  foreach ($excluded in $manifest.excludedPaths) {
    $excludedNorm = $excluded.Replace('\', '/')
    if ($rel -ieq $excludedNorm -or $rel.StartsWith("$excludedNorm/", [StringComparison]::OrdinalIgnoreCase)) {
      $failures.Add("排除路径仍然存在: $rel")
    }
  }
  if ($rel -match '(?i)(vitepress-docs|sample-plugins|storage[-_]?(report|analysis))') {
    $failures.Add("可疑路径: $rel")
  }
}

# 2) 内容级检查：硬失败规则
foreach ($pattern in $manifest.scan.hardFail) {
  $hits = @(Find-ContentHits -Pattern $pattern)
  foreach ($hit in @($hits)) {
    if ($hit) {
      $rel = $hit.Substring($root.Length).TrimStart('\')
      $failures.Add("命中硬失败规则 [$pattern]: $rel")
    }
  }
}

# 3) 内容级检查：警告规则（供人工/AI 复核）
foreach ($pattern in $manifest.scan.warn) {
  $hits = @(Find-ContentHits -Pattern $pattern)
  foreach ($hit in @($hits)) {
    if ($hit) {
      $rel = $hit.Substring($root.Length).TrimStart('\')
      $warnings.Add("命中警告规则 [$pattern]: $rel")
    }
  }
}

foreach ($warning in $warnings) {
  Write-Host "[WARN] $warning" -ForegroundColor Yellow
}
if ($failures.Count -gt 0) {
  foreach ($failure in ($failures | Sort-Object -Unique)) {
    Write-Host "[FAIL] $failure" -ForegroundColor Red
  }
  Write-Host "敏感扫描未通过：$($failures.Count) 处问题。" -ForegroundColor Red
  exit 1
}

Write-Host "敏感扫描通过：无硬失败命中（$($warnings.Count) 条警告待人工复核）。" -ForegroundColor Green
exit 0
