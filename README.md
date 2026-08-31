# MCP Trace Studio

Notion·Figma·Slack의 원문 추출, Tool 입력, 원시 응답, 소요 시간, 실패와 생략을 단계별로 확인하는 React 기반 로컬 검사 도구입니다.

이 프로젝트는 읽기 전용입니다. 도구 안내 화면에는 서버가 제공하는 쓰기 Tool도 표시하지만 추출 경로에서는 호출하지 않습니다.

## 화면

- `/notion`: Notion 계정 연결, 페이지·데이터베이스 추출 타임라인
- `/notion/tools`: Notion MCP Tool 지도와 워크스페이스별 가용 상태
- `/figma`: Figma Desktop/Remote/Codex Bridge/개발 Plugin 연결, Design·FigJam 노드 추출과 근거 기반 질문
- `/figma/tools`: Desktop/Remote/Codex/Plugin 및 파일 유형별 Figma 읽기 경로 지도
- `/slack`: 공식 Slack Export ZIP 정규화와 사용자 범위 Slack MCP 조회
- `/slack/tools`: 관리자 Export와 Slack MCP 역할·Tool 지도
- `/`와 기존 `/tools`는 각각 `/notion`, `/notion/tools`로 이동합니다.

## 요구 사항

- Node.js `22.x` 권장 (`20.19.0` 이상 지원)
- npm `10.x` 이상 권장
- Notion 실제 추출: 접근 가능한 Notion 계정 또는 개인 토큰
- Figma Desktop 추출: 최신 Figma 데스크톱 앱과 Dev Mode MCP 서버
- Figma Codex Bridge 추출: 로그인된 Codex Desktop 또는 `codex` CLI와 Codex에 등록된 Figma MCP
- Figma Plugin 추출: Figma Desktop과 직접 설치한 `plugins/figma-trace/manifest.json`
- 최근 버전 비교: 내부 Figma OAuth App과 배포된 `oauth-broker/` Vercel Function

```bash
nvm use
npm ci
npm run dev
```

### 내부 파일럿 ZIP

다른 Mac에서 반복 테스트할 때는 저장소 전체를 복사하는 대신 실행 권한과 빌드된 Figma Plugin을 포함한 안전한 ZIP을 만듭니다.

```bash
npm ci
npm run package:pilot
```

결과는 `release/mcp-trace-studio-pilot-v<version>.zip`에 생성됩니다. 패키징은 허용 목록에 있는 파일만 포함하며 `.env`, credential 형태의 문자열, 개인 절대 경로, `node_modules`, 로그를 발견하면 중단합니다.

ZIP 사용자는 [내부 파일럿 시작 안내](PILOT-START.md)에 따라 macOS에서는 `setup.command`, Windows에서는 `setup.ps1`을 실행하고 Figma manifest를 등록합니다. 이후에는 각각 `start.command` 또는 `start.ps1`로 로컬 앱을 시작합니다.

실행 주소:

- Web: http://127.0.0.1:5173/notion
- Figma: http://127.0.0.1:5173/figma
- API: http://127.0.0.1:8787/api/health

연결 없이 UI와 전체 추출 흐름을 먼저 확인하려면 `/figma`의 `Design 예제로 전체 여정 보기` 또는 `/notion`의 `26행 예제로 먼저 보기`를 누릅니다. 예제 응답은 실제 MCP 실행과 섞이지 않습니다.

프로덕션 빌드는 API 서버가 `dist`의 Web 파일도 함께 제공합니다.

```bash
npm run build
npm start
```

## Notion 연결

Notion 모드는 OAuth 또는 개인 토큰을 지원합니다. 토큰은 브라우저 저장소나 파일에 기록하지 않고 API 서버 세션 메모리에만 둡니다.

구현된 읽기 흐름:

1. `tools/list`
2. `fetch({ id: "self" })`
3. `get_users`와 `get_teams` (기본 꺼짐, `워크스페이스 멤버·팀스페이스 확인`을 켰을 때만)
4. `search`
5. `fetch(target)`
6. 데이터 소스와 뷰 조회
7. SQL 방식 행 조회
8. 행별 본문 조회
9. 댓글과 토론 조회
10. 첨부 원본 내려받기 (서명 URL 직접 fetch, `origin: "internal"`)

첨부는 만료되는 서명 URL이라 실행 중 즉시 내려받아 실행 artifact로 보관합니다. 인스펙터의 `시각 자료` 탭에서 미리볼 수 있고 ZIP의 `artifacts/assets/`에도 들어갑니다. Notion MCP의 `download_attachment`는 `create-attachment`로 올린 200KiB 이하 텍스트 첨부 전용이라 페이지에 삽입된 이미지에는 쓸 수 없으며, 도구 설명도 서명 URL 사용을 안내합니다. 한 실행에서 최대 12개, 개당 25MB까지 받습니다.

연결이 없어도 26행 CSV fixture로 전체 흐름을 재생할 수 있습니다.

## Figma 연결

### Desktop MCP

1. Figma 데스크톱 앱에서 Design 또는 FigJam 파일을 엽니다.
2. Dev Mode로 전환합니다.
3. Inspect 패널의 MCP 서버를 켭니다.
4. `/figma`에서 `Desktop MCP 다시 확인`을 누릅니다.

서버는 `http://127.0.0.1:3845/mcp`에 직접 연결합니다. 노드 링크와 Figma 앱의 현재 선택을 모두 지원합니다.

Desktop MCP는 브라우저가 아니라 이 프로젝트의 API 서버에서 `127.0.0.1:3845`로 연결합니다. 따라서 실제 Desktop 추출은 Figma 앱과 API 서버를 같은 컴퓨터에서 실행해야 합니다.

### Remote MCP beta

Remote는 `https://mcp.figma.com/mcp`의 OAuth 흐름을 사용합니다. Figma의 승인 클라이언트 정책에 따라 이 독립 클라이언트의 인증이 제한될 수 있으며, 실패해도 Desktop 모드는 계속 사용할 수 있습니다.

연결 후 `whoami` Tool이 제공되면 계정·플랜·seat 응답도 추적합니다. Remote는 링크 기반이며 현재 선택 모드는 지원하지 않습니다.

### Codex Bridge beta

Codex Bridge는 Figma가 승인한 Codex의 Figma OAuth 연결을 로컬 `codex` CLI를 통해 사용합니다. 독립 Remote 클라이언트 등록이 거부되는 환경에서 선택할 수 있는 별도 모드입니다.

1. `/figma`에서 `Codex β`를 선택합니다.
2. Codex 로그인이 필요하면 `Codex 기기 로그인 시작`을 누르고 공식 기기 인증 화면에서 완료합니다.
3. `Figma OAuth 시작`을 누르고 Figma 공식 승인 화면에서 완료합니다.
4. Figma 노드 링크를 입력하고 `Codex를 통해 읽기`를 누릅니다.

앱은 Codex 비밀번호, API key, Figma token을 입력받지 않습니다. 인증 URL과 기기 코드만 화면에 표시하며 자격 증명은 Codex가 관리합니다. Codex에 Figma MCP가 없다면 다음 명령으로 추가할 수 있습니다.

```bash
codex mcp add figma --url https://mcp.figma.com/mcp
```

이 모드는 직접 MCP 클라이언트가 아닙니다. 읽기 전용 고정 프롬프트로 Codex를 실행하고 `codex exec --json`의 Figma Tool 이벤트를 추적하므로 `origin: "codex"`로 기록합니다. 따라서 직접 MCP content block과 달라질 수 있으며 Codex의 모델·Skill 실행 경로를 포함합니다. Desktop과 독립 Remote 모드는 계속 `origin: "mcp"`인 직접 원시 추적입니다.

Codex의 `get_screenshot`이 짧은 수명의 Figma `image_url`을 반환하면 서버가 즉시 이미지를 내려받아 실행 artifact로 보관합니다. 인스펙터의 `시각 자료` 탭에서 미리볼 수 있으며 ZIP의 `artifacts/screenshots/`에도 포함됩니다. 기존 실행처럼 URL만 남아 있는 동안에는 같은 탭에서 임시 미리보기를 제공합니다.

### Plugin Bridge

일반 사용자에게 Desktop MCP 토글이 보이지 않는 환경을 위한 내부 파일럿 연결입니다. 프로젝트 루트에서 `npm run build:plugin`을 실행하고 [개발 플러그인 안내](plugins/figma-trace/README.md)에 따라 manifest를 Figma Desktop에 가져옵니다.

1. `/figma`에서 `Plugin`을 선택하고 6자리 페어링 코드를 만듭니다.
2. 열린 Design 또는 FigJam 파일에서 개발 플러그인을 실행하고 코드를 입력합니다.
3. 추출할 프레임이나 레이어를 선택하고 macOS는 `Command L`, Windows는 `Ctrl L`을 누릅니다. 우클릭 메뉴의 `Copy/Paste as → Copy link to selection`을 사용해도 됩니다.
4. `노드 추출`은 복사한 `node-id` 포함 링크를 입력합니다. `현재 페이지 추출`은 링크 없이 Figma에서 열어 둔 페이지를 사용합니다.
5. 버전 변화도 필요하면 별도의 `Figma 버전 이력 OAuth 연결`을 완료합니다.

NH Plugin 추출에서는 REST OAuth가 필수입니다. OAuth scope는 `current_user:read`, `file_content:read`, `file_metadata:read`, `file_comments:read`, `file_versions:read`이며 파일 생성자·최근 수정자·전체 댓글·버전 작성자 원문을 ZIP의 `metadata/`에 보존합니다. 버전 작성자는 버전 생성자이며 개별 클릭이나 노드 변경의 정확한 작성자로 단정하지 않습니다.

현재 페이지 추출은 페이지를 최상위 프레임 단위로 나눠 `nodes/*.json`, `screenshots/*.png`, `assets/*`로 전송합니다. 제한을 넘거나 렌더링할 수 없는 프레임은 `page.json`에 `partial`, `omittedNodes`, `error`를 남기며 완전한 결과처럼 표시하지 않습니다.

페어링 코드는 5분 동안 유효하고 세션 토큰은 플러그인 메모리에만 남습니다. 연결되면 플러그인 창은 캔버스를 덜 가리도록 `280×176`으로 자동 축소됩니다. 다음 요청을 받으려면 창을 열어 둬야 하며, `X`로 닫으면 다시 열고 새 코드로 페어링해야 합니다. 이미 Trace Studio가 받은 실행 결과는 닫아도 유지되지만 `노드 추출 중` 또는 `결과 전송 중`에는 닫지 마세요.

file key가 다르거나 노드가 없으면 artifact를 보내기 전에 중단합니다. 사용자가 실행한 순간만 읽으며 지속적인 변경 감시는 하지 않습니다.

### 노드 질문과 제품 의미 해석

`Codex β`와 `Plugin` 모두 링크 아래 질문 입력과 `최신 정보로 질문`을 제공합니다. `제품 의미 해석`은 제품 역할·핵심 행동·정보 구조를 묻는 준비된 질문을 같은 경로로 실행합니다. 질문마다 최신 노드와 screenshot을 다시 읽고 이전 대화는 이어받지 않습니다.

- Codex β: Figma MCP 읽기 Tool을 호출한 같은 실행에서 구조화 답변 생성
- Plugin: Plugin snapshot, 현재 artifact, 최근 최대 5개 버전 diff를 만든 뒤 빈 임시 디렉터리의 읽기 전용 Codex CLI에 전달
- 답변: `answer`, node/version/artifact/tool `evidence`, `uncertainties`, model·prompt version·생성 시각

레이어명·텍스트·주석은 신뢰할 수 없는 근거로 격리합니다. 디자인 안의 명령문은 수행하지 않으며 근거가 부족하면 확인 불가로 답합니다. 버전 작성자 귀속은 클릭 단위 감사 로그가 아니라 `coarse_version_attribution`입니다.

### 대상 링크

- Figma Design: `https://www.figma.com/design/<file-key>/...?node-id=1-2`
- Design branch: `https://www.figma.com/design/<base-key>/branch/<branch-key>/...?node-id=1-2`
- FigJam: `https://www.figma.com/board/<file-key>/...?node-id=1-2`

`node-id`가 없는 파일 전체 링크는 실행하지 않습니다. node ID는 `1-2`와 `1:2` 형식을 모두 받아 MCP 입력용 `1:2`로 정규화합니다. Slides와 Make 링크는 지원하지 않습니다.

### 기본 고급 옵션

| 옵션 | 기본값 | 범위 |
| --- | --- | --- |
| 변수와 스타일 | 켬 | `get_variable_defs` |
| Code Connect | 켬 | `get_code_connect_map` |
| 하위 모션 | 켬 | `get_motion_context`, `recursive: true` |
| Remote 라이브러리 | 끔 | Remote의 `get_libraries` |
| Remote 자산 다운로드 | 끔 | Remote의 `download_assets` |
| Frameworks / Languages | `unknown` | Tool 입력 힌트 |
| Code Connect label | 없음 | 입력했을 때만 전달 |

### 파일 유형과 Tool 흐름

노드 링크의 `/design/`·`/board/` 경로로 유형을 감지합니다. Desktop 현재 선택은 Design을 먼저 확인하고 파일 유형 오류일 때 FigJam으로 전환합니다.

Design 기본 흐름:

1. `tools/list`
2. `get_design_context`
3. 응답이 너무 크거나 metadata-only일 때 `get_metadata`
4. `get_screenshot` — 최대 변 2048px
5. `get_variable_defs`
6. `get_code_connect_map`
7. `get_motion_context`
8. Remote 선택 옵션에 따라 `get_libraries`, `download_assets`

FigJam 기본 흐름:

1. `tools/list`
2. `get_figjam`
3. `get_screenshot` — 최대 변 2048px
4. Remote 선택 옵션에 따라 `download_assets`

Figma Design 예제 모드는 연결 없이 합성 MCP 응답과 screenshot artifact를 재생합니다. FigJam 예제는 제공하지 않습니다.

연결 방식이나 파일 유형에 맞는 Tool이 없으면 호출을 실패시키지 않고 정확한 이유와 함께 `skipped` 이벤트로 남깁니다. 실제 MCP 쓰기 Tool, `use_figma`, 업로드, 생성 Tool은 추출 경로에서 호출하지 않습니다.

## 원시 응답과 번들

인스펙터는 `원시 응답`을 기본 탭으로 열고 `MCP 입력`, `추출 메타`, `시각 자료`를 함께 제공합니다. 텍스트·JSON·XML content block은 원문을 유지하며 이미지·오디오·resource blob은 base64를 UI에 출력하지 않고 binary artifact로 분리합니다.

요약 값은 노드·변수·매핑·artifact 수, 응답 크기, 잘림과 누락 Tool처럼 결정적으로 계산할 수 있는 정보만 포함합니다. Desktop과 독립 Remote 모드는 AI 해석, Skill 실행, 코드 생성을 수행하지 않습니다. Codex Bridge는 Codex 중계 실행을 포함하며 UI와 번들에서 직접 MCP 추적과 명확히 구분합니다.

Figma 실행 결과는 전체 JSON으로 복사하거나 ZIP으로 받을 수 있습니다.

```text
manifest.json
context.json
trace.ndjson
responses/<order>-<tool>.json
artifacts/screenshots/*
artifacts/assets/*
README.md
```

Plugin 현재 페이지 ZIP은 추가로 다음 파일을 포함합니다.

```text
page.json
nodes/<top-level-node>.json
metadata/file.json
metadata/comments.json
metadata/versions.json
screenshots/<top-level-frame>.png
assets/*
```

## Slack 연결과 전달 형식

### 공식 Export ZIP

NH Workspace/Org Owner에게 `All channels and conversations` 범위의 원본 JSON Export ZIP, export 기간, workspace 이름, 포함 범위 확인을 요청합니다. ZIP은 압축 해제하거나 내부 파일명을 바꾸지 않고 `/slack`에 올립니다. 공개 채널만 있는 Export도 처리하지만 비공개 채널·DM 전체 포함 여부는 Slack 플랜과 관리자 승인을 따릅니다.

업로드는 로컬 메모리에서 250MB까지 받습니다. 압축 해제 전에 파일 수, 개별·전체 해제 크기, 압축비, 상위 경로를 검사하고 정규화가 끝나면 원본 byte를 지웁니다. 결과 ZIP에는 `users.json`, `conversations/*.ndjson`, `files/index.json`과 provenance가 들어갑니다. 일반 JSON Export의 파일 값은 실제 첨부가 아니라 인증이 필요한 링크일 수 있습니다.

### Slack MCP OAuth

공식 `https://mcp.slack.com/mcp`에 PKCE OAuth로 연결합니다. 요청 scope는 채널·그룹·DM history/read, `files:read`, `users:read`이며 인증 사용자가 볼 수 있는 대화만 읽습니다. 채널 ID 또는 Slack 대화 URL을 입력하면 history와 thread replies를 정규화합니다. 조직 전체 DM을 읽는 경로가 아니며 전체 DM은 관리자 Export를 사용합니다.

Figma 실행 기록은 서버 메모리에 1시간 동안, 세션당 최근 3개를 보관합니다. artifact는 하나당 10MB, 실행당 100MB까지 저장합니다. 서버 재시작 시 인증 정보와 실행 기록은 사라지며 사용자가 ZIP을 선택했을 때만 영구 파일을 만듭니다.

## API

Notion:

- `GET /api/notion/status`
- `POST /api/notion/auth/start`
- `POST /api/notion/auth/pat`
- `POST /api/notion/auth/logout`
- `POST /api/notion/extract/stream`

기존 `/api/status`, `/api/auth/*`, `/api/extract/stream`은 Notion 별칭으로 유지됩니다.

Figma:

- `GET /api/figma/status?transport=desktop|remote|codex|plugin`
- `POST /api/figma/auth/start`
- `GET /api/figma/auth/callback`
- `POST /api/figma/auth/logout`
- `POST /api/figma/codex/auth/start`
- `POST /api/figma/codex/figma/start`
- `POST /api/figma/codex/auth/cancel`
- `POST /api/figma/plugin/pair/start`
- `POST /api/figma/plugin/pair/complete`
- `GET /api/figma/plugin/status`
- `GET /api/figma/plugin/jobs/next`
- `PUT /api/figma/plugin/jobs/:jobId/artifacts/:slot`
- `POST /api/figma/plugin/jobs/:jobId/result`
- `POST /api/figma/rest/auth/start`
- `GET /api/figma/rest/auth/callback`
- `POST /api/figma/rest/auth/logout`
- `POST /api/figma/extract/stream`
- `POST /api/figma/questions/stream`
- `GET /api/figma/runs/:runId`
- `GET /api/figma/runs/:runId/bundle.zip`
- `GET /api/figma/runs/:runId/artifacts/:artifactId`

Slack:

- `GET /api/slack/status`
- `POST /api/slack/auth/start`
- `GET /api/slack/auth/callback`
- `POST /api/slack/auth/logout`
- `POST /api/slack/imports`
- `POST /api/slack/imports/:importId/extract/stream`
- `POST /api/slack/extract/stream`
- `GET /api/slack/runs/:runId`
- `GET /api/slack/runs/:runId/bundle.zip`

브라우저의 모든 쓰기 API는 `/api/session`에서 받은 세션별 CSRF token과 허용된 loopback Origin을 요구합니다. Figma Plugin의 pair complete와 bearer job API만 Plugin token 경계로 분리합니다.

추출 스트림은 `application/x-ndjson`이며 각 이벤트에 provider, runId, origin, Tool, 입력, 원시 응답, 상태, 소요 시간, 응답 byte와 artifact 참조가 포함됩니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8787` | Express API 포트 |
| `API_ORIGIN` | `http://127.0.0.1:8787` | OAuth callback과 API 기준 주소 |
| `APP_ORIGIN` | 개발 `http://127.0.0.1:5173` | OAuth 뒤 돌아올 Web 주소 |
| `CODEX_BRIDGE_MODEL` | `gpt-5.5` | Codex Bridge에서 사용할 로컬 Codex 모델 |
| `CODEX_BRIDGE_REASONING` | `low` | Codex Bridge reasoning effort |
| `FIGMA_REST_BROKER_URL` | 없음 | 배포한 Figma REST OAuth broker 공개 주소 |

`oauth-broker/`에는 `FIGMA_REST_CLIENT_ID`, `FIGMA_REST_CLIENT_SECRET`, `BROKER_TICKET_SECRET`, `LOCAL_CALLBACK_ORIGIN`을 Vercel 비밀값으로 등록합니다. 선택적으로 `BROKER_PUBLIC_ORIGIN`을 고정할 수 있습니다. 자세한 내용은 [OAuth broker 안내](oauth-broker/README.md)를 봅니다.

## 검증

```bash
npm run typecheck
npm test
npm run build
npm --prefix oauth-broker run typecheck
```

## 보안 원칙

- `.env`와 `oauth-broker/.env`는 Git에서 제외합니다. 저장소의 `.env.example`에는 placeholder만 두고 실제 client secret, token, 개인 계정 정보는 커밋하지 않습니다.
- Notion과 독립 Figma Remote의 연결·실행 상태는 서로 분리하며 토큰은 서버 세션 메모리에만 저장합니다. Codex Bridge 자격 증명은 앱이 읽거나 저장하지 않고 Codex 자체 인증 저장소가 관리합니다.
- 실제 추출은 읽기 Tool과 읽기 전용 Plugin API로 제한합니다.
- `use_figma`, 업로드, 파일 생성, Code Connect 쓰기 Tool은 호출하지 않습니다.
- Codex Bridge는 직접 MCP 원문이 아니라 중계 이벤트이므로 번들의 `transport`와 각 이벤트의 `origin`을 확인하세요.
- OAuth broker는 PKCE·암호화된 짧은 수명 ticket·로컬 redeem secret으로 코드 교환과 갱신만 수행하며 디자인 원문을 받지 않습니다.
- 원시 응답에는 비공개 문서와 디자인 정보가 포함될 수 있으므로 ZIP을 외부에 공유하기 전에 확인하세요.
