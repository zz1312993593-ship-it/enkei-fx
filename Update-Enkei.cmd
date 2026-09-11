@echo off
setlocal
set "TARGET=%~1"
if not defined TARGET (
  echo Drag your existing Enkei folder onto this file, or run:
  echo Update-Enkei.cmd "D:\path\to\existing-Enkei"
  pause
  exit /b 2
)
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\Update-Enkei.ps1" -TargetRoot "%TARGET%"
if errorlevel 1 pause
endlocal
