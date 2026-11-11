@echo off
setlocal
pushd "%~dp0.."
node "%~dp0openbesluitvorming-progress.js" %*
set "RESULT=%ERRORLEVEL%"
popd
endlocal & exit /b %RESULT%
