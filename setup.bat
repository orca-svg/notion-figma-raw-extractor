@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
set "MANIFEST_PATH=%PROJECT_ROOT%plugins\figma-trace\manifest.json"
set "PLUGIN_CODE=%PROJECT_ROOT%plugins\figma-trace\dist\code.js"
set "PLUGIN_UI=%PROJECT_ROOT%plugins\figma-trace\dist\ui.html"
set "CHECK_ONLY="
set "INTERACTIVE=1"

:parse_arguments
if "%~1"=="" goto arguments_parsed
if /i "%~1"=="--check" (
  set "CHECK_ONLY=1"
  shift
  goto parse_arguments
)
if /i "%~1"=="--non-interactive" (
  set "INTERACTIVE="
  shift
  goto parse_arguments
)
echo 알 수 없는 옵션: %~1
exit /b 2

:arguments_parsed
echo MCP Trace Studio 초기 설정
echo 위치: %PROJECT_ROOT%
echo.

where node >nul 2>&1
if errorlevel 1 goto no_node
where npm >nul 2>&1
if errorlevel 1 goto no_npm

rem node -e로 비교하면 부등호가 배치의 리다이렉션으로 먹히므로 버전을 받아 배치에서 비교한다.
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if not defined NODE_MAJOR goto no_node
if %NODE_MAJOR% LSS 20 goto old_node
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% LSS 19 goto old_node

cd /d "%PROJECT_ROOT%"
if errorlevel 1 goto bad_root

if defined CHECK_ONLY goto verify_files

echo [1/2] 의존성을 설치합니다.
call npm ci
if errorlevel 1 goto install_failed
echo.
echo [2/2] Figma Plugin을 빌드합니다.
call npm run build:plugin
if errorlevel 1 goto build_failed
echo.

:verify_files
if not exist "%PLUGIN_CODE%" goto missing_plugin
if not exist "%PLUGIN_UI%" goto missing_ui
if not exist "%MANIFEST_PATH%" goto missing_manifest

if not defined INTERACTIVE goto finished
<nul set /p "=%MANIFEST_PATH%" | clip
if not defined CHECK_ONLY explorer /select,"%MANIFEST_PATH%"

:finished
echo 설정 완료
echo 1. Figma Desktop에서 Plugins - Development - Import plugin from manifest... 를 엽니다.
echo 2. 탐색기에서 선택된 manifest.json을 가져옵니다.
echo 3. 이후에는 start.bat을 실행합니다.
echo.
echo manifest 경로: %MANIFEST_PATH%
if defined INTERACTIVE echo manifest 경로를 클립보드에 복사했습니다.
call :pause_if_interactive
exit /b 0

:no_node
echo.
echo 설정 실패: Node.js 20.19 이상이 필요합니다. https://nodejs.org 에서 설치해 주세요.
goto failed

:no_npm
echo.
echo 설정 실패: npm을 찾을 수 없습니다. Node.js를 다시 설치해 주세요.
goto failed

:old_node
echo.
echo 설정 실패: 현재 Node.js는 %NODE_MAJOR%.%NODE_MINOR% 입니다. 20.19 이상으로 업데이트해 주세요.
goto failed

:bad_root
echo.
echo 설정 실패: 프로젝트 폴더로 이동하지 못했습니다: %PROJECT_ROOT%
goto failed

:install_failed
echo.
echo 설정 실패: npm ci가 실패했습니다.
goto failed

:build_failed
echo.
echo 설정 실패: Plugin 빌드가 실패했습니다.
goto failed

:missing_plugin
echo.
echo 설정 실패: 플러그인 빌드 파일이 없습니다: %PLUGIN_CODE%
goto failed

:missing_ui
echo.
echo 설정 실패: 플러그인 UI 파일이 없습니다: %PLUGIN_UI%
goto failed

:missing_manifest
echo.
echo 설정 실패: manifest를 찾을 수 없습니다: %MANIFEST_PATH%
goto failed

:failed
call :pause_if_interactive
exit /b 1

:pause_if_interactive
if not defined INTERACTIVE exit /b 0
echo.
echo 아무 키나 누르면 창을 닫습니다.
pause >nul
exit /b 0
