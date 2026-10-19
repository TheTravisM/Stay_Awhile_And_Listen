@echo off
setlocal
title Cain Reader - TTS server

rem ============================================================
rem  One-click launcher for the Cain Reader TTS server.
rem  Double-click this file. Ctrl+C in the window stops the server.
rem  Run  start-cain-server.cmd /check  to only report paths + port.
rem ============================================================

set "PORT=8765"
set "STREAM_VENV=C:\TTS-Streaming-Test\.venv"

rem --- repo root = this file's folder (so it keeps working if moved)
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "SERVER=%REPO%\server"

rem --- prefer the streaming fork environment, fall back to the repo venv
set "ENGINE_ENV=cain-streaming"
set "ENGINE_NOTE=streaming fork (%STREAM_VENV%)"
set "PY=%STREAM_VENV%\Scripts\python.exe"
if exist "%PY%" goto have_python

set "ENGINE_ENV=cain"
set "ENGINE_NOTE=default cain engine (repo venv)"
set "PY=%SERVER%\.venv\Scripts\python.exe"

:have_python
if /i "%~1"=="/check"   goto check
if /i "%~1"=="--check"  goto check

rem --- never start a second server on the same port
powershell -NoProfile -Command "exit 0 + [int][bool](Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue)"
if errorlevel 1 goto busy

cd /d "%SERVER%"
set "CAIN_ENGINE=%ENGINE_ENV%"
if /i "%ENGINE_ENV%"=="cain-streaming" set "CAIN_STREAMING_OPTIMIZE=1"

echo ============================================================
echo  Cain Reader TTS server
echo  engine : %ENGINE_NOTE%
echo  python : %PY%
echo  url    : http://127.0.0.1:%PORT%    health: /health
echo  stop   : Ctrl+C in this window
echo ============================================================
echo.
"%PY%" -m uvicorn app:app --host 127.0.0.1 --port %PORT%
echo.
echo Server exited (code %ERRORLEVEL%).
pause
goto :eof

:busy
echo ============================================================
echo  Port %PORT% is already in use.
echo  A server looks like it is already running - nothing started.
echo  Check : http://127.0.0.1:%PORT%/health
echo ============================================================
timeout /t 8 >nul
goto :eof

:check
echo repo root  : %REPO%
echo server dir : %SERVER%
echo python     : %PY%
if exist "%PY%"             (echo   python found : yes) else (echo   python found : NO)
if exist "%SERVER%\app.py"  (echo   app.py found : yes) else (echo   app.py found : NO)
echo engine     : %ENGINE_NOTE%
echo            : CAIN_ENGINE=%ENGINE_ENV%  CAIN_STREAMING_OPTIMIZE=1 (streaming only)
echo port %PORT%   :
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { '  in use (a server is running)' } else { '  free' }"
echo.
echo (nothing was started - this was only a check)
goto :eof
