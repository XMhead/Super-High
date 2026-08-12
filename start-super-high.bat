@echo off
setlocal

cd /d "%~dp0"

set "APP_EXE=src-tauri\target\release\super-high.exe"
set "APP_LOG_DIR=logs"
set "APP_STDOUT=%APP_LOG_DIR%\super-high-release.stdout.log"
set "APP_STDERR=%APP_LOG_DIR%\super-high-release.stderr.log"

if /I "%1"=="dev" goto run_dev
goto run_release

:run_dev
echo [Super High] Starting development mode...
call :ensure_node_dependencies
if errorlevel 1 goto fail

call npm run tauri:dev
if errorlevel 1 goto fail
goto end

:run_release
echo [Super High] Starting built application...
call :cleanup_stale_dev_servers
if not exist "%APP_EXE%" goto build_release

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe = Get-Item -LiteralPath '%APP_EXE%' -ErrorAction SilentlyContinue; " ^
  "if (-not $exe) { exit 1 }; " ^
  "$bundle = Get-ChildItem -LiteralPath 'src-tauri\target\release\bundle\nsis' -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; " ^
  "if (-not $bundle -or $bundle.LastWriteTime.AddSeconds(5) -lt $exe.LastWriteTime) { exit 2 }; " ^
  "$sourceRoots = @('src','public','src-tauri\src','src-tauri\capabilities','src-tauri\icons') | Where-Object { Test-Path -LiteralPath $_ }; " ^
  "$rootFiles = Get-Item -LiteralPath 'package.json','package-lock.json','vite.config.ts','tsconfig.json','tsconfig.app.json','tsconfig.node.json','index.html','src-tauri\Cargo.toml','src-tauri\Cargo.lock','src-tauri\tauri.conf.json','src-tauri\build.rs' -ErrorAction SilentlyContinue; " ^
  "$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoots -Recurse -File -ErrorAction SilentlyContinue) + @($rootFiles); " ^
  "$sources = $sourceFiles | Where-Object { $_.LastWriteTime -gt $exe.LastWriteTime } | Select-Object -First 1; " ^
  "if ($sources) { exit 2 } else { exit 0 }"
if errorlevel 2 goto build_release
if errorlevel 1 goto build_release
goto start_release

:build_release
echo [Super High] Release executable is missing or outdated. Building first...
call :ensure_node_dependencies
if errorlevel 1 goto fail
call npm run tauri:build
if errorlevel 1 goto fail
goto start_release

:ensure_node_dependencies
if exist "node_modules\.bin\tauri.cmd" exit /b 0
echo [Super High] npm command links are missing. Installing dependencies...
call npm install --include=dev
if errorlevel 1 exit /b 1
if not exist "node_modules\.bin\tauri.cmd" (
  echo [Super High] Tauri CLI is still missing after npm install.
  exit /b 1
)
exit /b 0

:start_release
if not exist "%APP_LOG_DIR%" mkdir "%APP_LOG_DIR%"
del /q "%APP_STDOUT%" "%APP_STDERR%" >nul 2>nul
set "SUPER_HIGH_ARGS=%*"
set "RUST_BACKTRACE=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$startInfo = @{ FilePath = '%APP_EXE%'; WorkingDirectory = (Get-Location); RedirectStandardOutput = '%APP_STDOUT%'; RedirectStandardError = '%APP_STDERR%'; PassThru = $true }; " ^
  "if ($env:SUPER_HIGH_ARGS) { $startInfo.ArgumentList = $env:SUPER_HIGH_ARGS }; " ^
  "$process = Start-Process @startInfo; " ^
  "Start-Sleep -Seconds 5; " ^
  "if ($process.HasExited) { Write-Host ('[Super High] Process exited with code ' + $process.ExitCode); exit 1 } else { exit 0 }"
if errorlevel 1 goto release_failed
goto end

:cleanup_stale_dev_servers
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue'; " ^
  "$root = (Resolve-Path -LiteralPath '.').Path.TrimEnd('\'); " ^
  "$all = @(Get-CimInstance Win32_Process); " ^
  "$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }; " ^
  "function Test-RootViteProcess { param($p) if (-not $p.CommandLine) { return $false }; $cmd = $p.CommandLine; $exe = $p.ExecutablePath; if ($p.Name -eq 'node.exe' -and $cmd.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $cmd -match 'node_modules.*vite.*bin.*vite\.js') { return $true }; if ($p.Name -eq 'esbuild.exe' -and $exe -and $exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }; return $false }; " ^
  "function Test-DevWrapper { param($p) if (-not $p.CommandLine) { return $false }; $cmd = $p.CommandLine; return ($p.Name -in @('cmd.exe','node.exe') -and ($cmd -match 'npm(?:-cli\.js|\.cmd).*run dev' -or $cmd -match '\bvite(?:\.cmd)?\b.*--host\s+127\.0\.0\.1.*--port\s+\d+')) }; " ^
  "$ids = [System.Collections.Generic.HashSet[int]]::new(); " ^
  "foreach ($candidate in @($all | Where-Object { Test-RootViteProcess $_ })) { $p = $candidate; $first = $true; while ($p) { if ($p.ProcessId -eq $PID) { break }; if (-not $first -and -not (Test-DevWrapper $p)) { break }; [void]$ids.Add([int]$p.ProcessId); $first = $false; if (-not $byId.ContainsKey([int]$p.ParentProcessId)) { break }; $p = $byId[[int]$p.ParentProcessId] } }; " ^
  "foreach ($id in @($ids)) { $p = $byId[$id]; if ($p -and $p.Name -ne 'super-high.exe') { Stop-Process -Id $id -Force } }; " ^
  "if ($ids.Count -gt 0) { Write-Host ('[Super High] Cleaned stale Vite dev process(es): ' + $ids.Count) }; " ^
  "exit 0"
exit /b 0

:release_failed
echo.
echo [Super High] Application exited during startup.
if exist "%APP_STDERR%" type "%APP_STDERR%"
if exist "%APP_STDOUT%" type "%APP_STDOUT%"
goto fail

:fail
echo.
echo [Super High] Startup failed.
pause
exit /b 1

:end
endlocal
