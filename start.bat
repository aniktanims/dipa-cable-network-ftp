@echo off
rem Opens Movie Fetcher in your web browser (needs Node.js).
rem For the desktop app, use the "DHAKA FLIX Movies" shortcut or dist\MovieFetcher-Portable.exe instead.
cd /d "%~dp0"
start "Movie Fetcher Server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start http://localhost:8000/
