@echo off
setlocal
title Cain Reader - TTS server

rem ============================================================
rem  One-click launcher for the Cain Reader TTS server.
rem  Double-click this file. Ctrl+C in the window stops the server.
rem  Run  start-cain-server.cmd /check  to only report paths + port.
rem  Run  start-cain-server.cmd /stop   to stop the server on that port.
rem ============================================================

set "PORT=8765"

rem --- streaming environment; override with CAIN_STREAM_VENV if it lives elsewhere
set "STREAM_VENV=%CAIN_STREAM_VENV%"
if not defined STREAM_VENV set "STREAM_VENV=C:\TTS-Streaming-Test\.venv"
if "%STREAM_VENV:~-1%"=="\" set "STREAM_VENV=%STREAM_VENV:~0,-1%"

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
if /i "%~1"=="/stop"    goto stop
if /i "%~1"=="--stop"   goto stop

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
echo  Stop  : start-cain-server.cmd /stop
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
echo stop          : start-cain-server.cmd /stop   (stops what owns the port)
echo.
echo (nothing was started - this was only a check)
goto :eof

:stop
echo ============================================================
echo  Cain Reader TTS server - stop
echo ============================================================
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $c) { '  nothing is listening on port %PORT%'; exit 0 }; $owner = $c.OwningProcess; $p = Get-Process -Id $owner -ErrorAction SilentlyContinue; if (-not $p) { '  a listener exists but its process is gone'; exit 0 }; '  stopping ' + $p.ProcessName + ' (PID ' + $owner + ')'; Stop-Process -Id $owner -Force; Start-Sleep -Milliseconds 700; if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { '  port %PORT% is still in use'; exit 1 }; '  port %PORT% is free'"
if errorlevel 1 (echo  Stop failed. Close the server window with Ctrl+C instead.) else (echo  Done.)
echo.
powershell -NoProfile -Command "Start-Sleep -Seconds 3" >nul 2>&1
goto :eof
