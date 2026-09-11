@echo off
chcp 65001 >nul
title Enkei AI Terminal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 python，请先安装 Python 3.10+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [首次运行] 正在创建本地 Python 环境...
    python -m venv .venv
)

rem 每次启动均以虚拟环境自己的 Python 检查依赖；避免“环境存在但 uvicorn 未安装”直接退出。
".venv\Scripts\python.exe" -c "import fastapi,uvicorn,jsonschema,httpx" >nul 2>nul
if errorlevel 1 (
    echo [准备运行组件] 正在安装或补齐 AI 终端依赖，首次可能需要几分钟...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [错误] AI 终端依赖安装失败。请检查网络后重试。
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo   Enkei AI Terminal   http://127.0.0.1:8710
echo   Ollama: http://127.0.0.1:11434
echo   关闭本窗口即停止服务
echo ============================================
echo.
".venv\Scripts\python.exe" run_terminal.py
pause
