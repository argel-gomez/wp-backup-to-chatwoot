@echo off
title WhatsApp Backup to Chatwoot
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem UTF-8 console with a larger grid than the default 80x25
set "PYTHONUTF8=1"
mode con: cols=112 lines=34 >nul 2>&1

rem --- Node.js runs the main application (Python is installed only for module 1) ---
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found on this computer.
  echo Install it with:  winget install OpenJS.NodeJS.LTS
  echo   ^(or download the LTS version from https://nodejs.org^) and run this file again.
  echo.
  pause
  exit /b 1
)

rem --- the chat importer uses node:sqlite; verify that the module actually loads
rem     (available without a flag since Node 22.13 / 23.4; target: Node 24) ---
node -e "require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Your Node.js installation does not include the sqlite module required by this program.
  for /f "delims=" %%v in ('node --version') do echo Installed version: %%v
  echo Node 22.13 or newer is required ^(24 LTS recommended^). Update it with:
  echo   winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

rem --- install dependencies pinned in package-lock.json on first run ---
if not exist node_modules (
  echo Installing dependencies with npm ci ^(first run only^)...
  call npm ci
  if errorlevel 1 (
    echo.
    echo [ERROR] npm ci failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem --- create .env from the safe template; onboarding asks for required values ---
if not exist .env (
  copy .env.example .env >nul
  echo Created .env. You do not need to edit it manually: the program asks for each
  echo value when first needed and saves it automatically.
  echo.
)

node menu.mjs %*
set "APP_EXIT=%ERRORLEVEL%"

echo.
pause
exit /b %APP_EXIT%
