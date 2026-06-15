@echo off
REM Boss Dashboard launcher. Opens on http://localhost:3001 (or set BOSS_PORT).
cd /d "%~dp0"
if "%BOSS_PORT%"=="" set BOSS_PORT=3001
echo Starting Boss Dashboard on port %BOSS_PORT% ...
node server.js
