@echo off
REM Lokaler Start mit Demodaten (Windows). Doppelklick genuegt.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js fehlt. Bitte von https://nodejs.org installieren ^(Version 22 oder neuer^). & pause & exit /b 1)
if not exist node_modules call npm install --no-audit --no-fund
start "" http://localhost:3000
call npm run demo
pause
