@echo off
REM ===========================================================================
REM  KAKEIBO.SYS - Modo desenvolvimento
REM
REM  Abre duas janelas: servidor e interface, as duas com recarga automatica.
REM  A interface fica na porta 3000 e faz proxy de /api para o servidor.
REM
REM  Use este quando estiver mexendo no codigo. Para so' usar o sistema,
REM  INICIAR.bat e' mais simples.
REM ===========================================================================

chcp 65001 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  ================================================
echo   KAKEIBO.SYS - DESENVOLVIMENTO
echo  ================================================
echo.

if not exist "node_modules" (
    echo  [ERRO] Dependencias nao instaladas. Rode CONFIGURAR.bat primeiro.
    echo.
    pause
    exit /b 1
)

if not exist "web\node_modules" (
    echo  [ERRO] Dependencias da interface nao instaladas. Rode CONFIGURAR.bat primeiro.
    echo.
    pause
    exit /b 1
)

echo  Abrindo duas janelas:
echo.
echo    1. Servidor (API + IA) ... porta 3333
echo    2. Interface (Vite) ...... porta 3000  ^<-- abra esta no navegador
echo.
echo  Feche as duas janelas para encerrar.
echo  ================================================
echo.

start "KAKEIBO.SYS - Servidor" cmd /k "chcp 65001 > nul && cd /d "%~dp0" && npm run dev"

REM Espera o servidor subir antes da interface, para o proxy nao falhar na
REM primeira requisicao.
timeout /t 4 /nobreak > nul

start "KAKEIBO.SYS - Interface" cmd /k "chcp 65001 > nul && cd /d "%~dp0" && npm run dev:web"

timeout /t 4 /nobreak > nul
start http://localhost:3000/

echo  Janelas abertas. Esta pode ser fechada.
echo.
timeout /t 5 /nobreak > nul
exit /b 0
