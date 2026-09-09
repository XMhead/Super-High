@echo off
setlocal

set "SUPERHIGH_DSH=%~dp0node_modules\.bin\dsh.cmd"
if not exist "%SUPERHIGH_DSH%" (
  echo [Super High] repo-local dsh is missing: "%SUPERHIGH_DSH%" 1>&2
  exit /b 1
)

if "%~1"=="" (
  call "%SUPERHIGH_DSH%" --profile dsh-tui
) else (
  call "%SUPERHIGH_DSH%" %*
)

set "SUPERHIGH_DSH_EXIT=%ERRORLEVEL%"
endlocal & exit /b %SUPERHIGH_DSH_EXIT%
