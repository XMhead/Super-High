@echo off
setlocal
cd /d "%~dp0.."
node scripts\create-dragon-icon-template.mjs 32
pause
