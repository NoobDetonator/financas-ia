@echo off
REM ===========================================================================
REM  KAKEIBO.SYS - Iniciar
REM
REM  Sobe o sistema completo (interface + API + IA) numa porta so' e abre o
REM  navegador. E' o atalho do dia a dia.
REM
REM  Se algo nao estiver preparado, avisa o que fazer em vez de falhar seco.
REM ===========================================================================

chcp 65001 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

title KAKEIBO.SYS

echo.
echo  ================================================
echo   KAKEIBO.SYS
echo  ================================================
echo.

REM --- Verificacoes ----------------------------------------------------------
where node > nul 2>&1
if errorlevel 1 (
    echo  [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  [ERRO] Dependencias nao instaladas.
    echo         Rode CONFIGURAR.bat primeiro.
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo  [ERRO] Arquivo .env nao encontrado.
    echo         Rode CONFIGURAR.bat primeiro.
    echo.
    pause
    exit /b 1
)

REM A interface compilada e' necessaria para o modo de uma porta.
if not exist "web\dist\index.html" (
    echo  [aviso] Interface nao compilada. Compilando agora...
    echo.
    call npm run build
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao compilar.
        echo.
        pause
        exit /b 1
    )
    echo.
)

REM O servidor recusa subir com a senha de exemplo. Avisa antes, com a mensagem
REM certa, em vez de deixar o erro aparecer no meio do log.
node -e "require('dotenv').config({quiet:true});const p=(process.env.APP_PASSWORD||'').trim();const off=String(process.env.AUTH_DISABLED).toLowerCase()==='true';if(!off&&(p===''||p==='troque-esta-senha')){console.error('  [ERRO] Defina APP_PASSWORD no arquivo .env antes de iniciar.');process.exit(1)}" 2>nul
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

REM --- Descobre a porta e o endereco -----------------------------------------
for /f "tokens=*" %%p in ('node -e "require(''dotenv'').config({quiet:true});process.stdout.write(String(process.env.PORT||3333))" 2^>nul') do set PORT=%%p
if "!PORT!"=="" set PORT=3333

for /f "tokens=*" %%h in ('node -e "require(''dotenv'').config({quiet:true});const h=process.env.HOST||''127.0.0.1'';process.stdout.write(h===''0.0.0.0''?''127.0.0.1'':h)" 2^>nul') do set VIEWHOST=%%h
if "!VIEWHOST!"=="" set VIEWHOST=127.0.0.1

echo  Iniciando em http://!VIEWHOST!:!PORT!
echo.
echo   Interface ...... http://!VIEWHOST!:!PORT!/
echo   Documentacao ... http://!VIEWHOST!:!PORT!/docs
echo.
echo  Para encerrar: feche esta janela ou pressione Ctrl+C
echo  ================================================
echo.

REM Abre o navegador depois de um instante, para o servidor ja estar no ar.
start "" /b cmd /c "timeout /t 3 /nobreak > nul & start http://!VIEWHOST!:!PORT!/"

REM NODE_ENV=production faz o Fastify servir a interface compilada.
set NODE_ENV=production
node dist/main.js

REM Se chegou aqui, o servidor caiu.
echo.
echo  ================================================
echo   O servidor encerrou.
echo  ================================================
echo.
pause
