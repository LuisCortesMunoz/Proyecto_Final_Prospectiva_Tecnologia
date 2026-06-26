@echo off
chcp 65001 >nul
title Pagina local (editor PLC) - LadderVoice

rem ============================================================
rem  Sirve el frontend en http://127.0.0.1:5500 para poder
rem  CARGAR programas al PLC.
rem
rem  Por que: una pagina publica HTTPS (github.io) NO puede hablar
rem  con el puente local (http://localhost:8000) por seguridad del
rem  navegador. Servida localmente, si puede.
rem
rem  Se usa 127.0.0.1 (no 'localhost') porque es el origen que el
rem  backend tiene permitido en CORS.
rem
rem  IMPORTANTE: tambien debe correr el puente PLC
rem  (iniciar_puente_PLC.bat, en la carpeta del backend).
rem
rem  Para detener: Ctrl + C  (la ventana se cierra sola).
rem ============================================================

cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] No se encontro Python en el PATH.
  echo Instala Python o abrelo desde el entorno donde lo tengas.
  echo.
  pause
  exit /b 1
)

echo.
echo  Sirviendo la pagina en http://127.0.0.1:5500
echo  Se abrira el editor en el navegador en unos segundos.
echo  Para detener: Ctrl + C  (la ventana se cierra sola).
echo.

rem Abre el navegador 2 s despues, cuando el servidor ya este arriba.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5500/ladder.html"

rem Sirve esta carpeta (frontend). Bloquea hasta Ctrl+C.
python -m http.server 5500 --bind 127.0.0.1
