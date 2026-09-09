@echo off
setlocal
cd /d "%~dp0.."
node scripts\export-dragon-image.mjs --all
