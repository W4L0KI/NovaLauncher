@echo off
cd /d "%~dp0"
echo Installation des dependances...
npm install
if errorlevel 1 pause && exit /b 1
echo Creation du .exe...
npm run build
pause
