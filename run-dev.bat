@echo off
echo.
echo ========================================
echo   DHAKA FLIX Movie Fetcher - Dev Mode
echo ========================================
echo.

cd /d "%~dp0"

echo Setting Electron download mirror...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_CACHE=%CD%\.cache\electron

echo Installing dependencies...
call npm install

echo.
echo Starting Electron app...
call npm run dev
