@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Install Node.js 22 or later from nodejs.org, then reopen this file.
 pause
 exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
