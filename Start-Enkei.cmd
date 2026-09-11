@echo off
rem Keep this launcher ASCII-only: Windows cmd can run it from any extracted folder.
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "LOG=%CD%\enkei-startup-diagnostic.log"
> "%LOG%" echo [E000] Enkei bootstrap started.
echo.
echo [Enkei] Starting the local workspace...
echo [Enkei] First launch may install components and build the interface. Please keep this window open.
echo [Enkei] Chinese, Japanese, and English can be selected in the browser.
echo.
set "NEED_SETUP="
if not exist "%~dp0ai-terminal\.venv\Scripts\python.exe" set "NEED_SETUP=1"
if not exist "%~dp0decision-service\.venv\Scripts\python.exe" set "NEED_SETUP=1"
if exist "%~dp0ai-terminal\.venv\Scripts\python.exe" "%~dp0ai-terminal\.venv\Scripts\python.exe" -c "import fastapi,uvicorn,httpx,pydantic" >nul 2>nul
if errorlevel 1 set "NEED_SETUP=1"
if exist "%~dp0decision-service\.venv\Scripts\python.exe" "%~dp0decision-service\.venv\Scripts\python.exe" -c "import fastapi,uvicorn,pydantic" >nul 2>nul
if errorlevel 1 set "NEED_SETUP=1"
if defined NEED_SETUP (
  echo [Enkei] First-run components are missing. Starting automatic setup...
  PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\Setup-Enkei.ps1" -InstallFallbackModel -NoLaunch
  if errorlevel 1 goto :SETUP_FAILED
  echo [Enkei] Setup completed. Starting Enkei...
  echo.
)
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto :NODE_MISSING
"%NODE_EXE%" "%~dp0launcher\local-launcher.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto :END
echo.
echo [Enkei] Startup did not finish. Opening the diagnostic file...
notepad "%LOG%"
echo.
pause
goto :END

:NODE_MISSING
>> "%LOG%" echo [E100] Node.js was not found in PATH or standard install locations.
echo.
echo [Enkei] Node.js was not found. Opening the diagnostic file...
notepad "%LOG%"
echo.
pause
set "EXIT_CODE=1"
goto :END

:SETUP_FAILED
echo.
echo [Enkei] Automatic setup did not finish. Opening the setup report...
if exist "%~dp0.enkei-setup\first-run-report.json" notepad "%~dp0.enkei-setup\first-run-report.json"
echo.
pause
set "EXIT_CODE=1"

:END
endlocal & exit /b %EXIT_CODE%
