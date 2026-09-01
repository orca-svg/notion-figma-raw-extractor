import type { SlackConnectionStatus } from "../types";

export function SlackToolsGuide({ status }: { status: SlackConnectionStatus }) {
  return (
    <main className="tools-guide">
      <section className="tools-hero">
        <div><p className="eyebrow">Slack ingestion map</p><h1>전체 Export와<br />최신 조회를 분리합니다.</h1></div>
        <div className="tools-hero-copy">
          <p>관리자 Export는 승인된 전체 대화를 일괄 반입하고, Slack MCP는 인증 사용자가 접근할 수 있는 채널과 스레드의 최신 상태를 확인합니다.</p>
          <dl className="tools-counts"><div><dt>MCP 연결</dt><dd>{status.connected ? "연결됨" : "대기"}</dd></div><div><dt>확인 Tool</dt><dd>{status.tools?.length ?? "—"}</dd></div></dl>
        </div>
      </section>
      <div className="tool-groups">
        <section className="tool-group read"><header><div><span>관리자 Export ZIP</span><b>BATCH</b></div><p>공개·비공개 채널과 DM을 공식 JSON 구조에서 정규화합니다.</p></header></section>
        <section className="tool-group read"><header><div><span>Slack MCP OAuth</span><b>LIVE</b></div><p>인증 사용자가 볼 수 있는 채널 기록과 스레드만 읽습니다.</p></header><div className="tool-card-grid">{(status.tools ?? []).map((tool) => <article className="tool-card" key={tool.name}><code>{tool.name}</code><h2>{tool.name}</h2><p>{tool.description ?? "Slack MCP가 제공한 Tool입니다."}</p></article>)}</div></section>
      </div>
      <aside className="safety-note"><span>접근 경계</span><strong>일반 MCP 연결은 조직 전체 DM을 읽지 않습니다.</strong><p>DM 전체가 필요하면 Workspace/Org Owner가 승인한 All channels and conversations Export를 사용합니다.</p></aside>
    </main>
  );
}
