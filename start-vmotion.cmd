@echo off
cd /d "%~dp0"
if not exist "dist\desktop\main.cjs" (
  echo Please run npm ci, npm run native:build and npm run build first.
  pause
  exit /b 1
)
"node_modules\electron\dist\electron.exe" . %*
