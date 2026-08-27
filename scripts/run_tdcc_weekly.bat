@echo off
chcp 65001 >nul
REM Weekly TDCC shareholding fetch (Friday night).
REM   fetch_tdcc.py  -> Drive sync folder + rebuild data/shareholding.json
REM Registered in Windows Task Scheduler as "TDCC-Shareholding-Weekly".
REM Log: scripts\output\tdcc_weekly.log
setlocal
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
if not exist output mkdir output
echo ===== %date% %time% ===== >> output\tdcc_weekly.log
python fetch_tdcc.py >> output\tdcc_weekly.log 2>&1
echo exit=%errorlevel% >> output\tdcc_weekly.log
endlocal
