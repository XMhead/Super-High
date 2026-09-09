# Super High Remote SMB Setup
# 在远程服务器上运行此脚本（右键 → 以管理员身份运行 PowerShell）
# 作用：开启文件共享，把指定文件夹共享出来

$ErrorActionPreference = "Stop"
Write-Host "=== Super High 远程共享配置 ===" -ForegroundColor Cyan

# ── 配置区（按你的实际环境修改）──
$ShareFolder = "E:\server\plugins"
$ShareName = "SuperHighShare"
$UserName = "admin"

# ── 1. 检查文件夹是否存在 ──
Write-Host "`n[1/4] 检查文件夹..." -ForegroundColor Yellow
if (-not (Test-Path -Path $ShareFolder -PathType Container)) {
    Write-Host "错误：文件夹不存在 - $ShareFolder" -ForegroundColor Red
    Write-Host "请修改脚本里的 `$ShareFolder 为正确的路径"
    pause
    exit 1
}
Write-Host "  ✓ 文件夹存在: $ShareFolder" -ForegroundColor Green

# ── 2. 启用文件共享功能 ──
Write-Host "`n[2/4] 启用文件共享..." -ForegroundColor Yellow
try {
    # Enable File and Printer Sharing firewall rules
    netsh advfirewall firewall set rule group="文件和打印机共享" new enable=yes 2>$null
    # Enable SMB-In firewall rules
    Enable-NetFirewallRule -Name "FPS-SMB-In-TCP" -ErrorAction SilentlyContinue
    Write-Host "  ✓ 防火墙已配置" -ForegroundColor Green
} catch {
    Write-Host "  ! 防火墙配置跳过（可能已配置）" -ForegroundColor Yellow
}

# ── 3. 确保 SMB 服务运行 ──
Write-Host "`n[3/4] 检查 SMB 服务..." -ForegroundColor Yellow
$smbService = Get-Service -Name "LanmanServer" -ErrorAction SilentlyContinue
if ($smbService.Status -ne "Running") {
    Write-Host "  正在启动 SMB 服务..."
    Start-Service -Name "LanmanServer"
    Start-Sleep -Seconds 2
}
Write-Host "  ✓ SMB 服务运行中" -ForegroundColor Green

# ── 4. 创建共享 ──
Write-Host "`n[4/4] 创建共享: \\$(hostname)\$ShareName" -ForegroundColor Yellow

# 先删除旧共享（如果存在）
net share $ShareName /delete 2>$null

# 创建新共享，授予管理员完全控制
net share $ShareName="$ShareFolder" /grant:$UserName,FULL /remark:"Super High Remote Workspace" 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ 共享创建成功!" -ForegroundColor Green
    Write-Host ""
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host "  共享路径: \\$(hostname)\$ShareName" -ForegroundColor White
    Write-Host "  或在 Tailscale 下: \\<Tailscale IP>\$ShareName" -ForegroundColor White
    Write-Host "  共享名: $ShareName" -ForegroundColor White
    Write-Host "  用户: $UserName" -ForegroundColor White
    Write-Host "==============================================" -ForegroundColor Cyan
} else {
    Write-Host "  ✗ 共享创建失败！请检查权限" -ForegroundColor Red
}

Write-Host ""
Write-Host "现在去 Super High → 设置 → 远程端，填入:" -ForegroundColor Cyan
Write-Host "  远程主机: <你在 Tailscale 里看到的远程 IP>" -ForegroundColor White
Write-Host "  共享名: $ShareName" -ForegroundColor White
Write-Host "  用户名: $UserName" -ForegroundColor White
Write-Host "  远程子目录: 留空（共享已经是 plugins 目录了）" -ForegroundColor White

pause
