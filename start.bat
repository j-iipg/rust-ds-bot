@echo off
cd /d "%~dp0"
:loop
node src/index.js
echo Bot crashed, restart in 10 sec...
timeout /t 10 >nul
goto loop
