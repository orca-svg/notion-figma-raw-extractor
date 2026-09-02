@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
set "WEB_URL=http://127.0.0.1:5173/figma"
set "CHECK_ONLY="

if "%~1"=="" goto arguments_parsed
if /i "%~1"=="--check" (
  set "CHECK_ONLY=1"
  goto arguments_parsed
)
echo 알 수 없는 옵션: %~1
exit /b 2

:arguments_parsed
cd /d "%PROJECT_ROOT%"
if errorlevel 1 goto bad_root

if not exist "node_modules\.bin\tsx.cmd" goto needs_setup
if not exist "node_modules\.bin\vite.cmd" goto needs_setup
if not exist "plugins\figma-trace\dist\code.js" goto needs_setup
if not exist "plugins\figma-trace\dist\ui.html" goto needs_setup
goto ready

:needs_setup
if not defined CHECK_ONLY goto run_setup
echo 실행 준비가 되지 않았습니다. setup.bat을 먼저 실행해 주세요.
exit /b 1

:run_setup
echo 필요한 설치 또는 Plugin 빌드가 없어 초기 설정을 실행합니다.
call "%PROJECT_ROOT%setup.bat" --non-interactive
if errorlevel 1 exit /b 1

:ready
if not defined CHECK_ONLY goto launch
echo MCP Trace Studio 실행 준비 완료
echo Plugin: plugins\figma-trace\dist\code.js
echo URL: %WEB_URL%
exit /b 0

:launch
rem 대형 파일은 파트 합계가 GB 단위로 간다. 기본 힙(약 4GB)으로는 ZIP 조립에서 죽는다.
set "NODE_OPTIONS=%NODE_OPTIONS% --max-old-space-size=8192"

echo MCP Trace Studio를 시작합니다.
echo 준비되면 브라우저에서 %WEB_URL% 을 자동으로 엽니다.
echo 종료하려면 이 창에서 Control-C를 누르세요.
echo.

start "" /b node "%PROJECT_ROOT%scripts\open-when-ready.mjs"
call npm run dev
exit /b %ERRORLEVEL%

:bad_root
echo 실행 실패: 프로젝트 폴더로 이동하지 못했습니다: %PROJECT_ROOT%
echo.
echo 아무 키나 누르면 창을 닫습니다.
pause >nul
exit /b 1
