@echo off
REM ===========================================================================
REM  KAKEIBO.SYS - Popular com dados de exemplo
REM
REM  Cria 12 meses de movimento ficticio (369 lancamentos, contas, cartao com
REM  faturas, parcelamento, metas, divida e carteira de investimentos) para
REM  experimentar o sistema sem esperar um ano de uso real.
REM
REM  Inclui anomalias de proposito - fatura atrasada, cobranca duplicada e um
REM  mes de gasto acima do padrao - para os analisadores terem o que encontrar.
REM ===========================================================================

chcp 65001 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  ================================================
echo   DADOS DE EXEMPLO
echo  ================================================
echo.

if not exist "node_modules" (
    echo  [ERRO] Dependencias nao instaladas. Rode CONFIGURAR.bat primeiro.
    echo.
    pause
    exit /b 1
)

REM Conta quantos lancamentos ja existem, para nao apagar dado real sem avisar.
for /f "tokens=*" %%c in ('node --import tsx -e "import{getDb,closeDb}from''./src/db/client.js'';import{transactions}from''./src/db/schema.js'';try{process.stdout.write(String(getDb().select().from(transactions).all().length))}catch{process.stdout.write(''0'')}finally{closeDb()}" 2^>nul') do set EXISTENTES=%%c
if "!EXISTENTES!"=="" set EXISTENTES=0

if not "!EXISTENTES!"=="0" (
    echo  [ATENCAO] O banco ja tem !EXISTENTES! lancamento^(s^).
    echo.
    echo  Continuar vai APAGAR TODOS os dados atuais e substituir
    echo  pelos dados de exemplo. Isso nao pode ser desfeito.
    echo.
    set /p CONFIRMA="  Digite APAGAR para confirmar, ou qualquer outra coisa para cancelar: "
    if /i not "!CONFIRMA!"=="APAGAR" (
        echo.
        echo  Cancelado. Nada foi alterado.
        echo.
        pause
        exit /b 0
    )
    echo.
    echo  Substituindo os dados...
    call npm run db:seed -- --force
) else (
    echo  Banco vazio. Populando com os dados de exemplo...
    echo.
    call npm run db:seed
)

if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao popular o banco.
    echo.
    pause
    exit /b 1
)

echo.
echo  ================================================
echo   PRONTO
echo  ================================================
echo.
echo  Agora rode INICIAR.bat e experimente:
echo.
echo    - Pergunte no chat: "como estao minhas financas?"
echo    - Lance um gasto:   "gastei 45 no mercado ontem no nubank"
echo.
pause
