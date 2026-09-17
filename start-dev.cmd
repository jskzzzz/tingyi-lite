@echo off
setlocal
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-lite.ps1" %*
set "exitCode=%ERRORLEVEL%"
endlocal & exit /b %exitCode%
