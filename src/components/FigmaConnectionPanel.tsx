import { useState } from "react";
import type { CodexAuthFlow, CodexCliStatus, FigmaConnectionStatus, PluginPairing } from "../types";

type Props = {
  status: FigmaConnectionStatus;
  codex?: CodexCliStatus;
  onRefresh: () => Promise<void>;
  onCodexRefresh: () => Promise<void>;
  onCodexLogin: () => Promise<CodexAuthFlow>;
  onCodexCancel: () => Promise<void>;
  onPluginPair: () => Promise<PluginPairing>;
  onPluginDisconnect: () => Promise<void>;
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

export function FigmaConnectionPanel({ status, codex, onRefresh, onCodexRefresh, onCodexLogin, onCodexCancel, onPluginPair, onPluginDisconnect, onRestPat, onRestDisconnect, busy }: Props) {
  // 실패한 동작을 그대로 들고 있어야 "다시 시도"가 같은 일을 재실행할 수 있다.
  const [error, setError] = useState<{ message: string; retry?: () => Promise<void> }>();
  const [pairing, setPairing] = useState<PluginPairing>();
  const [restPat, setRestPat] = useState("");
  const handle = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError({ message: reason instanceof Error ? reason.message : String(reason), retry: action });
    }
  };
  const createPairing = () => handle(async () => { setPairing(await onPluginPair()); });
  /** 연결을 끊고 곧바로 새 코드를 띄운다. 플러그인은 다음 poll에서 페어링 화면으로 돌아간다. */
  const repairPlugin = () => handle(async () => {
    await onPluginDisconnect();
    setPairing(await onPluginPair());
    await onRefresh();
  });
  const flow = codex?.authFlow;

  return (
    <section className="panel connection-panel figma-connection" aria-labelledby="figma-connection-title">
      <div className="panel-heading">
        <span className="section-mark">A</span>
        <div><p className="eyebrow">Connection</p><h2 id="figma-connection-title">Figma 연결</h2></div>
      </div>

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
            <p>{status.plugin.meta?.user?.name ?? "현재 사용자"} · {status.plugin.meta?.editorType === "figjam" ? "FigJam" : "Figma Design"} · {status.plugin.meta?.fileName ?? "열린 파일"}</p>
            <p className="small-copy">열린 페이지: {status.plugin.meta?.pageName ?? "확인 중"}</p>
            {status.plugin.meta?.fileKey ? <code>{status.plugin.meta.fileKey}</code> : null}
            <div className="inline-actions">
              <button className="text-button" type="button" onClick={() => void repairPlugin()} disabled={busy}>연결 끊고 새 코드 발급</button>
            </div>
          </div>
        ) : pairing ? (
          <div className="plugin-pair-code" role="status">
            <span>Figma 플러그인에 입력</span>
            <CopyableCode className="pair-code" value={pairing.code} label="페어링 코드 복사" />
            <p>{new Date(pairing.expiresAt).toLocaleTimeString()}까지 유효합니다. 플러그인을 열어 둔 채 입력하세요.</p>
            <div className="pair-code-actions">
              <button type="button" onClick={() => void createPairing()} disabled={busy}>코드 다시 만들기</button>
              <button type="button" onClick={() => setPairing(undefined)} disabled={busy}>닫기</button>
            </div>
          </div>
        ) : (
          <button className="primary-button full figma-primary" type="button" onClick={() => void createPairing()} disabled={busy}>6자리 페어링 코드 만들기</button>
        )}
        <div className="plugin-rest-actions">
          {status.restOAuth?.connected ? (
            <button className="secondary-button full" type="button" onClick={() => void handle(async () => { await onRestDisconnect(); await onRefresh(); })} disabled={busy}>메타데이터 연결 해제</button>
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
                onClick={() => void handle(async () => { await onRestPat(restPat); setRestPat(""); await onRefresh(); })}
                disabled={!restPat || busy}
              >토큰 확인 후 연결</button>
            </details>
          )}
          <button className="text-button" type="button" onClick={() => void handle(onRefresh)} disabled={busy}>연결 상태 다시 확인</button>
        </div>

        {/* 추출에는 필요 없다. 노드 질문만 로컬 Codex CLI로 답을 만든다. 그래서 접어 두고 선택 단계로 표시한다. */}
        <details className="pat-box codex-question-box">
          <summary>노드 질문용 Codex 로그인 <small>(선택 · {codex ? codex.authenticated ? "준비됨" : codex.installed ? "로그인 필요" : "CLI 없음" : "확인 전"})</small></summary>
          <p>추출에는 쓰지 않습니다. 노드 질문과 제품 의미 해석만 로컬 Codex CLI가 답을 만듭니다.</p>
          {flow ? (
            <div className={`auth-flow ${flow.state}`} role="status">
              <div><strong>Codex 인증</strong><span>{flow.state === "waiting" ? "대기 중" : flow.state === "complete" ? "완료" : "확인 필요"}</span></div>
              {flow.userCode ? <CopyableCode className="device-code" value={flow.userCode} label="기기 코드 복사" /> : null}
              {flow.authUrl ? <a className="auth-link" href={flow.authUrl} target="_blank" rel="noreferrer">공식 인증 화면 열기 ↗</a> : null}
              {flow.message ? <p>{flow.message}</p> : null}
            </div>
          ) : null}
          {codex && !codex.authenticated ? (
            <button className="secondary-button full" type="button" onClick={() => void handle(async () => { await onCodexLogin(); await onCodexRefresh(); })} disabled={busy || !codex.installed}>Codex 기기 로그인 시작</button>
          ) : null}
          <div className="inline-actions">
            <button className="text-button" type="button" onClick={() => void handle(onCodexRefresh)} disabled={busy}>Codex 상태 확인</button>
            {flow?.state === "waiting" ? <button className="text-button" type="button" onClick={() => void handle(async () => { await onCodexCancel(); await onCodexRefresh(); })} disabled={busy}>인증 취소</button> : null}
          </div>
          {codex?.message ? <p className="connection-detail">{codex.message}</p> : null}
        </details>

        <p className="credential-note">토큰은 서버 세션 메모리에만 두며 파일이나 브라우저 저장소에 쓰지 않습니다. 파일·노드·이미지는 로컬에서 Figma API와 직접 주고받습니다.</p>
        {status.message ? <p className="connection-detail">{status.message}</p> : null}
      </div>
      {error ? (
        <div className="inline-error" role="alert">
          <p>{error.message}</p>
          {error.retry ? <button className="text-button" type="button" onClick={() => void handle(error.retry!)} disabled={busy}>다시 시도</button> : null}
        </div>
      ) : null}
    </section>
  );
}
