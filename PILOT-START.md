# MCP Trace Studio 내부 파일럿 시작

Figma Desktop과 Trace Studio는 같은 Mac 또는 Windows PC에서 실행합니다. 이 폴더는 고정된 위치에 두고 사용하세요. 폴더를 옮기면 Figma에서 manifest를 다시 가져와야 합니다.

## 최초 한 번 · macOS

1. `setup.command`를 더블클릭합니다.
2. macOS가 실행을 막으면 파일을 우클릭하고 `열기`를 선택합니다.
3. 설정이 끝나면 Figma Desktop에서 `Plugins → Development → Import plugin from manifest…`를 엽니다.
4. Finder에서 선택된 `plugins/figma-trace/manifest.json`을 가져옵니다. 경로도 클립보드에 복사됩니다.

## 최초 한 번 · Windows

1. PowerShell에서 이 폴더의 `setup.ps1`을 실행합니다.
2. 실행 정책으로 막히면 사내 정책에 따라 서명/허용 여부를 관리자에게 확인합니다.
3. Figma Desktop에서 `Plugins → Development → Import plugin from manifest…`를 엽니다.
4. 표시된 `plugins\figma-trace\manifest.json`을 가져옵니다.

## 사용할 때마다

1. macOS는 `start.command`, Windows는 PowerShell의 `start.ps1`을 실행합니다.
2. 자동으로 열린 Trace Studio에서 `Figma → Plugin`을 선택하고 6자리 코드를 만듭니다.
3. Figma 파일에서 `MCP Trace Studio Bridge`를 실행하고 코드를 입력합니다.
4. 노드 추출은 프레임이나 레이어를 선택한 뒤 `Command L`로 링크를 복사해 붙여넣습니다. 페이지 추출은 Figma에서 대상 페이지를 열고 Trace Studio의 `현재 페이지 추출`을 선택합니다.
5. 파일 작성자·댓글·버전을 포함하려면 Trace Studio에서 `Figma 메타데이터 OAuth 연결`을 완료합니다. 이 연결은 Plugin 추출의 필수 단계입니다.

플러그인 창은 연결 후 작게 줄어듭니다. 다음 요청을 받으려면 창을 열어 두세요. 서버 또는 플러그인을 닫으면 새 코드로 다시 페어링합니다.

## 문제 확인

터미널에서 다음 명령으로 설치와 실행 준비를 확인할 수 있습니다.

```bash
./setup.command --check
./start.command --check
curl http://127.0.0.1:8787/api/health
```

Windows에서는 다음으로 확인합니다.

```powershell
.\setup.ps1 -Check
.\start.ps1 -Check
```

`dist/code.js` 오류가 보이면 `setup.command`를 다시 실행한 뒤 Figma에서 개발 플러그인을 제거하고 manifest를 다시 가져옵니다.
