@echo off
REM ===========================================================================
REM  KAKEIBO.SYS - Configuracao inicial
REM
REM  Roda uma vez, na primeira instalacao. Faz o que precisa ser feito antes de
REM  o sistema subir: instala dependencias, cria o .env, gera o segredo de
REM  sessao e prepara o banco.
REM
REM  Sem acentos nos comentarios e nas mensagens de propriedade: o console do
REM  Windows usa pagina de codigo 850/437 por padrao e acento sai quebrado.
REM  A pagina 65001 e' aplicada abaixo, mas o cabecalho ja foi lido antes dela.
REM ===========================================================================

chcp 65001 > nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  ================================================
echo   KAKEIBO.SYS - CONFIGURACAO INICIAL
echo  ================================================
echo.

REM --- Node instalado? -------------------------------------------------------
where node > nul 2>&1
if errorlevel 1 (
    echo  [ERRO] Node.js nao encontrado.
    echo.
    echo  Instale o Node 22 ou superior em https://nodejs.org
    echo  e rode este arquivo de novo.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [ok] Node.js !NODE_VER!

REM Confere a versao maior: o projeto usa recursos do Node 22+.
for /f "tokens=1 delims=." %%m in ("!NODE_VER:v=!") do set NODE_MAJOR=%%m
if !NODE_MAJOR! LSS 22 (
    echo  [ERRO] Node !NODE_VER! e' antigo demais. O projeto precisa da versao 22 ou superior.
    echo.
    pause
    exit /b 1
)

REM --- Dependencias ----------------------------------------------------------
echo.
echo  [1/5] Instalando dependencias do servidor...
call npm install
if errorlevel 1 goto :erro_npm

echo.
echo  [2/5] Instalando dependencias da interface...
call npm run web:install
if errorlevel 1 goto :erro_npm

REM --- Arquivo .env ----------------------------------------------------------
echo.
echo  [3/5] Preparando o arquivo de configuracao...

if exist ".env" (
    echo  [ok] .env ja existe - preservado como esta.
) else (
    copy ".env.example" ".env" > nul
    echo  [ok] .env criado a partir do exemplo.
)

REM Gera o segredo de sessao se estiver vazio. Sem ele, as sessoes caem a cada
REM reinicio do servidor.
node -e "const fs=require('fs'),c=require('crypto');let s=fs.readFileSync('.env','utf8');if(/^SESSION_SECRET=\s*$/m.test(s)){s=s.replace(/^SESSION_SECRET=\s*$/m,'SESSION_SECRET='+c.randomBytes(32).toString('hex'));fs.writeFileSync('.env',s);console.log('  [ok] SESSION_SECRET gerado.');}else{console.log('  [ok] SESSION_SECRET ja definido.');}"

REM --- Banco de dados --------------------------------------------------------
echo.
echo  [4/5] Preparando o banco de dados...
call npm run db:migrate
if errorlevel 1 goto :erro_db

REM --- Compilacao ------------------------------------------------------------
echo.
echo  [5/5] Compilando o sistema...
call npm run build
if errorlevel 1 goto :erro_build

REM --- Avisos finais ---------------------------------------------------------
echo.
echo  ================================================
echo   CONFIGURACAO CONCLUIDA
echo  ================================================
echo.

node --env-file-if-exists=.env -e "const p=(process.env.APP_PASSWORD||'').trim();const k=(process.env.DEEPSEEK_API_KEY||'').trim();const av=[];if(p===''||p==='troque-esta-senha')av.push('  [!] Defina APP_PASSWORD no arquivo .env - o servidor recusa subir sem ela.');else if(p.length<10||/^[0-9]+$/.test(p))av.push('  [!] Sua APP_PASSWORD e curta ou apenas numerica. Se for acessar pela rede, troque por algo mais longo.');if(k==='')av.push('  [!] DEEPSEEK_API_KEY vazia - o sistema funciona, mas sem a IA. Pegue a chave em https://platform.deepseek.com');if(av.length)console.log(av.join('\n')+'\n');else console.log('  [ok] Configuracao parece completa.\n');" 2>nul

echo  Proximos passos:
echo.
echo    - Para popular com 12 meses de dados de exemplo: POPULAR-EXEMPLO.bat
echo    - Para usar o sistema:                           INICIAR.bat
echo.
pause
exit /b 0

:erro_npm
echo.
echo  [ERRO] Falha ao instalar dependencias.
echo  Verifique sua conexao com a internet e tente de novo.
echo.
pause
exit /b 1

:erro_db
echo.
echo  [ERRO] Falha ao preparar o banco de dados.
echo.
pause
exit /b 1

:erro_build
echo.
echo  [ERRO] Falha ao compilar.
echo.
pause
exit /b 1
