@echo off
echo.
echo ========================================
echo   Building Windows Desktop EXE (Electron)
echo   DHAKA FLIX Movie Fetcher
echo ========================================
echo.

cd /d "%~dp0"

echo Step 0: Setting Electron download mirror...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_CACHE=%CD%\.cache\electron-builder
set ELECTRON_CACHE=%CD%\.cache\electron

echo Step 1: Installing dependencies...
call npm install
echo.

echo Step 2: Building executable...
echo This may take a few minutes...
call npm run build
echo.

if exist "dist\MovieFetcher-Portable-*.exe" (
    echo.
    echo ========================================
    echo   BUILD SUCCESSFUL!
    echo ========================================
    echo.
    echo Your executable is ready:
    echo   Location: dist\MovieFetcher-Portable-*.exe
    echo.
    echo Just double-click MovieFetcher-Portable-*.exe to run!
    echo.
    goto :done
)

echo ========================================
echo   BUILD FAILED!
echo ========================================
echo Please check the error messages above.
echo.

:done
pause

