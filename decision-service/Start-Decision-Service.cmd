@echo off
rem 圆衡 Enkei 决策服务启动脚本（仅本机 127.0.0.1:8792）
chcp 65001 >nul
cd /d "%~dp0"
set PY=%~dp0.venv\Scripts\python.exe
if not exist "%PY%" (
  echo [ERROR] 未找到决策服务环境: %PY%
  echo [INFO] Please run the root "Start-Enkei.cmd" to complete automatic setup first.
  pause
  exit /b 1
)
echo [INFO] 启动决策服务 http://127.0.0.1:8792
"%PY%" -m uvicorn app:app --host 127.0.0.1 --port 8792
