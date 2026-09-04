import { useState } from "react";
import type { SlackConnectionStatus } from "../types";

type Props = {
  status: SlackConnectionStatus;
  busy: boolean;
  onOAuth: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onConnectToken: (token: string) => Promise<void>;
  onDisconnectToken: () => Promise<void>;
};

const TOKEN_SCOPES = "channels:history, channels:read, groups:history, groups:read, users:read";

export function SlackConnectionPanel({ status, busy, onOAuth, onDisconnect, onRefresh, onConnectToken, onDisconnectToken }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>();
  const web = status.web;

  const handle = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const connect = () => handle(async () => {
    await onConnectToken(token);
    // 연결된 뒤에는 입력란에 토큰을 남겨 둘 이유가 없다.
    setToken("");
  });

  return (
    <section className="panel connection-panel" aria-labelledby="slack-connection-title">
      <div className="panel-heading">
        <span className="section-mark">A</span>
        <div><p className="eyebrow">Connection</p><h2 id="slack-connection-title">Slack 연결</h2></div>
      </div>

      {web?.connected ? (
        <div className="connected-card">
          <div className="connected-line">
            <span className="status-dot success" />
            <strong>{web.teamName ?? web.teamId ?? "연결된 워크스페이스"}</strong>
          </div>
          {web.userName ? <p>@{web.userName}</p> : null}
          <p className="small-copy">
            {web.tokenType === "bot" ? "Bot 토큰" : "User 토큰"} · 토큰 소유자가 볼 수 있는 채널만 읽습니다
          </p>
          <button className="text-button" type="button" onClick={() => void handle(onRefresh)} disabled={busy}>연결 다시 확인</button>
          {" · "}
          <button className="text-button" type="button" onClick={() => void handle(onDisconnectToken)} disabled={busy}>연결 해제</button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>Slack 토큰</span>
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="xoxp-…" />
            <small>서버 메모리에만 두며 파일이나 브라우저 저장소에 쓰지 않습니다. 프로그램을 껐다 켜면 다시 붙여넣습니다.</small>
          </label>
          <div className="connection-instructions">
            <p>api.slack.com/apps 에서 앱을 만들고, 사용자 토큰 범위에 다음 5개를 넣은 뒤 워크스페이스에 설치합니다.</p>
            <p className="connection-detail">{TOKEN_SCOPES}</p>
            <p>첨부 파일 원본까지 받으려면 files:read 를 함께 넣습니다.</p>
          </div>
          <button className="primary-button full" type="button" onClick={() => void connect()} disabled={!token || busy}>
            토큰 확인 후 연결
          </button>
          <details className="pat-box">
            <summary>Slack MCP OAuth로 연결</summary>
            <p>
              {status.connected
                ? `${status.tools?.length ?? 0}개 Tool을 확인했습니다.`
                : "조직이 mcp.slack.com 을 승인한 경우에만 쓸 수 있습니다. 토큰 방식은 중간 서버를 거치지 않습니다."}
            </p>
            {status.connected ? (
              <button className="text-button" type="button" onClick={() => void handle(onDisconnect)} disabled={busy}>MCP 연결 해제</button>
            ) : (
              <button className="secondary-button full" type="button" onClick={() => void handle(onOAuth)} disabled={busy}>Slack MCP OAuth 연결</button>
            )}
          </details>
        </>
      )}

      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
