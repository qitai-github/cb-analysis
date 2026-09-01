@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "d:\97_Claude\股票網頁"
python "scripts\schedule\daily_holdings.py" %*
exit /b %errorlevel%
