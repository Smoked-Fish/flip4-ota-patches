@echo off
setlocal
net session >nul 2>&1
if errorlevel 1 (
    echo Asking for administrator rights to install a driver...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
if not exist "wdi-simple.exe" (
    echo wdi-simple.exe isn't next to this file. Unzip the whole zip first, then run this again.
    pause
    exit /b 1
)

echo This installs WinUSB for the TCL Flip 4 in EDL mode.
echo.
echo 1. Turn the phone off
echo 2. Hold Volume Up and Volume Down together while it starts. The screen will go white, or prompt a keypress
echo 3. Plug it in
echo.
pause

wdi-simple.exe --vid 0x05C6 --pid 0x9008 --type 0 --name "TCL Flip 4 EDL" --dest "%TEMP%\flip4-edl-driver" --progressbar
if errorlevel 1 (
    echo.
    echo The driver didn't install. Check the phone is in EDL mode and plugged in, then run this again.
) else (
    echo.
    echo Done. On the page, press "connect phone in edl mode" and pick the phone.
)
echo.
pause
