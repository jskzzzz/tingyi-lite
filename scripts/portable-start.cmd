@echo off
setlocal

set "TINGYI_NODE=%~dp0runtime\node\node.exe"
if not exist "%TINGYI_NODE%" (
  echo Tingyi Lite package is incomplete: runtime\node\node.exe is missing.
  exit /b 1
)

"%TINGYI_NODE%" "%~dp0start.mjs" %*
exit /b %errorlevel%
