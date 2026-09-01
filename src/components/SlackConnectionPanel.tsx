import type { SlackConnectionStatus } from "../types";

type Props = {
  status: SlackConnectionStatus;
  busy: boolean;
  onOAuth: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
};

export function SlackConnectionPanel({ status, busy, onOAuth, onDisconnect, onRefresh }: Props) {
  return (
    <section className="panel connection-panel" aria-labelledby="slack-connection-title">
      <div className="panel-heading">
        <span className="section-mark">S1</span>
        <div><p className="eyebrow">Slack access</p><h2 id="slack-connection-title">MCP 연결</h2></div>
      </div>
      <div className={status.connected ? "connection-summary connected" : "connection-summary"}>
        <span className="status-dot" aria-hidden="true" />
        <div><strong>{status.connected ? "Slack MCP 연결됨" : "Slack MCP 연결 안 됨"}</strong><p>{status.message ?? (status.connected ? <>{status.tools?.length ?? 0}개 Tool을 확인했습니다.</> : "Export ZIP은 OAuth 없이도 로컬에서 처리할 수 있습니다.")}</p></div>
      </div>
      {status.connected ? (
        <div className="connection-actions">
          <button type="button" onClick={() => void onRefresh()} disabled={busy}>연결 다시 확인</button>
          <button type="button" onClick={() => void onDisconnect()} disabled={busy}>연결 해제</button>
        </div>
      ) : (
        <button className="primary-button full" type="button" onClick={() => void onOAuth()} disabled={busy}>Slack MCP OAuth 연결</button>
      )}
      <p className="connection-footnote">MCP는 인증 사용자가 볼 수 있는 대화만 읽습니다. 조직 전체 DM은 관리자 Export ZIP으로만 가져옵니다.</p>
    </section>
  );
}
