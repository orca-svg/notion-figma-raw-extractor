# MCP Trace Studio · Figma 개발 플러그인

내부 파일럿에서 현재 열린 Figma Design 또는 FigJam 노드를 로컬 Trace Studio로 전달하는 읽기 전용 개발 플러그인입니다. Community 공개용 패키지가 아닙니다.

## 빌드와 설치

프로젝트 루트에서 플러그인을 빌드합니다.

```bash
npm run build:plugin
```

Figma Desktop에서 `Plugins → Development → Import plugin from manifest…`를 열고 이 폴더의 `manifest.json`을 선택합니다. manifest의 ID는 로컬 개발용 placeholder이며 Community 배포 전에 Figma가 발급한 ID로 교체해야 합니다.

Trace Studio API가 로컬 포트 `8787`에서 실행 중이어야 합니다. Figma 플러그인은 manifest에서 허용된 `http://localhost:8787`로 연결합니다. `/figma`의 `Plugin` 탭에서 6자리 코드를 만든 뒤 플러그인에 한 번 입력합니다. 코드는 5분, 연결 토큰은 플러그인 메모리에만 유지됩니다.

노드 추출은 Figma에서 프레임이나 레이어를 선택하고 macOS는 `Command L`, Windows는 `Ctrl L`을 눌러 selection 링크를 복사합니다. 페이지 추출은 링크 없이 현재 열어 둔 페이지를 최상위 프레임 단위로 읽습니다.

연결 전 창은 `320×330`, 연결 후 대기 창은 `280×176`입니다. 플러그인이 HTTP long-poll로 다음 요청을 기다리므로 연결 후에도 창을 열어 두세요. 창을 닫으면 실행 중인 요청과 메모리 토큰이 종료되며 다시 열어 새 6자리 코드로 페어링해야 합니다. Trace Studio가 이미 받은 완료 결과에는 영향을 주지 않습니다.

Figma가 이전 manifest 오류를 캐시하면 개발 플러그인을 제거한 뒤 같은 `manifest.json`을 다시 가져옵니다. `devAllowedDomains`는 Figma의 로컬 개발 origin 형식에 맞춰 `http://localhost:8787`을 사용합니다.

## 추출 범위

- 링크의 file key와 열린 파일의 `figma.fileKey`를 먼저 비교
- `getNodeByIdAsync()`와 `JSON_REST_V1`을 이용한 현재 노드 snapshot
- `currentPage.loadAsync()` 후 최상위 프레임별 JSON·PNG를 만드는 현재 페이지 추출
- 최대 변 2048px PNG screenshot
- 하위 image fill 및 이름이 icon/logo 후보인 SVG 최대 20개
- 노드 5,000개, JSON 20MB, artifact당 10MB, 실행당 100MB 제한
- 페이지 결과의 JSON은 `nodes/`, PNG는 `screenshots/`, 파일 댓글·작성자·버전은 `metadata/`에 저장
- 사용자가 실행하거나 질문한 시점에만 읽으며 `documentchange`를 감시하지 않음

플러그인은 노드를 만들거나 수정하지 않습니다. 현재 파일의 원문과 이미지는 Vercel OAuth 브로커가 아니라 로컬 Trace Studio로만 전송됩니다.
