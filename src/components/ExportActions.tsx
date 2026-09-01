import { useState } from "react";
import { getRun } from "../api";

export function ExportActions({ provider, runId }: { provider: "notion" | "figma" | "slack"; runId?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "loading" | "done" | "error">("idle");
  if (!runId) return null;

  const copy = async () => {
    setCopyState("loading");
    try {
      const payload = await getRun(provider, runId);
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyState("done");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <section className="export-actions" aria-labelledby="export-actions-title">
      <div className="export-actions-copy">
        <p className="eyebrow">추출 완료</p>
        <h3 id="export-actions-title">실행 결과 내보내기</h3>
        <small>실행 후 1시간 동안, 최근 3개 실행까지 받을 수 있습니다.</small>
      </div>
      <div className="export-actions-buttons">
        <button type="button" onClick={() => void copy()} disabled={copyState === "loading"}>{copyState === "loading" ? "준비 중" : copyState === "done" ? "JSON 복사됨" : copyState === "error" ? "다시 복사" : "전체 JSON 복사"}</button>
        <a href={`/api/${provider}/runs/${encodeURIComponent(runId)}/bundle.zip`} download>ZIP 번들 받기</a>
      </div>
    </section>
  );
}
