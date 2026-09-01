#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MANIFEST_PATH="$SCRIPT_DIR/plugins/figma-trace/manifest.json"
PLUGIN_CODE="$SCRIPT_DIR/plugins/figma-trace/dist/code.js"
PLUGIN_UI="$SCRIPT_DIR/plugins/figma-trace/dist/ui.html"
CHECK_ONLY=false
INTERACTIVE=true

for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=true ;;
    --non-interactive) INTERACTIVE=false ;;
    *) print -u2 "알 수 없는 옵션: $argument"; exit 2 ;;
  esac
done

pause_if_interactive() {
  if $INTERACTIVE && [[ -t 0 ]]; then
    print
    read -k 1 "?아무 키나 누르면 창을 닫습니다."
    print
  fi
}

fail() {
  print -u2
  print -u2 "설정 실패: $1"
  pause_if_interactive
  exit 1
}

print "MCP Trace Studio 초기 설정"
print "위치: $SCRIPT_DIR"

command -v node >/dev/null 2>&1 || fail "Node.js 20.19 이상이 필요합니다. https://nodejs.org 에서 설치해 주세요."
command -v npm >/dev/null 2>&1 || fail "npm을 찾을 수 없습니다. Node.js를 다시 설치해 주세요."

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)' \
  || fail "현재 Node.js는 $(node --version)입니다. 20.19 이상으로 업데이트해 주세요."

cd "$SCRIPT_DIR"

if ! $CHECK_ONLY; then
  print
  print "[1/2] 의존성을 설치합니다."
  npm ci

  print
  print "[2/2] Figma Plugin을 빌드합니다."
  npm run build:plugin
fi

[[ -f "$PLUGIN_CODE" ]] || fail "플러그인 빌드 파일이 없습니다: $PLUGIN_CODE"
[[ -f "$PLUGIN_UI" ]] || fail "플러그인 UI 파일이 없습니다: $PLUGIN_UI"
[[ -f "$MANIFEST_PATH" ]] || fail "manifest를 찾을 수 없습니다: $MANIFEST_PATH"

if $INTERACTIVE && command -v pbcopy >/dev/null 2>&1; then
  print -n "$MANIFEST_PATH" | pbcopy
fi

if ! $CHECK_ONLY && $INTERACTIVE && command -v open >/dev/null 2>&1; then
  open -R "$MANIFEST_PATH"
fi

print
print "설정 완료"
print "1. Figma Desktop에서 Plugins → Development → Import plugin from manifest… 를 엽니다."
print "2. Finder에서 선택된 manifest.json을 가져옵니다."
print "3. 이후에는 start.command를 실행합니다."
print
print "manifest 경로: $MANIFEST_PATH"
if $INTERACTIVE && command -v pbcopy >/dev/null 2>&1; then
  print "manifest 경로를 클립보드에 복사했습니다."
fi

pause_if_interactive
