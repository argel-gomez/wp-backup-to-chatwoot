@echo off
title WhatsApp Backup to Chatwoot
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem consola en UTF-8 y una grilla mas comoda que el 80x25 por defecto
set "PYTHONUTF8=1"
mode con: cols=112 lines=34 >nul 2>&1

rem --- Node.js es la base de todo el programa (Python se instala solo si usas el modulo 1) ---
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] No se encontro Node.js en este equipo.
  echo Instalalo con:    winget install OpenJS.NodeJS.LTS
  echo   ^(o desde https://nodejs.org, version LTS^) y volve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

rem --- el importador de chats usa node:sqlite: se prueba que el modulo cargue de
rem     verdad (existe sin flag recien desde Node 22.13 / 23.4; objetivo: Node 24) ---
node -e "require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Tu Node.js no trae el modulo sqlite que necesita este programa.
  for /f "delims=" %%v in ('node --version') do echo Version instalada: %%v
  echo Necesita Node 22.13 o mas nuevo ^(recomendado: 24 LTS^). Actualizalo con:
  echo   winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

rem --- dependencias fijadas en package-lock.json, solo la primera vez ---
if not exist node_modules (
  echo Instalando dependencias con npm ci ^(solo la primera vez^)...
  call npm ci
  if errorlevel 1 (
    echo.
    echo [ERROR] Fallo npm ci. Revisa tu conexion a internet y volve a intentar.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem --- .env: se crea vacio; el programa pregunta cada dato cuando lo necesita ---
if not exist .env (
  copy .env.example .env >nul
  echo Se creo .env. No hace falta editarlo a mano: el programa pregunta cada
  echo dato la primera vez que lo necesita y lo guarda solo.
  echo.
)

node menu.mjs %*
set "APP_EXIT=%ERRORLEVEL%"

echo.
pause
exit /b %APP_EXIT%
