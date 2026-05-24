@echo off
cd /d "%~dp0"

echo === CB Analysis Dev Server ===
echo Project: %CD%
echo.

echo [1/3] Checking python...
python --version
if errorlevel 1 (
    echo.
    echo [ERROR] python not found or failed to run
    echo Try: py -3 --version
    pause
    exit /b 1
)

echo.
echo [2/3] Opening browser...
start "" "http://localhost:8000/index.html"

echo.
echo [3/3] Starting HTTP server on port 8000
echo URL : http://localhost:8000/index.html
echo Stop: Ctrl+C
echo ----------------------------------------------
python -m http.server 8000

echo.
echo Server exited.
pause
