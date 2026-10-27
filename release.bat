@echo off
rem Publish an update to everyone: release.bat [patch^|minor^|major] "What changed"
rem Example: release.bat patch "Fixed subtitles on some files"
cd /d "%~dp0"
node scripts\release.js %*
if errorlevel 1 (
    echo.
    echo Release failed - see the messages above.
)
pause
