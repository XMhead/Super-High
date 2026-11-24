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
# 进程映像路径在 EXE 改名后可能仍指向原部署位置；Restart Manager 检查实际文件。
if (-not ('SuperHigh.IntegrationLocks' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace SuperHigh {
  public static class IntegrationLocks {
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, IntPtr processes, ref uint reboot);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
    public static bool InUse(string[] paths) {
      if (paths.Length == 0) return false;
      uint session; var key = new StringBuilder(33);
      int code = RmStartSession(out session, 0, key);
      if (code != 0) throw new InvalidOperationException("RmStartSession: " + code);
      try {
        code = RmRegisterResources(session, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, IntPtr.Zero);
        if (code != 0) throw new InvalidOperationException("RmRegisterResources: " + code);
        uint needed, count = 0, reboot = 0;
        code = RmGetList(session, out needed, ref count, IntPtr.Zero, ref reboot);
        if (code != 0 && code != 234) throw new InvalidOperationException("RmGetList: " + code);
        return needed > 0;
      } finally { RmEndSession(session); }
    }
  }
}
'@
}
$running = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath)
foreach ($run in $runs[0..($runs.Count - $Keep - 1)]) {
  if ($run.Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Warning "Linked run skipped: $($run.FullName)"; continue }
  if ($running | Where-Object { $_.StartsWith($run.FullName + '\', [StringComparison]::OrdinalIgnoreCase) }) {
    Write-Warning "Run in use skipped: $($run.FullName)"
    continue
  }
  try {
    $entries = @(Get-ChildItem -LiteralPath $run.FullName -Recurse -Force)
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Linked entry' }
    $executables = @($entries | Where-Object { -not $_.PSIsContainer -and $_.Extension -ieq '.exe' } | ForEach-Object FullName)
    if ([SuperHigh.IntegrationLocks]::InUse([string[]]$executables)) {
      Write-Warning "Run in use skipped: $($run.FullName)"
      continue
    }
    if ($PSCmdlet.ShouldProcess($run.FullName, 'Remove old integrate run')) {
      Remove-Item -LiteralPath $run.FullName -Recurse -Force
      if (Test-Path -LiteralPath $run.FullName) { throw 'Run removal incomplete' }
    }
  } catch {
    Write-Warning "Run cleanup failed: $($run.FullName): $($_.Exception.Message)"
  }
}
