@echo off
chcp 65001 >nul
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Docker
  pause
  exit /b 1
)
echo 这会删除所有数据（数据库/样本/训练产物）。
set /p answer=确定请输入 yes：
if /i not "%answer%"=="yes" (
  echo 已取消
  pause
  exit /b 0
)
docker compose down -v
echo.
echo 已清空。下次 start.bat 会重新初始化。
pause
