@echo off
rem AI-DLC loop launcher (managed by aidlc-kit; upgrades overwrite local edits).
rem   .agents\aidlc\scripts\loop.cmd [command] [options]
rem Edit .agents\config.json ("loop") and .agents\loop.env, then run "loop.cmd up".
rem The script only locates the aidlc-kit CLI and forwards to "aidlc-kit loop <command>";
rem it never installs or upgrades anything. Local workers need Docker Desktop; the loop is
rem verified on Linux, so treat native Windows as best effort.
setlocal
for %%I in ("%~dp0..\..\..") do set "ROOT=%%~fI"

where node >nul 2>nul
if errorlevel 1 (
  echo loop.cmd: Node.js 20.17 or newer is required ^(https://nodejs.org^) 1>&2
  exit /b 1
)

set "CMD=%~1"
rem Options without a command run the default command: "loop.cmd --open" = "loop.cmd up --open".
if "%CMD%"=="" goto default_cmd
if /i "%CMD%"=="-h" goto named_cmd
if /i "%CMD%"=="--help" goto named_cmd
if "%CMD:~0,1%"=="-" goto default_cmd
:named_cmd
shift
goto args
:default_cmd
set "CMD=up"
:args
set "ARGS="
:collect
if "%~1"=="" goto dispatch
set ARGS=%ARGS% %1
shift
goto collect

:dispatch
if /i "%CMD%"=="help" goto usage
if /i "%CMD%"=="-h" goto usage
if /i "%CMD%"=="--help" goto usage
if /i "%CMD%"=="check" set "CMD=env"
if /i "%CMD%"=="logs" goto logs
for %%C in (up down stop status env) do if /i "%CMD%"=="%%C" goto run
echo loop.cmd: unknown command: %CMD% 1>&2
call :usage 1>&2
exit /b 2

:run
call :cli loop %CMD% --root "%ROOT%" %ARGS%
exit /b %ERRORLEVEL%

:cli
if exist "%ROOT%\node_modules\.bin\aidlc-kit.cmd" (
  call "%ROOT%\node_modules\.bin\aidlc-kit.cmd" %*
  goto :eof
)
set "RECORDED_CLI="
for /f "usebackq delims=" %%P in (`node -e "try{const r=require(process.argv[1]);if(typeof r.cli==='string'&&require('fs').statSync(r.cli).isFile())process.stdout.write(r.cli)}catch{}" "%ROOT%\.agents\data\loop\cli.json" 2^>nul`) do set "RECORDED_CLI=%%P"
if defined RECORDED_CLI (
  node "%RECORDED_CLI%" %*
  goto :eof
)
where aidlc-kit >nul 2>nul
if not errorlevel 1 (
  call aidlc-kit %*
  goto :eof
)
set "VERSION=latest"
for /f "usebackq delims=" %%V in (`node -p "require(process.argv[1]).packageVersion" "%ROOT%\.agents\aidlc\manifest.json" 2^>nul`) do set "VERSION=%%V"
where npx >nul 2>nul
if not errorlevel 1 (
  echo loop.cmd: aidlc-kit was not found in this project or recorded by init/upgrade; trying npx --no-install ^(if it fails: npm install --save-dev @felixdotgo/aidlc-kit@%VERSION%, or rerun init/upgrade from the package or .tgz you want^) 1>&2
  call npx --no-install @felixdotgo/aidlc-kit %*
  goto :eof
)
echo loop.cmd: the aidlc-kit CLI was not found: install it in this project ^(npm install --save-dev @felixdotgo/aidlc-kit@%VERSION%^), or rerun init/upgrade from the package or .tgz you want 1>&2
exit /b 1

:logs
set "LOG=%ROOT%\.agents\data\loop\daemon.log"
if exist "%LOG%" goto follow_log
echo No daemon log yet: "%LOG%"
exit /b 0
:follow_log
powershell -NoProfile -Command "Get-Content -LiteralPath $env:LOG -Tail 200 -Wait"
exit /b %ERRORLEVEL%

:usage
echo Usage: .agents\aidlc\scripts\loop.cmd [command] [options]
echo.
echo Commands:
echo   up       check the environment, start the loop daemon, and serve the dashboard (default)
echo            options: --loop-env PATH  --port 4173  --host 127.0.0.1  --open  --no-ui
echo   down     stop the dashboard started by "up" and the loop daemon (--now cancels the running turn)
echo   stop     stop only the loop daemon (--now cancels the running turn)
echo   status   daemon, dashboard, and environment at a glance (--json)
echo   check    show providers, the env file, and every variable the loop needs (--json)
echo   logs     follow the daemon log
echo   help     show this help
echo.
echo Configure .agents\config.json ("loop" section) and .agents\loop.env (model and API keys).
exit /b 0
