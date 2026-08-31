import { useState } from "react";
import type { CodexAuthFlow, FigmaConnectionStatus, FigmaTransport, PluginPairing } from "../types";

type Props = {
  statuses: Record<FigmaTransport, FigmaConnectionStatus>;
  transport: FigmaTransport;
  onTransportChange: (transport: FigmaTransport) => void;
  onRefresh: (transport: FigmaTransport) => Promise<void>;
  onOAuth: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onCodexLogin: () => Promise<CodexAuthFlow>;
  onCodexFigmaOAuth: () => Promise<CodexAuthFlow>;
  onCodexCancel: () => Promise<void>;
  onPluginPair: () => Promise<PluginPairing>;
  onRestPat: (token: string) => Promise<void>;
  onRestDisconnect: () => Promise<void>;
  busy: boolean;
};

/** 코드가 눌러서 복사된다는 사실이 보이지 않아서, 복사 아이콘과 완료 피드백을 함께 둔다. */
function CopyableCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      className={`copyable-code${className ? ` ${className}` : ""}${copied ? " copied" : ""}`}
      onClick={() => void copy()}
      title={label}
      aria-label={`${label} (${value.split("").join(" ")})`}
    >
      <span className="copyable-code-value">{value}</span>
      <span className="copyable-code-hint" aria-hidden="true">{copied ? "복사됨" : "복사"}</span>
    </button>
  );
}

function identityLabel(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["email", "handle", "name"]) if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = identityLabel(child);
    if (found) return found;
  }
  return undefined;
}

export function FigmaConnectionPanel({ statuses, transport, onTransportChange, onRefresh, onOAuth, onDisconnect, onCodexLogin, onCodexFigmaOAuth, onCodexCancel, onPluginPair, onRestPat, onRestDisconnect, busy }: Props) {
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState<PluginPairing>();
  const [restPat, setRestPat] = useState("");
  const status = statuses[transport];
  const handle = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const startCodexFlow = async (action: () => Promise<CodexAuthFlow>) => {
    setError(undefined);
    try {
      await action();
      await onRefresh("codex");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const createPairing = async () => {
    setError(undefined);
    try { setPairing(await onPluginPair()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return (
    <section className="panel connection-panel figma-connection" aria-labelledby="figma-connection-title">
      <div className="panel-heading">
        <span className="section-mark">A</span>
        <div><p className="eyebrow">Connection</p><h2 id="figma-connection-title">Figma 연결</h2></div>
      </div>
      <div className="segmented-control" role="group" aria-label="Figma MCP 연결 방식">
        {(["desktop", "remote", "codex", "plugin"] as const).map((item) => (
          <button key={item} type="button" className={transport === item ? "active" : ""} aria-pressed={transport === item} onClick={() => onTransportChange(item)}>
            {item === "desktop" ? "Desktop" : item === "remote" ? "Remote β" : item === "codex" ? "Codex β" : "Plugin"}
          </button>
        ))}
      </div>

      {transport === "codex" ? (
        <div className="codex-connection-body">
          <div className="bridge-disclosure">
            <span>CODEX BRIDGE</span>
            <p>Codex가 읽기 전용 프롬프트로 Figma Tool을 호출합니다. 직접 MCP 원시 응답이 아니라 Codex JSONL Tool 이벤트를 기록합니다.</p>
          </div>

          <div className="auth-rail" aria-label="Codex Bridge 인증 상태">
            <div className={status.codex?.authenticated ? "ready" : "waiting"}>
              <span>01</span>
              <p><strong>Codex 계정</strong><small>{status.codex?.authenticated ? "인증됨" : status.codex?.installed ? "기기 로그인 필요" : "CLI 설치 필요"}</small></p>
              <i aria-hidden="true" />
            </div>
            <div className={status.figmaMcp?.authenticated ? "ready" : "waiting"}>
              <span>02</span>
              <p><strong>Figma OAuth</strong><small>{status.figmaMcp?.authenticated ? "인증됨" : status.figmaMcp?.configured ? "승인 필요" : "MCP 설정 필요"}</small></p>
              <i aria-hidden="true" />
            </div>
          </div>

          {status.authFlow ? (
            <div className={`auth-flow ${status.authFlow.state}`} role="status">
              <div><strong>{status.authFlow.kind === "codex" ? "Codex 인증" : "Figma 인증"}</strong><span>{status.authFlow.state === "waiting" ? "대기 중" : status.authFlow.state === "complete" ? "완료" : "확인 필요"}</span></div>
              {status.authFlow.userCode ? <CopyableCode className="device-code" value={status.authFlow.userCode} label="기기 코드 복사" /> : null}
              {status.authFlow.authUrl ? <a className="auth-link" href={status.authFlow.authUrl} target="_blank" rel="noreferrer">공식 인증 화면 열기 ↗</a> : null}
              {status.authFlow.message ? <p>{status.authFlow.message}</p> : null}
            </div>
          ) : null}

          <div className="codex-auth-actions">
            {!status.codex?.authenticated ? <button className="secondary-button full" type="button" onClick={() => void startCodexFlow(onCodexLogin)} disabled={busy || status.codex?.installed === false}>Codex 기기 로그인 시작</button> : null}
            {!status.figmaMcp?.authenticated ? <button className="primary-button full figma-primary" type="button" onClick={() => void startCodexFlow(onCodexFigmaOAuth)} disabled={busy || !status.codex?.authenticated || !status.figmaMcp?.configured}>Figma OAuth 시작</button> : null}
            {status.connected ? <div className="connected-line codex-ready"><span className="status-dot success" /><strong>Codex Bridge 준비됨</strong></div> : null}
            <div className="inline-actions">
              <button className="text-button" type="button" onClick={() => void handle(() => onRefresh("codex"))} disabled={busy}>상태 다시 확인</button>
              {status.authFlow?.state === "waiting" ? <button className="text-button" type="button" onClick={() => void handle(async () => { await onCodexCancel(); await onRefresh("codex"); })} disabled={busy}>인증 취소</button> : null}
            </div>
          </div>
          <p className="credential-note">비밀번호나 토큰은 이 화면에 입력하지 않습니다. 열린 Codex/Figma 공식 화면에서 인증하면 CLI가 안전하게 보관합니다.</p>
          {status.message ? <p className="connection-detail">{status.message}</p> : null}
          {status.codex?.version ? <code className="bridge-version">{status.codex.version}</code> : null}
        </div>
      ) : transport === "plugin" ? (
        <div className="codex-connection-body plugin-connection-body">
          <div className="bridge-disclosure plugin-disclosure">
            <span>LOCAL PLUGIN BRIDGE</span>
            <p>Figma 개발 플러그인이 현재 열린 Design·FigJam 파일의 노드와 이미지만 로컬 Trace Studio로 보냅니다.</p>
          </div>
          <div className="auth-rail plugin-rail" aria-label="Figma Plugin 연결 상태">
            <div className={status.plugin?.connected ? "ready" : "waiting"}>
              <span>01</span><p><strong>Plugin</strong><small>{status.plugin?.connected ? "페어링됨" : "6자리 코드 필요"}</small></p><i aria-hidden="true" />
            </div>
            <div className={status.restOAuth?.connected ? "ready" : "waiting"}>
              <span>02</span><p><strong>파일 메타데이터</strong><small>{status.restOAuth?.connected ? "댓글·작성자·버전 연결됨" : "개인 액세스 토큰 필요"}</small></p><i aria-hidden="true" />
            </div>
          </div>
          {status.plugin?.connected ? (
            <div className="connected-card plugin-ready-card">
              <div className="connected-line"><span className="status-dot success" /><strong>Figma Plugin 준비됨</strong></div>
              <p>{status.plugin.meta?.user?.name ?? "현재 사용자"} · {status.plugin.meta?.editorType === "figjam" ? "FigJam" : "Figma Design"} · {status.plugin.meta?.pageName ?? "현재 페이지"}</p>
              {status.plugin.meta?.fileKey ? <code>{status.plugin.meta.fileKey}</code> : null}
            </div>
          ) : pairing ? (
            <div className="plugin-pair-code" role="status">
              <span>Figma 플러그인에 입력</span>
              <CopyableCode className="pair-code" value={pairing.code} label="페어링 코드 복사" />
              <p>{new Date(pairing.expiresAt).toLocaleTimeString()}까지 유효합니다. 플러그인을 열어 둔 채 입력하세요.</p>
            </div>
          ) : (
            <button className="primary-button full figma-primary" type="button" onClick={() => void createPairing()} disabled={busy}>6자리 페어링 코드 만들기</button>
          )}
          <div className="plugin-rest-actions">
            {status.restOAuth?.connected ? (
              <button className="secondary-button full" type="button" onClick={() => void handle(async () => { await onRestDisconnect(); await onRefresh("plugin"); })} disabled={busy}>메타데이터 연결 해제</button>
            ) : (
              <details className="pat-box" open>
                <summary>Figma 개인 액세스 토큰으로 연결</summary>
                <p>Figma 계정 메뉴 → Settings → Security → Personal access tokens에서 만료와 아래 scope를 지정해 발급하세요. 토큰은 생성 직후에만 보입니다.</p>
                <ul className="scope-list">
                  <li><code>current_user:read</code></li>
                  <li><code>file_content:read</code></li>
                  <li><code>file_metadata:read</code></li>
                  <li><code>file_comments:read</code></li>
                  <li><code>file_versions:read</code></li>
                </ul>
                <label className="field compact">
                  <span>Personal access token</span>
                  <input type="password" value={restPat} onChange={(event) => setRestPat(event.target.value)} autoComplete="off" placeholder="figd_…" />
                </label>
                <button
                  className="secondary-button full"
                  type="button"
                  onClick={() => void handle(async () => { await onRestPat(restPat); setRestPat(""); await onRefresh("plugin"); })}
                  disabled={!restPat || busy}
                >토큰 확인 후 연결</button>
              </details>
            )}
            <button className="text-button" type="button" onClick={() => void handle(() => onRefresh("plugin"))} disabled={busy}>연결 상태 다시 확인</button>
          </div>
          <p className="credential-note">토큰은 서버 세션 메모리에만 두며 파일이나 브라우저 저장소에 쓰지 않습니다. 파일·노드·이미지는 로컬에서 Figma API와 직접 주고받습니다.</p>
          {status.message ? <p className="connection-detail">{status.message}</p> : null}
        </div>
      ) : status.connected ? (
        <div className="connected-card figma-card">
          <div className="connected-line"><span className="status-dot success" /><strong>{transport === "desktop" ? "Figma Desktop 준비됨" : identityLabel(status.identity) ?? "Figma Remote 연결됨"}</strong></div>
          <p>{status.tools?.length ?? 0}개 MCP Tool을 확인했습니다.</p>
          <p className="small-copy">{transport === "desktop" ? "127.0.0.1:3845 · 현재 앱/선택 사용 가능" : "Remote OAuth · 링크 기반 · 베타"}</p>
          <div className="inline-actions">
            <button className="text-button" type="button" onClick={() => void handle(() => onRefresh(transport))} disabled={busy}>다시 확인</button>
            {transport === "remote" ? <button className="text-button" type="button" onClick={() => void handle(onDisconnect)} disabled={busy}>연결 해제</button> : null}
          </div>
        </div>
      ) : transport === "desktop" ? (
        <div className="connection-instructions">
          <ol><li>Figma 데스크톱 앱에서 파일을 엽니다.</li><li>Dev Mode로 전환합니다.</li><li>MCP 서버를 켠 뒤 다시 확인합니다.</li></ol>
          <button className="secondary-button full" type="button" onClick={() => void handle(() => onRefresh("desktop"))} disabled={busy}>Desktop MCP 다시 확인</button>
          {status.message ? <p className="connection-detail">{status.message}</p> : null}
        </div>
      ) : (
        <div className="connection-instructions">
          <p>Remote는 링크 기반 Tool 범위가 넓지만 Figma의 승인 클라이언트 정책에 따라 이 독립 클라이언트의 연결이 제한될 수 있습니다.</p>
          <button className="primary-button full figma-primary" type="button" onClick={() => void handle(onOAuth)} disabled={busy}>Figma Remote 연결</button>
          {status.message ? <p className="connection-detail">{status.message}</p> : null}
        </div>
      )}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
