import { useEffect, useMemo, useState } from "react";
import type { ExtractionEvent } from "../types";
import { figmaPreviewUrls } from "../lib/figma-preview-urls";

type Tab = "response" | "request" | "extracted" | "visual";

function formatBytes(bytes?: number) {
  if (typeof bytes !== "number") return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    if (typeof value === "string") return value;
    try {
      const serialized = JSON.stringify(value, null, 2);
      return typeof serialized === "string" ? serialized : "";
    } catch {
      return String(value);
    }
  }, [value]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="json-wrap">
      <button type="button" className="copy-button" onClick={() => void copy()}>{copied ? "복사됨" : "이 값 복사"}</button>
      <pre>{text || "표시할 값이 없습니다."}</pre>
    </div>
  );
}

function VisualArtifacts({ event }: { event: ExtractionEvent }) {
  // figmaPreviewUrls는 Figma 응답 형태를 전제하므로 Notion 이벤트에는 돌리지 않는다.
  const remoteUrls = event.artifacts?.length || event.provider === "notion" ? [] : figmaPreviewUrls(event.response);
  if ((!event.artifacts?.length || !event.runId) && !remoteUrls.length) {
    return <div className="visual-empty"><span aria-hidden="true">◇</span><p>이 호출에는 저장된 시각 자료가 없습니다.</p></div>;
  }
  return (
    <div className="artifact-grid">
      {event.artifacts?.map((artifact) => {
        const href = `/api/${event.provider ?? "figma"}/runs/${encodeURIComponent(event.runId!)}/artifacts/${encodeURIComponent(artifact.id)}`;
        return (
          <figure className="artifact-card" key={artifact.id}>
            {artifact.mimeType.startsWith("image/") ? <img src={href} alt={`${event.label}에서 추출한 ${artifact.kind}`} /> : <div className="artifact-file">{artifact.mimeType}</div>}
            <figcaption><span>{artifact.path}</span><b>{formatBytes(artifact.bytes)}</b></figcaption>
            <a href={href} target="_blank" rel="noreferrer">원본 열기 ↗</a>
          </figure>
        );
      })}
      {remoteUrls.map((href, index) => (
        <figure className="artifact-card" key={href}>
          <img src={href} alt={`${event.label}에서 추출한 임시 Figma 미리보기 ${index + 1}`} />
          <figcaption><span>Figma short-lived preview</span><b>임시 URL</b></figcaption>
          <a href={href} target="_blank" rel="noreferrer">원본 열기 ↗</a>
        </figure>
      ))}
    </div>
  );
}

export function DataInspector({ event }: { event?: ExtractionEvent }) {
  const [tab, setTab] = useState<Tab>("response");
  useEffect(() => setTab("response"), [event?.id]);

  if (!event) {
    return (
      <aside className="inspector empty-inspector">
        <p className="eyebrow">Raw inspector</p>
        <h2>호출을 선택하세요</h2>
        <p>실행 기록에서 한 단계를 누르면 MCP 또는 Codex 중계 이벤트의 입력과 반환값을 볼 수 있습니다.</p>
      </aside>
    );
  }

  const value = tab === "response" ? event.response ?? event.message : tab === "request" ? event.request : event.extracted ?? event.message;
  const visualCount = (event.artifacts?.length ?? 0) || figmaPreviewUrls(event.response).length;
  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <div className="inspector-head">
        <div>
          <p className="eyebrow">{event.origin === "codex" ? "Codex event" : "Raw response"} · {String(event.order).padStart(2, "0")}</p>
          <h2 id="inspector-title">{event.label}</h2>
        </div>
        <span className={`state-label ${event.state}`}>{event.state}</span>
      </div>
      <div className="tabs" role="tablist" aria-label="응답 보기 방식">
        {(["response", "request", "extracted", "visual"] as const).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>
            {name === "response" ? event.origin === "codex" ? "중계 응답" : "원시 응답" : name === "request" ? event.origin === "codex" ? "Tool 입력" : "MCP 입력" : name === "extracted" ? "추출 메타" : `시각 자료${visualCount ? ` ${visualCount}` : ""}`}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="inspector-content">
        {tab === "visual" ? <VisualArtifacts event={event} /> : <JsonBlock value={value} />}
      </div>
      <dl className="call-facts">
        <div><dt>도구</dt><dd>{event.tool ? `${event.origin === "codex" ? "Codex · " : ""}${event.tool}` : "내부 처리"}</dd></div>
        <div><dt>시작</dt><dd>{new Date(event.startedAt).toLocaleTimeString("ko-KR")}</dd></div>
        <div><dt>소요</dt><dd>{typeof event.elapsedMs === "number" ? `${event.elapsedMs}ms` : "—"}</dd></div>
        <div><dt>응답</dt><dd>{formatBytes(event.responseBytes)}</dd></div>
      </dl>
    </aside>
  );
}
