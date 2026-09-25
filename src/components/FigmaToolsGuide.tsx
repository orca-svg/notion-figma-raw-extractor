import type { FigmaConnectionStatus } from "../types";

type ReadStep = {
  name: string;
  title: string;
  description: string;
  output: string;
  scope: "노드" | "현재 페이지" | "공통";
};

/*
 * Figma 추출은 개발 플러그인만 쓴다. 이 화면은 플러그인이 무엇을 어떤 순서로 읽고
 * 번들의 어디에 두는지 보여 준다. 같은 단어(화면·기능 묶음)를 추출 화면과 똑같이 쓴다.
 */
const GROUPS: Array<{ label: string; summary: string; tone: string; steps: ReadStep[] }> = [
  {
    label: "구조",
    summary: "열린 파일에서 노드 트리를 Figma REST와 같은 JSON으로 읽습니다.",
    tone: "figma-read",
    steps: [
      { name: "JSON_REST_V1", title: "노드 트리", description: "노드와 속성·변수 바인딩을 직렬화합니다. 24MB를 넘는 트리는 노드 경계에서 나눠 조각마다 따로 열립니다.", output: "nodes/", scope: "공통" },
      { name: "page.json", title: "페이지 색인", description: "최상위 노드와 트리 조각의 위치, 부분 추출 여부를 적습니다.", output: "page.json", scope: "현재 페이지" },
    ],
  },
  {
    label: "화면",
    summary: "추출 전에 고른 크기의 프레임을 화면으로 보고 따로 찍습니다.",
    tone: "figma-system",
    steps: [
      { name: "scan", title: "화면 크기 후보", description: "기기 이름이 붙은 프레임과 이름 없이 3번 이상 반복된 프레임 크기를 이미지 없이 찾습니다. 운영자가 확인 화면에서 고릅니다.", output: "확인 화면", scope: "현재 페이지" },
      { name: "screens", title: "화면 이미지", description: "고른 크기에 맞는 가장 바깥 프레임을 Figma에서 보이는 그대로 2배로 찍습니다. 뷰포트가 가린 스크롤 영역은 이미지로 꺼내지 않습니다.", output: "screens/<기기>/", scope: "현재 페이지" },
      { name: "groups", title: "기능 묶음", description: "화면을 둘 이상 품은 가장 안쪽 컨테이너를 찍고 소속 화면의 좌표를 붙입니다.", output: "groups/ · screens.json", scope: "현재 페이지" },
      { name: "exportAsync PNG", title: "노드 이미지", description: "링크한 노드와 최상위 프레임을 긴 변 2,048px 이하로 찍습니다.", output: "screenshots/", scope: "공통" },
      { name: "assets", title: "원본 이미지·SVG", description: "image fill 원본과 아이콘·로고 후보 SVG를 모읍니다. 같은 내용은 파일 하나로 합칩니다.", output: "assets/", scope: "공통" },
    ],
  },
  {
    label: "파일 이력",
    summary: "플러그인이 볼 수 없는 파일 정보는 개인 액세스 토큰으로 Figma REST에서 읽습니다.",
    tone: "figma-write",
    steps: [
      { name: "files/:key/meta", title: "파일 정보", description: "생성자와 마지막 편집자를 읽습니다.", output: "metadata/file.json", scope: "공통" },
      { name: "files/:key/comments", title: "댓글", description: "파일 전체 댓글을 읽습니다.", output: "metadata/comments.json", scope: "공통" },
      { name: "files/:key/versions", title: "버전", description: "버전과 작성자를 읽습니다. 개별 노드 변경의 작성자가 아니라 버전 단위입니다.", output: "metadata/versions.json", scope: "공통" },
    ],
  },
];

export function FigmaToolsGuide({ status }: { status: FigmaConnectionStatus }) {
  const total = GROUPS.reduce((sum, group) => sum + group.steps.length, 0);
  return (
    <main className="tools-guide figma-tools-guide">
      <section className="tools-hero figma-tools-hero">
        <div><p className="eyebrow">Figma plugin read path</p><h1>플러그인이 읽는 것과<br />번들에 남는 곳.</h1></div>
        <div className="tools-hero-copy">
          <p>Figma 개발 플러그인이 열린 파일에서 읽는 단계와, 각 결과가 ZIP 번들의 어디에 저장되는지 보여 줍니다. 파일 이력만 개인 액세스 토큰으로 Figma REST에서 읽습니다.</p>
          <dl className="tools-counts"><div><dt>읽기 단계</dt><dd>{total}</dd></div><div><dt>플러그인</dt><dd>{status.plugin?.connected ? "페어링됨" : "연결 안 됨"}</dd></div><div><dt>파일 이력</dt><dd>{status.restOAuth?.connected ? "연결됨" : "연결 안 됨"}</dd></div></dl>
        </div>
      </section>

      {!status.plugin?.connected ? <div className="tools-connection-note figma-note"><strong>Trace Studio에서 만든 6자리 코드로 개발 플러그인을 페어링해 주세요.</strong><span>{status.message}</span></div> : null}

      <div className="tool-groups">
        {GROUPS.map((group) => (
          <section className={`tool-group ${group.tone}`} key={group.label}>
            <header><div><span>{group.label}</span><b>{String(group.steps.length).padStart(2, "0")} steps</b></div><p>{group.summary}</p></header>
            <div className="tool-card-grid">
              {group.steps.map((step) => (
                <article className="tool-card" key={step.name}>
                  <div className="tool-card-top"><code>{step.name}</code></div>
                  <h2>{step.title}</h2><p>{step.description}</p>
                  <div className="tool-chips"><span>{step.scope}</span><span className="used">{step.output}</span></div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      <aside className="safety-note figma-safety"><span>Read only</span><strong>추출은 캔버스를 바꾸지 않습니다.</strong><p>플러그인은 노드를 만들거나 수정하지 않습니다. 이미지는 Figma 화면에서 보이는 그대로 찍습니다.</p></aside>
    </main>
  );
}
