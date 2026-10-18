@echo off
cd /d "%~dp0"
call npm run package
echo.
echo Done! Your app is in the dist folder (PrivBrowse.exe inside).
pause
