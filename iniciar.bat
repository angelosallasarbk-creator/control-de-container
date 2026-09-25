@echo off
setlocal
title Controle de Container - Iniciando
rem Inicia o Controle de Container local com dois cliques:
rem Docker (banco) -> dependencias -> API (porta 3000) -> Tela (porta 5174) -> navegador.
rem Para desligar: feche as janelas "Controle de Container - API" e "Controle de Container - Tela".

cd /d "%~dp0"
set "URL_TELA=http://localhost:5174"
set "URL_SAUDE=http://localhost:3000/api/saude"
set "DOCKER_DESKTOP=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"

echo.
echo  ==============================================
echo    Controle de Container - iniciando o sistema
echo  ==============================================
echo.

rem ---------- Ja esta rodando? Entao so abre o navegador ----------
call :sistema_no_ar
if not errorlevel 1 (
  echo  O sistema ja esta rodando. Abrindo o navegador...
  start "" "%URL_TELA%"
  goto :fim_ok
)

rem ---------- Porta 3000 ocupada por outro programa (ex.: McCain local)? ----------
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo  [ATENCAO] A porta 3000 ja esta em uso por outro programa
  echo            ^(provavelmente o Programacao McCain rodando localmente^).
  echo            Feche esse programa e rode o iniciar.bat de novo.
  goto :fim_erro
)

rem ---------- Requisitos ----------
where node >nul 2>&1
if errorlevel 1 (
  echo  [ERRO] Node.js nao encontrado. Instale em https://nodejs.org e tente de novo.
  goto :fim_erro
)
if not exist ".env" (
  echo  [ERRO] Arquivo .env nao encontrado nesta pasta. Copie o .env.example para .env
  echo         e gere um JWT_SECRET ^(veja o README^).
  goto :fim_erro
)

rem ---------- 1. Docker ----------
echo  [1/5] Verificando o Docker...
docker info >nul 2>&1
if not errorlevel 1 goto :docker_ok
if not exist "%DOCKER_DESKTOP%" (
  echo  [ERRO] Docker Desktop nao encontrado em "%DOCKER_DESKTOP%".
  goto :fim_erro
)
echo        Abrindo o Docker Desktop ^(pode levar ate 2 minutos^)...
start "" "%DOCKER_DESKTOP%"
set /a TENTATIVAS=0
:espera_docker
timeout /t 3 /nobreak >nul
docker info >nul 2>&1
if not errorlevel 1 goto :docker_ok
set /a TENTATIVAS+=1
if %TENTATIVAS% geq 60 (
  echo  [ERRO] O Docker nao respondeu em 3 minutos. Abra o Docker Desktop manualmente e tente de novo.
  goto :fim_erro
)
goto :espera_docker
:docker_ok
echo        Docker pronto.

rem ---------- 2. Banco ----------
echo  [2/5] Subindo o banco de dados...
docker compose up -d >nul 2>&1
if errorlevel 1 (
  echo  [ERRO] Nao foi possivel subir o banco. Rode "docker compose up -d" nesta pasta para ver o erro.
  goto :fim_erro
)
echo        Banco no ar.

rem ---------- 3. Dependencias (so na primeira vez ou se faltar) ----------
echo  [3/5] Conferindo dependencias...
if not exist "node_modules" (
  echo        Instalando dependencias da API ^(primeira vez^)...
  call npm install
  if errorlevel 1 goto :erro_npm
)
if not exist "web\node_modules" (
  echo        Instalando dependencias da tela ^(primeira vez^)...
  call npm --prefix web install
  if errorlevel 1 goto :erro_npm
)
echo        Dependencias ok.

rem ---------- 4. API e Tela, cada uma na sua janela ----------
echo  [4/5] Abrindo a API e a Tela em janelas separadas ^(minimizadas^)...
start "Controle de Container - API" /min cmd /k "title Controle de Container - API && npm run dev:server"
start "Controle de Container - Tela" /min cmd /k "title Controle de Container - Tela && npm run dev:web"

rem ---------- 5. Espera responder e abre o navegador ----------
echo  [5/5] Aguardando o sistema responder...
set /a TENTATIVAS=0
:espera_api
timeout /t 2 /nobreak >nul
call :sistema_no_ar
if not errorlevel 1 goto :pronto
set /a TENTATIVAS+=1
if %TENTATIVAS% geq 45 (
  echo  [ERRO] O sistema nao respondeu em 90 segundos.
  echo         Abra as janelas "Controle de Container - API" e "- Tela" na barra de tarefas para ver o erro.
  goto :fim_erro
)
goto :espera_api

:pronto
echo.
echo  Sistema no ar em %URL_TELA%
start "" "%URL_TELA%"
echo  Para desligar: feche as janelas "Controle de Container - API" e "Controle de Container - Tela".
goto :fim_ok

rem ---------- Checa se a API responde E a tela abre (errorlevel 0 = no ar) ----------
:sistema_no_ar
powershell -NoProfile -Command "try { $null = Invoke-WebRequest '%URL_SAUDE%' -UseBasicParsing -TimeoutSec 3; $null = Invoke-WebRequest '%URL_TELA%' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { exit 1 }" >nul 2>&1
exit /b %errorlevel%

:erro_npm
echo  [ERRO] Falha ao instalar dependencias. Verifique a internet e tente de novo.
goto :fim_erro

:fim_ok
echo.
echo  Esta janela fecha sozinha em 5 segundos...
timeout /t 5 >nul
exit /b 0

:fim_erro
echo.
pause
exit /b 1
