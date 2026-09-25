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
- 최상위 프레임 PNG: 페이지 배치도용. 긴 변 2048px 이하, 원본보다 키우지 않음
- 화면 PNG (현재 페이지 추출): 이름에 `Mobile`·`Tablet`·`Fold`·`Desktop`이 붙은 프레임에서 이 파일의 기기 크기를 배우고, 그 크기에 맞는 가장 바깥 프레임을 화면으로 보고 2배로 찍어 `screens/<기기>/`에 저장.
- 화면 이미지는 Figma에서 보이는 그대로 찍습니다. 뷰포트가 가린 스크롤 영역은 이미지로 꺼내지 않으며 노드 JSON에만 있습니다
- 이름이 기기 같아도(`Fold` 접기 카드 등) 그 크기의 프레임이 모두 다른 화면 안에 있으면 기기 크기로 인정하지 않고 `ignoredDevices`에 남김
- 이름에 기기 단어가 없어도 이름 붙은 화면 밖에서 같은 크기(±8px)가 3번 이상 반복되면 화면 크기로 보고 `repeated-<폭>x<높이>` 폴더에 저장(예: 미니모드 360×600 창). 단 그 크기의 프레임 대부분이 다른 화면 크기 프레임을 둘 이상 품고 있으면 기능 묶음으로 보고 제외. 이름도 반복도 없을 때만 폭 360~430·높이 600 이상을 모바일로 추정
- 기능 묶음 PNG: 화면을 둘 이상 품은 가장 안쪽 컨테이너를 긴 변 4096px 이하로 찍어 `groups/`에 저장. 소속 화면 좌표는 `screens.json`에 기록
- 이미지 원점 보정: 그림자·프레임 밖으로 넘친 내용이 있으면 이미지가 프레임보다 커진다. 프레임 원점이 이미지 안에서 놓인 위치를 `renderOffset`으로 남기고, 서버가 픽셀 `offset`으로 바꿔 모든 `imageRect`에 반영한다
- Figma 기본 주석: 노드에 붙은 주석(`label`·`labelMarkdown`·카테고리·고정 속성)을 모으고, 붙은 노드의 조상에서 화면·기능 묶음을 정한다. 카테고리 이름은 `figma.annotations.getAnnotationCategoriesAsync()`로 읽는다(노드 JSON에는 없음)
- 모든 PNG는 48MB를 넘으면 배율을 0.65배씩 줄여 첫 시도 포함 최대 4번 렌더링
- 하위 image fill 원본과 이름이 icon/logo 후보인 SVG (최대 50,000개, 담지 못한 에셋은 사유별 개수로 보고)
- JSON 파트당 24MB(서버 수신 32MB), artifact당 48MB, 실행당 총 2GB 제한. 페이지 추출은 넘치는 트리를 서브트리 파트로 나누고, 노드 단건 추출만 500,000개 안전판을 둡니다
- 페이지 결과의 JSON은 `nodes/`, PNG는 `screenshots/`, 파일 댓글·작성자·버전은 `metadata/`에 저장
- 사용자가 실행하거나 질문한 시점에만 읽으며 `documentchange`를 감시하지 않음

플러그인은 노드를 만들거나 수정하지 않습니다. 현재 파일의 원문과 이미지는 Vercel OAuth 브로커가 아니라 로컬 Trace Studio로만 전송됩니다.
