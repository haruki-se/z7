@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.10 or newer is required. Install Python, then run this file again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8000 in Chrome or Edge after the server starts.
py -3 server.py
pause
