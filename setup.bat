@echo off
setlocal
cd /d "%~dp0"
if exist port.txt del port.txt
start "InstaBox Server" cmd /k "node server.js"
:wait
if not exist port.txt ( ping -n 2 127.0.0.1 >nul & goto wait )
for /f "usebackq delims=" %%A in ("port.txt") do set "PORT=%%A"
start "" "http://localhost:%PORT%"
echo InstaBox running on http://localhost:%PORT%
