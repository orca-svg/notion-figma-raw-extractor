import type { ExtractionOptions } from "../types";

type Props = {
  options: ExtractionOptions;
  onChange: (next: ExtractionOptions) => void;
  onRun: (mode: "live" | "demo") => void;
  running: boolean;
  connected: boolean;
};

function Toggle({ checked, onChange, hint, children }: { checked: boolean; onChange: (value: boolean) => void; hint?: string; children: React.ReactNode }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span>
      <span className="toggle-label">
        {children}
        {/* 마우스 hover와 키보드 focus 모두에서 뜨도록 CSS가 :hover와 :focus-within을 함께 본다. */}
        {hint ? (
          <>
            <span className="toggle-mark" aria-hidden="true">?</span>
            <span className="toggle-hint" role="note">{hint}</span>
          </>
        ) : null}
      </span>
    </label>
  );
}

export function TargetPanel({ options, onChange, onRun, running, connected }: Props) {
  const patch = (next: Partial<ExtractionOptions>) => onChange({ ...options, ...next });
  return (
    <section className="panel target-panel" aria-labelledby="target-title">
      <div className="panel-heading">
        <span className="section-mark">02</span>
        <div>
          <p className="eyebrow">대상</p>
          <h2 id="target-title">가져올 파일</h2>
        </div>
      </div>
      <label className="field">
        <span>Notion 페이지·데이터베이스 URL 또는 ID</span>
        <textarea value={options.target} onChange={(event) => patch({ target: event.target.value })} rows={3} spellCheck={false} />
      </label>
      <div className="two-fields">
        <label className="field compact">
          <span>검색어</span>
          <input value={options.searchQuery ?? ""} onChange={(event) => patch({ searchQuery: event.target.value })} placeholder="예: 오류, 회의록" />
        </label>
        <label className="field compact">
          <span>최대 행</span>
          <input type="number" min={1} max={50} value={options.maxRows} onChange={(event) => patch({ maxRows: Number(event.target.value) })} />
        </label>
      </div>
      <div className="toggle-list">
        <Toggle
          checked={options.includeArchived}
          onChange={(value) => patch({ includeArchived: value })}
          hint="켜면 query_data_sources를 활성·보관 두 번 호출해 보관된 행까지 읽습니다. 끄면 활성 행만 읽고 호출 수와 시간이 절반으로 줄어듭니다."
        >보관된 행도 확인</Toggle>
        <Toggle
          checked={options.includeComments}
          onChange={(value) => patch({ includeComments: value })}
          hint="켜면 읽은 페이지마다 get_comments를 호출해 댓글과 해결된 토론을 가져옵니다. 페이지 수만큼 호출이 늘어납니다."
        >댓글과 토론 확인</Toggle>
        <Toggle
          checked={options.includeTranscript}
          onChange={(value) => patch({ includeTranscript: value })}
          hint="fetch 요청에 include_transcript를 붙여 AI 회의록 전사까지 받습니다. 응답이 크게 늘어나고 플랜에 따라 거부될 수 있습니다."
        >회의록 전사 포함</Toggle>
        <Toggle
          checked={options.includeWorkspace}
          onChange={(value) => patch({ includeWorkspace: value })}
          hint="대상 문서와 무관하게 get_users·get_teams로 워크스페이스 멤버 명부와 팀스페이스를 읽습니다. 멤버 이름과 이메일이 트레이스와 ZIP에 남으므로 필요할 때만 켜세요."
        >워크스페이스 멤버·팀스페이스 확인</Toggle>
      </div>
      <button className="primary-button full" type="button" onClick={() => onRun("live")} disabled={!connected || !options.target || running}>
        {running ? "읽는 중" : connected ? "실제 MCP로 읽기" : "계정을 먼저 연결하세요"}
      </button>
      <button className="demo-button full" type="button" onClick={() => onRun("demo")} disabled={running}>
        26행 예제로 먼저 보기
      </button>
      <p className="demo-note">예제 모드는 로컬 CSV를 MCP 응답 형태로 재생합니다. 실제 조회 결과와 섞이지 않습니다.</p>
    </section>
  );
}
