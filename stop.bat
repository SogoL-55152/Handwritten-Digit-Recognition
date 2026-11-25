@echo off
chcp 65001 >nul
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Docker；本机模式请运行 scripts\stop-all.ps1
  pause
  exit /b 1
)
docker compose down
echo.
echo 已停止（数据保留在 Docker volume 中）
pause
