#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
WEB_URL="http://127.0.0.1:5173/figma"
API_URL="http://127.0.0.1:8787/api/health"
CHECK_ONLY=false

for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=true ;;
    *) print -u2 "알 수 없는 옵션: $argument"; exit 2 ;;
  esac
done

cd "$SCRIPT_DIR"

if [[ ! -x "$SCRIPT_DIR/node_modules/.bin/tsx" \
   || ! -x "$SCRIPT_DIR/node_modules/.bin/vite" \
   || ! -f "$SCRIPT_DIR/plugins/figma-trace/dist/code.js" \
   || ! -f "$SCRIPT_DIR/plugins/figma-trace/dist/ui.html" ]]; then
  if $CHECK_ONLY; then
    print -u2 "실행 준비가 되지 않았습니다. setup.command를 먼저 실행해 주세요."
    exit 1
  fi
  print "필요한 설치 또는 Plugin 빌드가 없어 초기 설정을 실행합니다."
  "$SCRIPT_DIR/setup.command" --non-interactive
fi

# 대형 파일은 파트 합계가 GB 단위로 간다. 기본 힙(약 4GB)으로는 ZIP 조립에서 죽는다.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"

api_ready() {
  curl --silent --fail --max-time 1 "$API_URL" 2>/dev/null | grep -q '"ok":true'
}

web_ready() {
  curl --silent --fail --max-time 1 "$WEB_URL" >/dev/null 2>&1
}

open_trace_studio() {
  if command -v open >/dev/null 2>&1; then
    open "$WEB_URL"
  else
    print "브라우저에서 여세요: $WEB_URL"
  fi
}

if $CHECK_ONLY; then
  print "MCP Trace Studio 실행 준비 완료"
  print "Plugin: plugins/figma-trace/dist/code.js"
  print "URL: $WEB_URL"
  exit 0
fi

if api_ready && web_ready; then
  print "MCP Trace Studio가 이미 실행 중입니다."
  open_trace_studio
  exit 0
fi

(
  attempts=0
  until api_ready && web_ready; do
    attempts=$((attempts + 1))
    if (( attempts >= 80 )); then
      print -u2 "MCP Trace Studio가 40초 안에 준비되지 않았습니다. 이 창의 오류를 확인해 주세요."
      exit 1
    fi
    sleep 0.5
  done
  open_trace_studio
) &

print "MCP Trace Studio를 시작합니다."
print "준비되면 브라우저에서 $WEB_URL 을 자동으로 엽니다."
print "종료하려면 이 창에서 Control-C를 누르세요."
print

if api_ready; then
  npm run dev:web
elif web_ready; then
  npm run dev:server
else
  npm run dev
fi
