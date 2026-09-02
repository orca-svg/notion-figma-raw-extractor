// start.bat에서 준비 확인과 브라우저 열기를 배치로 짜면 curl 유무에 의존해야 한다.
// Node는 이미 실행 조건이므로 폴링을 여기로 옮긴다.
import { spawn } from "node:child_process";

const WEB_URL = "http://127.0.0.1:5173/figma";
const API_URL = "http://127.0.0.1:8787/api/health";
const ATTEMPT_LIMIT = 80;
const ATTEMPT_INTERVAL_MS = 500;

async function reachable(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    if (!expected) return true;
    return (await response.text()).includes(expected);
  } catch {
    return false;
  }
}

function openBrowser(url) {
  // Windows의 start는 cmd 내장 명령이라 셸을 거쳐야 한다. 첫 인자는 창 제목 자리라 비워 둔다.
  const command = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["open", [url]];
  spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
}

for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
  if (await reachable(API_URL, '"ok":true') && await reachable(WEB_URL)) {
    openBrowser(WEB_URL);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, ATTEMPT_INTERVAL_MS));
}

process.stderr.write(`MCP Trace Studio가 40초 안에 준비되지 않았습니다. 브라우저에서 ${WEB_URL} 을 직접 열어 주세요.\n`);
process.exit(1);
