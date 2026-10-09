@echo off
rem Yetimmm - add the Worker URL + Telegram to MT5 Allowed URLs (close MetaTrader 5 first)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-urls.ps1" %*
echo.
pause
