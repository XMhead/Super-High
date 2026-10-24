$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = [Microsoft.Win32.Registry]::CurrentUser
$extensions = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif')
$progId = 'SuperHigh.ImageViewer'
$legacyId = 'SuperHigh.Media'
$classes = 'Software\Classes'
$machineRegistered = $false
foreach ($ext in $extensions) {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("$classes\$ext\OpenWithProgids")
    if ($null -ne $key) {
        try {
            if (@($key.GetValueNames() | Where-Object { $_ -in @($progId, $legacyId) }).Count -gt 0) { $machineRegistered = $true }
        } finally { $key.Dispose() }
    }
}
if ($env:SUPERHIGH_VIEWER_ACTION -eq 'disable' -and $machineRegistered) {
    throw '旧版 Super High 已为所有用户注册图片查看器，请先卸载该旧版安装，再关闭此开关。'
}
function Read-Value($path, $name) {
    $key = $root.OpenSubKey($path)
    if ($null -eq $key) { return $null }
    try { return $key.GetValue($name) } finally { $key.Dispose() }
}
function Set-Value($path, $name, $value, $kind = [Microsoft.Win32.RegistryValueKind]::String) {
    $key = $root.CreateSubKey($path)
    try { $key.SetValue($name, $value, $kind) } finally { $key.Dispose() }
}
function Remove-Value($path, $name) {
    $key = $root.OpenSubKey($path, $true)
    if ($null -ne $key) { try { $key.DeleteValue($name, $false) } finally { $key.Dispose() } }
}
function Has-Value($path, $name) {
    $key = $root.OpenSubKey($path)
    if ($null -eq $key) { return $false }
    try { return $key.GetValueNames() -contains $name } finally { $key.Dispose() }
}
$defaultSelected = $false
foreach ($ext in $extensions) {
    $selected = Read-Value "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice" 'ProgId'
    $fallback = Read-Value "$classes\$ext" ''
    $effective = if ([string]::IsNullOrEmpty($selected)) { $fallback } else { $selected }
    if ($effective -in @($progId, $legacyId, 'Applications\super-high.exe')) { $defaultSelected = $true }
}
if ($env:SUPERHIGH_VIEWER_ACTION -eq 'enable') {
    Set-Value "$classes\$progId" '' 'Super High Image Viewer'
    Set-Value "$classes\$progId\DefaultIcon" '' ('"' + $env:SUPERHIGH_VIEWER_EXE + '",0')
    Set-Value "$classes\$progId\shell\open\command" '' ('"' + $env:SUPERHIGH_VIEWER_EXE + '" --media-viewer "%1"')
    foreach ($ext in $extensions) {
        Set-Value "$classes\$ext\OpenWithProgids" $progId ([byte[]]@()) ([Microsoft.Win32.RegistryValueKind]::None)
    }
} elseif ($env:SUPERHIGH_VIEWER_ACTION -eq 'disable') {
    foreach ($ext in $extensions) {
        foreach ($id in @($progId, $legacyId)) { Remove-Value "$classes\$ext\OpenWithProgids" $id }
        Remove-Value "$classes\Applications\super-high.exe\SupportedTypes" $ext
        if ((Read-Value 'Software\SuperHigh\Capabilities\FileAssociations' $ext) -in @($progId, $legacyId)) {
            Remove-Value 'Software\SuperHigh\Capabilities\FileAssociations' $ext
        }
        $root.DeleteSubKeyTree("$classes\$ext\OpenWithList\super-high.exe", $false)
    }
    # Retain command identities: an existing Windows default must continue working.
}
$enabled = $false
$legacy = $machineRegistered
foreach ($ext in $extensions) {
    if (Has-Value "$classes\$ext\OpenWithProgids" $progId) { $enabled = $true }
    if ((Has-Value "$classes\$ext\OpenWithProgids" $legacyId) -or
        (Has-Value "$classes\Applications\super-high.exe\SupportedTypes" $ext) -or
        (Read-Value 'Software\SuperHigh\Capabilities\FileAssociations' $ext) -eq $legacyId) { $legacy = $true }
}
if ($env:SUPERHIGH_VIEWER_ACTION -ne 'read') {
    Add-Type -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);' -Name 'ImageViewerShell' -Namespace 'SuperHigh'
    [SuperHigh.ImageViewerShell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
@{ supported = $true; enabled = ($enabled -or $legacy); legacyRegistered = $legacy; defaultSelected = $defaultSelected } | ConvertTo-Json -Compress
