@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === One-click deploy (local mode, no Docker) ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy.ps1" %*
if errorlevel 1 (
  echo.
  echo Deploy failed. See the output above.
  pause
  exit /b 1
)
echo.
echo Done. Closing this window will NOT stop the services.
pause
