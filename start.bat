@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\quickstart.ps1" %*
if errorlevel 1 (
  echo.
  echo 启动失败，请把上面的输出发给项目维护者。
  pause
  exit /b 1
)
echo.
echo 已启动。关闭本窗口不会停止服务。
pause
