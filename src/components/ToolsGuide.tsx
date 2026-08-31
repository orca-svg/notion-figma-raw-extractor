import type { ConnectionStatus } from "../types";

type ToolGroup = {
  label: string;
  tone: "read" | "write" | "manage";
  summary: string;
  tools: Array<{ name: string; title: string; description: string }>;
};

const TOOL_GROUPS: ToolGroup[] = [
  {
    label: "찾기와 읽기",
    tone: "read",
    summary: "워크스페이스에서 대상을 찾고, 페이지·데이터베이스·댓글의 내용을 가져옵니다.",
    tools: [
      { name: "search", title: "워크스페이스 검색", description: "제목과 본문 의미를 기준으로 관련 페이지와 데이터베이스를 찾습니다." },
      { name: "fetch", title: "페이지·데이터베이스 조회", description: "URL이나 ID로 본문, 속성, 데이터 소스와 뷰 정보를 읽습니다." },
      { name: "query_data_sources", title: "데이터 소스 조회", description: "데이터베이스 행을 필터·정렬하거나 SQL 방식으로 조회합니다." },
      { name: "query_database_view", title: "데이터베이스 뷰 조회", description: "지정한 뷰의 필터와 정렬이 적용된 행을 가져옵니다." },
      { name: "get_comments", title: "댓글 조회", description: "페이지와 블록에 달린 댓글 및 해결된 토론을 확인합니다." },
      { name: "query_meeting_notes", title: "회의 노트 조회", description: "AI 회의 노트와 전사 내용을 조회합니다. 플랜에 따라 제한될 수 있습니다." },
    ],
  },
  {
    label: "만들기와 수정",
    tone: "write",
    summary: "새 콘텐츠를 만들거나 기존 페이지와 데이터 구조를 바꿉니다.",
    tools: [
      { name: "create_pages", title: "페이지 생성", description: "부모 페이지나 데이터 소스 아래에 새 페이지를 만듭니다." },
      { name: "update_page", title: "페이지 수정", description: "페이지 속성, 아이콘, 본문 블록과 보관 상태를 변경합니다." },
      { name: "create_comment", title: "댓글 작성", description: "페이지 또는 특정 블록에 새 댓글을 남깁니다." },
      { name: "create_database", title: "데이터베이스 생성", description: "속성 스키마를 포함한 새 데이터베이스를 만듭니다." },
      { name: "update_data_source", title: "데이터 소스 수정", description: "데이터베이스 속성을 추가하거나 이름과 설정을 변경합니다." },
      { name: "create_view", title: "뷰 생성", description: "데이터 소스에 표, 보드 등 새로운 뷰를 만듭니다." },
      { name: "update_view", title: "뷰 수정", description: "기존 뷰의 이름, 표시 방식과 설정을 변경합니다." },
    ],
  },
  {
    label: "정리와 복제",
    tone: "manage",
    summary: "콘텐츠의 위치와 복사본, 폴더 구조를 관리합니다.",
    tools: [
      { name: "move_pages", title: "페이지 이동", description: "하나 이상의 페이지를 다른 페이지나 팀스페이스 아래로 옮깁니다." },
      { name: "duplicate_page", title: "페이지 복제", description: "페이지와 하위 콘텐츠의 복사본을 만듭니다." },
      { name: "create_folder", title: "폴더 생성", description: "워크스페이스 콘텐츠를 묶을 새 폴더를 만듭니다." },
      { name: "convert_page_to_skill", title: "페이지를 Skill로 변환", description: "페이지 지식을 에이전트가 사용할 수 있는 Skill로 변환합니다." },
    ],
  },
  {
    label: "파일",
    tone: "manage",
    summary: "Notion 페이지에 연결되는 파일의 업로드와 다운로드를 처리합니다.",
    tools: [
      { name: "create_file_upload", title: "파일 업로드 준비", description: "Notion에 파일을 올릴 업로드 세션을 생성합니다." },
      { name: "create_attachment", title: "첨부파일 연결", description: "업로드한 파일을 페이지 콘텐츠나 속성에 첨부합니다." },
      { name: "download_attachment", title: "첨부파일 다운로드", description: "접근 가능한 Notion 첨부파일을 내려받습니다." },
    ],
  },
  {
    label: "워크스페이스 탐색",
    tone: "read",
    summary: "사람, 팀스페이스와 자주 쓰는 페이지 목록을 탐색합니다.",
    tools: [
      { name: "get_users", title: "사용자 조회", description: "워크스페이스 사용자와 기본 프로필 정보를 확인합니다." },
      { name: "get_teams", title: "팀스페이스 조회", description: "접근 가능한 팀스페이스와 구조를 확인합니다." },
      { name: "list_private_pages", title: "개인 페이지 목록", description: "현재 사용자의 개인 페이지를 나열합니다." },
      { name: "list_shared_pages", title: "공유 페이지 목록", description: "다른 사용자와 공유된 페이지를 나열합니다." },
      { name: "list_favorite_pages", title: "즐겨찾기 목록", description: "현재 사용자가 즐겨찾기에 둔 페이지를 확인합니다." },
      { name: "list_recent_pages", title: "최근 페이지 목록", description: "최근 열거나 수정한 페이지를 확인합니다." },
      { name: "search_agents", title: "에이전트 검색", description: "워크스페이스에서 사용할 수 있는 Notion 에이전트를 찾습니다." },
      { name: "get_async_task", title: "비동기 작업 확인", description: "복제처럼 오래 걸리는 작업의 진행 상태를 확인합니다." },
    ],
  },
];

function accessLabel(value?: string) {
  if (value === "available") return "사용 가능";
  if (value === "available_with_limit") return "제한적 사용";
  if (value === "upgrade_required") return "업그레이드 필요";
  if (value === "not_enabled") return "비활성";
  return "확인 필요";
}

function accessTone(value?: string) {
  if (value === "available") return "available";
  if (value === "available_with_limit") return "limited";
  if (value === "upgrade_required" || value === "not_enabled") return "blocked";
  return "unknown";
}

export function ToolsGuide({ status }: { status: ConnectionStatus }) {
  const access = status.identity?.current_tool_access;
  const total = TOOL_GROUPS.reduce((count, group) => count + group.tools.length, 0);
  const available = access ? Object.values(access).filter((tool) => tool.status === "available" || tool.status === "available_with_limit").length : undefined;

  return (
    <main className="tools-guide">
      <section className="tools-hero">
        <div>
          <p className="eyebrow">Notion MCP tool map</p>
          <h1>찾고, 읽고,<br />필요할 때만 씁니다.</h1>
        </div>
        <div className="tools-hero-copy">
          <p>Notion MCP는 검색부터 페이지 수정까지 여러 도구를 제공합니다. 이 검사기는 그중 읽기 도구만 호출하며, 아래 상태는 현재 연결된 워크스페이스를 기준으로 표시합니다.</p>
          <dl className="tools-counts">
            <div><dt>안내 도구</dt><dd>{total}</dd></div>
            <div><dt>현재 사용 가능</dt><dd>{available ?? "—"}</dd></div>
            <div><dt>연결</dt><dd>{status.connected ? status.identity?.workspace?.name ?? "연결됨" : "연결 안 됨"}</dd></div>
          </dl>
        </div>
      </section>

      <section className="operation-rail" aria-label="MCP 도구 작업 범주">
        <div className="rail-node read"><span>READ</span><strong>찾기·읽기</strong><small>안전한 정보 조회</small></div>
        <i aria-hidden="true">→</i>
        <div className="rail-node write"><span>WRITE</span><strong>만들기·수정</strong><small>콘텐츠 변경</small></div>
        <i aria-hidden="true">→</i>
        <div className="rail-node manage"><span>MANAGE</span><strong>정리·파일</strong><small>구조와 자산 관리</small></div>
      </section>

      {!status.connected ? (
        <div className="tools-connection-note"><strong>도구 상태를 확인하려면 Notion을 연결하세요.</strong><span>도구 목록은 볼 수 있지만 워크스페이스별 사용 가능 여부는 추출 검사 화면에서 연결한 뒤 표시됩니다.</span></div>
      ) : null}

      <div className="tool-groups">
        {TOOL_GROUPS.map((group) => (
          <section className={`tool-group ${group.tone}`} key={group.label}>
            <header>
              <div><span>{group.label}</span><b>{String(group.tools.length).padStart(2, "0")} tools</b></div>
              <p>{group.summary}</p>
            </header>
            <div className="tool-card-grid">
              {group.tools.map((tool) => {
                const current = access?.[tool.name];
                return (
                  <article className="tool-card" key={tool.name}>
                    <div className="tool-card-top">
                      <code>{tool.name}</code>
                      {status.connected ? <span className={`tool-access ${accessTone(current?.status)}`}>{accessLabel(current?.status)}</span> : null}
                    </div>
                    <h2>{tool.title}</h2>
                    <p>{tool.description}</p>
                    {current?.upgrade_url ? <a href={current.upgrade_url} target="_blank" rel="noreferrer">플랜 조건 확인 ↗</a> : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <aside className="safety-note">
        <span>이 앱의 원칙</span>
        <strong>추출 검사에서는 쓰기 도구를 호출하지 않습니다.</strong>
        <p>소개 화면에는 지원 범위를 이해할 수 있도록 쓰기 도구도 표시하지만, 실제 실행 경로는 검색·조회·댓글 읽기와 선택한 경우의 워크스페이스 탐색으로 제한됩니다.</p>
      </aside>
    </main>
  );
}
