@echo off
title Undercut
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Undercut needs Node.js 22.13 or newer. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist "node_modules\web-push\" (
  echo Installing Undercut...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
  )
)
node tools\launch.js %*
if errorlevel 1 pause
